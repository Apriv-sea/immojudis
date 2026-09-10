-- Run after the sale-type migration. All fixtures are rolled back.
begin;

select plan(1);

insert into public.auction_sales (
  id, source_name, source_url, city, department, starting_price_eur,
  status, latitude, longitude, sale_venue_type, sale_legal_framework,
  sale_verification_status, raw_payload
)
select
  ('c2300000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'sale-type-regression', 'https://example.test/sale-type-regression/' || i,
  'SaleTypeRegressionC230', 'Gironde', 50000 + i * 1000,
  case when i = 6 then 'past' else 'upcoming' end,
  case when i = 7 then null else 44.8 end, -0.6,
  case when i = 1 then 'tribunal' when i in (2,3,6,7) then 'notary' when i = 4 then 'unknown' else 'online' end,
  case when i = 3 then 'judicial_partition' when i = 2 then 'voluntary_notarial' else 'unknown' end,
  'pending', '{}'::jsonb
from generate_series(1, 7) i;

set local role anon;

do $$
declare
  result record;
  actual_count integer;
begin
  select count(*) into actual_count from public.search_auction_sales_preview_v2(p_city => 'SaleTypeRegressionC230');
  if actual_count <> 5 then raise exception 'Catalogue must exclude past and ungeocoded rows'; end if;

  select * into result from public.search_auction_sales_preview_v2(
    p_city => 'SaleTypeRegressionC230', p_sale_venue_type => 'notary', p_sort => 'price_asc', p_limit => 1, p_offset => 1
  );
  if result.id is distinct from 'c2300000-0000-4000-8000-000000000003'::uuid
    or result.total_count is distinct from 2::bigint
    or result.sale_venue_type is distinct from 'notary' then
    raise exception 'Family filtering and total count must precede pagination, regardless of legal framework';
  end if;
  if to_jsonb(result) - array['id','starting_price_eur','total_count','sale_venue_type','sale_verification_status'] <> '{}'::jsonb then
    raise exception 'The public RPC must not disclose any additional fields';
  end if;

  select count(*) into actual_count from public.search_auction_sales_preview_v2(p_city => 'SaleTypeRegressionC230', p_sale_venue_type => 'unknown');
  if actual_count <> 2 then raise exception 'Legacy online entries must be grouped with unclassified organizers'; end if;

  select count(*) into actual_count from public.search_auction_sales_preview_v2(p_city => 'SaleTypeRegressionC230', p_sale_venue_type => 'tribunal');
  if actual_count <> 1 then raise exception 'Tribunal filter must not include notarial sales'; end if;

  select count(*) into actual_count from public.search_auction_sales_preview_v2(p_city => 'SaleTypeRegressionC230', p_sale_venue_type => 'state');
  if actual_count <> 0 then raise exception 'An empty family must stay empty'; end if;

  select count(*) into actual_count from public.search_auction_sales_preview_v2(p_city => 'SaleTypeRegressionC230', p_sale_venue_type => 'notary', p_max_price => 52000);
  if actual_count <> 1 then raise exception 'Family and budget filters must combine'; end if;

  begin
    perform public.search_auction_sales_preview_v2(p_min_score => 50);
    raise exception 'Protected attributes must not be searchable through the teaser RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    perform app_private.search_auction_sales_preview_v2(p_north => 50);
    raise exception 'Direct private calls must enforce the same protection';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.search_auction_sales_preview_v2(p_sale_venue_type => 'online');
    raise exception 'Unsupported family must be rejected';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform app_private.search_auction_sales_preview_v2(p_limit => 101);
    raise exception 'Direct private calls must enforce pagination bounds';
  exception when invalid_parameter_value then null;
  end;
  if has_column_privilege('anon', 'public.auction_sales', 'lawyer_contact', 'select')
    or has_table_privilege('anon', 'public.v_auction_sales_discovery', 'select') then
    raise exception 'Anonymous table privileges must remain restricted';
  end if;
end;
$$;

set local role authenticated;
do $$
begin
  if not exists (
    select 1 from public.v_auction_sales_discovery
    where id = 'c2300000-0000-4000-8000-000000000003'
      and sale_venue_type = 'notary' and sale_legal_framework = 'judicial_partition'
      and lawyer_contact is null and investment_score is null
  ) then raise exception 'Discovery must expose classification while preserving premium redactions'; end if;
end;
$$;

reset role;
do $$
begin
  if not exists (
    select 1 from pg_class where oid = 'public.v_auction_sales_app'::regclass and 'security_invoker=true' = any(reloptions)
  ) then raise exception 'Analysis view must retain RLS through security_invoker'; end if;
end;
$$;

select pass('sale family filters, pagination and access boundaries all hold');
select * from finish();

rollback;
