-- Public discovery contract v3. V1/V2 remain unchanged for existing clients.
-- Only listing facts are public: no address, original title/description, contact,
-- documents, source payload, risk, score, DPE or adjudication price.
-- Coordinates are rounded to ~1 km BEFORE leaving the database. Viewport and
-- protected filters are rejected inside the private definer, including direct calls.
-- The private definer intentionally projects these approved fields from the
-- restricted catalogue; no base-table or discovery-view privileges are widened.
-- Listings without coordinates remain discoverable in the list.
begin;

create or replace function app_private.search_auction_sales_preview_v3(
  p_departments text[] default null,
  p_city text default null,
  p_postal_code text default null,
  p_tribunal text default null,
  p_keywords text[] default null,
  p_property_types text[] default null,
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_min_surface numeric default null,
  p_max_surface numeric default null,
  p_min_bedrooms integer default null,
  p_min_bathrooms integer default null,
  p_occupancy_status text default null,
  p_min_score numeric default null,
  p_statuses text[] default null,
  p_north double precision default null,
  p_south double precision default null,
  p_east double precision default null,
  p_west double precision default null,
  p_sort text default 'score_desc',
  p_limit integer default 24,
  p_offset integer default 0,
  p_sale_venue_type text default null
)
returns table (
  id uuid,
  starting_price_eur numeric,
  total_count bigint,
  sale_venue_type text,
  sale_verification_status text,
  city text,
  department text,
  property_type text,
  sale_date timestamptz,
  app_surface_m2 numeric,
  app_surface_kind text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  latitude double precision,
  longitude double precision,
  thumbnail_url text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_departments), 0) > 220
    or coalesce(cardinality(p_keywords), 0) > 5
    or coalesce(cardinality(p_property_types), 0) > 8
    or coalesce(cardinality(p_statuses), 0) > 4
    or coalesce((select max(length(item.value)) from unnest(p_departments) as item(value)), 0) > 80
    or coalesce((select max(length(item.value)) from unnest(p_keywords) as item(value)), 0) > 80
    or coalesce((select max(length(item.value)) from unnest(p_property_types) as item(value)), 0) > 80
    or coalesce((select max(length(item.value)) from unnest(p_statuses) as item(value)), 0) > 40
    or length(coalesce(p_city, '')) > 120
    or length(coalesce(p_postal_code, '')) > 16
    or length(coalesce(p_tribunal, '')) > 160
    or length(coalesce(p_sort, '')) > 32
    or coalesce(p_limit, 24) < 1
    or coalesce(p_limit, 24) > 100
    or coalesce(p_offset, 0) < 0
    or coalesce(p_offset, 0) > 10000 then
    raise exception using errcode = '22023', message = 'Invalid or oversized preview search parameters.';
  end if;

  if (
    p_occupancy_status is not null
    or p_min_score is not null
    or p_north is not null
    or p_south is not null
    or p_east is not null
    or p_west is not null
  ) then
    raise exception using errcode = '42501', message = 'Protected filters are not available in the public preview.';
  end if;

  if p_sale_venue_type is not null and p_sale_venue_type not in ('tribunal', 'notary', 'state', 'unknown') then
    raise exception using errcode = '22023', message = 'Invalid sale type.';
  end if;

  return query
  with filtered as (
    select
      s.id,
      s.starting_price_eur,
      s.sale_date,
      s.app_surface_m2,
      s.sale_venue_type,
      s.sale_verification_status,
      s.city,
      s.department,
      s.property_type,
      s.app_surface_kind,
      s.rooms_count,
      s.bedrooms_count,
      s.bathrooms_count,
      round(s.latitude::numeric, 2)::double precision as latitude,
      round(s.longitude::numeric, 2)::double precision as longitude,
      case when s.raw_payload->>'raw_image_url' ~* '^https?://'
        and length(s.raw_payload->>'raw_image_url') <= 2048
        then s.raw_payload->>'raw_image_url' end as thumbnail_url
    from public.auction_sales s
    left join public.tribunals t on t.code = s.tribunal_code
    where coalesce(s.status, 'unknown') in ('upcoming', 'unknown')
      and (
        p_sale_venue_type is null
        or s.sale_venue_type = p_sale_venue_type
        or (p_sale_venue_type = 'unknown' and s.sale_venue_type = 'online')
      )
      and (
        p_departments is null
        or extensions.unaccent(lower(coalesce(s.department, ''))) = any (
          select extensions.unaccent(lower(department.value))
          from unnest(p_departments) as department(value)
        )
      )
      and (
        p_city is null
        or extensions.unaccent(lower(coalesce(s.city, '')))
          like '%' || extensions.unaccent(lower(p_city)) || '%'
      )
      and (p_postal_code is null or s.postal_code = p_postal_code)
      and (
        p_tribunal is null
        or extensions.unaccent(lower(concat_ws(
          ' ',
          s.tribunal,
          s.tribunal_code,
          t.canonical_name,
          t.city
        ))) like '%' || extensions.unaccent(lower(p_tribunal)) || '%'
      )
      and (
        p_keywords is null
        or not exists (
          select 1
          from unnest(p_keywords) as keyword(value)
          where position(
            extensions.unaccent(lower(keyword.value))
            in extensions.unaccent(lower(concat_ws(
              ' ',
              s.city,
              s.department,
              s.postal_code,
              s.tribunal,
              s.tribunal_code,
              t.canonical_name,
              t.city
            )))
          ) = 0
        )
      )
      and (p_property_types is null or s.property_type = any (p_property_types))
      and (p_min_price is null or s.starting_price_eur >= p_min_price)
      and (p_max_price is null or s.starting_price_eur <= p_max_price)
      and (p_min_surface is null or s.app_surface_m2 >= p_min_surface)
      and (p_max_surface is null or s.app_surface_m2 <= p_max_surface)
      and (p_min_bedrooms is null or s.bedrooms_count >= p_min_bedrooms)
      and (p_min_bathrooms is null or s.bathrooms_count >= p_min_bathrooms)
      and (p_occupancy_status is null or s.occupancy_status = p_occupancy_status)
      and (p_min_score is null or s.investment_score >= p_min_score)
      and (p_statuses is null or s.status = any (p_statuses))
      and (p_north is null or s.latitude <= p_north)
      and (p_south is null or s.latitude >= p_south)
      and (p_east is null or s.longitude <= p_east)
      and (p_west is null or s.longitude >= p_west)
  ),
  counted as (
    select
      filtered.*,
      count(*) over () as total_count
    from filtered
  )
  select
    counted.id,
    counted.starting_price_eur,
    counted.total_count,
    counted.sale_venue_type,
    counted.sale_verification_status,
    counted.city,
    counted.department,
    counted.property_type,
    counted.sale_date::timestamptz,
    counted.app_surface_m2::numeric,
    counted.app_surface_kind,
    counted.rooms_count,
    counted.bedrooms_count,
    counted.bathrooms_count,
    counted.latitude,
    counted.longitude,
    counted.thumbnail_url
  from counted
  order by
    case when p_sort = 'date_asc' then counted.sale_date end asc nulls last,
    case when p_sort = 'date_desc' then counted.sale_date end desc nulls last,
    case when p_sort = 'price_asc' then counted.starting_price_eur end asc nulls last,
    case when p_sort = 'price_desc' then counted.starting_price_eur end desc nulls last,
    case when p_sort = 'surface_desc' then counted.app_surface_m2 end desc nulls last,
    case when p_sort not in ('date_asc', 'date_desc', 'price_asc', 'price_desc', 'surface_desc')
      then counted.sale_date end asc nulls last,
    counted.id
  limit least(greatest(coalesce(p_limit, 24), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function app_private.search_auction_sales_preview_v3 from public, anon, authenticated;
grant usage on schema app_private to anon, authenticated, service_role;
grant execute on function app_private.search_auction_sales_preview_v3
to anon, authenticated, service_role;

create or replace function public.search_auction_sales_preview_v3(
  p_departments text[] default null,
  p_city text default null,
  p_postal_code text default null,
  p_tribunal text default null,
  p_keywords text[] default null,
  p_property_types text[] default null,
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_min_surface numeric default null,
  p_max_surface numeric default null,
  p_min_bedrooms integer default null,
  p_min_bathrooms integer default null,
  p_occupancy_status text default null,
  p_min_score numeric default null,
  p_statuses text[] default null,
  p_north double precision default null,
  p_south double precision default null,
  p_east double precision default null,
  p_west double precision default null,
  p_sort text default 'score_desc',
  p_limit integer default 24,
  p_offset integer default 0,
  p_sale_venue_type text default null
)
returns table (
  id uuid,
  starting_price_eur numeric,
  total_count bigint,
  sale_venue_type text,
  sale_verification_status text,
  city text,
  department text,
  property_type text,
  sale_date timestamptz,
  app_surface_m2 numeric,
  app_surface_kind text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  latitude double precision,
  longitude double precision,
  thumbnail_url text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from app_private.search_auction_sales_preview_v3(
    p_departments => p_departments,
    p_city => p_city,
    p_postal_code => p_postal_code,
    p_tribunal => p_tribunal,
    p_keywords => p_keywords,
    p_property_types => p_property_types,
    p_min_price => p_min_price,
    p_max_price => p_max_price,
    p_min_surface => p_min_surface,
    p_max_surface => p_max_surface,
    p_min_bedrooms => p_min_bedrooms,
    p_min_bathrooms => p_min_bathrooms,
    p_occupancy_status => p_occupancy_status,
    p_min_score => p_min_score,
    p_statuses => p_statuses,
    p_north => p_north,
    p_south => p_south,
    p_east => p_east,
    p_west => p_west,
    p_sort => p_sort,
    p_limit => p_limit,
    p_offset => p_offset,
    p_sale_venue_type => p_sale_venue_type
  );
$$;

revoke all on function public.search_auction_sales_preview_v3 from public;
grant execute on function public.search_auction_sales_preview_v3 to anon, authenticated, service_role;


notify pgrst, 'reload schema';

commit;
