-- Public catalogue contract: exercise the real functions as anon. Roll back fixtures.
begin;

select plan(12);

insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, investment_score, lawyer_contact, raw_payload
)
select
  ('c2400000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'public-discovery-regression', 'https://example.test/catalogue/' || i,
  'PrivateTitleC240', 'PrivateAddressC240', 'DiscoveryRegressionC240', '33', 'apartment',
  50000 + i * 1000, now() + interval '30 days', 50 + i * 10, 'habitable',
  2, 1, 1, case when i = 5 then 'past' else 'upcoming' end,
  case when i = 3 then null else 44.837812 end, -0.579234,
  case when i in (2,3) then 'notary' else 'tribunal' end,
  'pending', 85, 'PrivateContactC240',
  jsonb_build_object('raw_image_url', 'https://example.test/photo.jpg', 'private', 'never-return')
from generate_series(1, 5) i;

set local role anon;

select is(
  (select count(*) from public.search_auction_sales_preview_v3(p_city => 'DiscoveryRegressionC240')),
  4::bigint,
  'public discovery includes unlocated listings, but not past listings'
);

select results_eq(
  $$select id, total_count, city, app_surface_m2, latitude
    from public.search_auction_sales_preview_v3(
      p_city => 'DiscoveryRegressionC240', p_sale_venue_type => 'notary',
      p_sort => 'price_asc', p_limit => 1, p_offset => 1
    )$$,
  $$select 'c2400000-0000-4000-8000-000000000003'::uuid, 2::bigint,
    'DiscoveryRegressionC240'::text, 80::numeric, null::double precision$$,
  'public facts, filtered count and pagination agree'
);

select is(
  (select array_agg(key order by key) from jsonb_object_keys(
    (select to_jsonb(result) from public.search_auction_sales_preview_v3(
      p_city => 'DiscoveryRegressionC240', p_limit => 1
    ) result)
  ) key),
  (select array_agg(key order by key) from unnest(array[
    'id','starting_price_eur','total_count','sale_venue_type','sale_verification_status',
    'city','department','property_type','sale_date','app_surface_m2','app_surface_kind',
    'rooms_count','bedrooms_count','bathrooms_count','latitude','longitude','thumbnail_url'
  ]) key),
  'the RPC returns exactly the approved public fields'
);

select results_eq(
  $$select latitude, longitude, thumbnail_url from public.search_auction_sales_preview_v3(
    p_city => 'DiscoveryRegressionC240', p_sort => 'price_asc', p_limit => 1
  )$$,
  $$select 44.84::double precision, (-0.58)::double precision, 'https://example.test/photo.jpg'::text$$,
  'coordinates are rounded in SQL and the thumbnail is isolated from raw payload'
);

select is(
  (select count(*) from public.search_auction_sales_preview_v3(p_city => 'DiscoveryRegressionC240', p_min_surface => 75)),
  2::bigint,
  'public surface filters apply before count and pagination'
);
select is(
  (select count(*) from public.search_auction_sales_preview_v3(p_city => 'DiscoveryRegressionC240', p_keywords => array['PrivateAddressC240'])),
  0::bigint,
  'keyword search does not reveal private addresses'
);
select is(
  (select count(*) from public.search_auction_sales_preview_v3(p_city => 'DiscoveryRegressionC240', p_keywords => array['PrivateTitleC240'])),
  0::bigint,
  'keyword search does not reveal private titles'
);

select throws_ok(
  $$select public.search_auction_sales_preview_v3(p_min_score => 70)$$,
  '42501', 'Protected filters are not available in the public preview.',
  'protected analysis filters are rejected'
);
select throws_ok(
  $$select app_private.search_auction_sales_preview_v3(p_north => 45)$$,
  '42501', 'Protected filters are not available in the public preview.',
  'the private definer rejects precise location filters'
);
select throws_ok(
  $$select app_private.search_auction_sales_preview_v3(p_limit => 101)$$,
  '22023', 'Invalid or oversized preview search parameters.',
  'the private definer enforces request bounds'
);
select throws_ok(
  $$select public.search_auction_sales_preview_v3(p_sale_venue_type => 'online')$$,
  '22023', 'Invalid sale type.',
  'invalid sale families are rejected'
);
select ok(
  not has_column_privilege('anon', 'public.auction_sales', 'lawyer_contact', 'select'),
  'underlying protected columns remain inaccessible'
);

reset role;
select * from finish();
rollback;
