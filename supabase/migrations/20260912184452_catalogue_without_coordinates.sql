-- Missing coordinates are a publication reserve; map consumers filter coordinates separately.
begin;

-- Append classification without changing existing columns, RLS or premium redactions.
create or replace view public.v_auction_sales_app
with (security_invoker = true)
as
select
  s.id,
  s.title,
  s.city,
  s.department,
  s.postal_code,
  s.address,
  s.tribunal,
  s.tribunal_code,
  t.canonical_name as tribunal_name,
  t.city as tribunal_city,
  s.property_type,
  s.starting_price_eur,
  s.sale_date,
  s.latitude,
  s.longitude,
  s.occupancy_status,
  s.surface_m2,
  s.habitable_surface_m2,
  s.carrez_surface_m2,
  s.land_surface_m2,
  s.app_surface_m2,
  s.app_surface_kind,
  s.surface_scope,
  s.surface_source,
  s.surface_confidence,
  s.surface_evidence,
  s.rooms_count,
  s.bedrooms_count,
  s.bathrooms_count,
  s.parking_count,
  s.has_garden,
  s.has_terrace,
  s.has_garage,
  s.has_pool,
  s.has_air_conditioning,
  s.has_double_glazing,
  s.investment_score,
  s.investment_summary,
  s.score_version,
  s.score_confidence,
  coalesce(sf.score_factors, nullif(s.score_factors, '[]'::jsonb), '[]'::jsonb) as score_factors,
  s.risk_notes,
  coalesce(r.risks, '[]'::jsonb) as risks,
  s.source_name,
  s.primary_source,
  s.source_url,
  s.source_urls,
  s.dedupe_confidence,
  s.documents,
  coalesce(d.documents_rich, '[]'::jsonb) as documents_rich,
  s.status,
  s.quality_flags,
  s.created_at,
  s.updated_at,
  coalesce(m.media, '[]'::jsonb) as media,
  s.raw_payload->'source_blocks' as source_blocks,
  s.description,
  nullif(s.raw_payload->>'source_description', '') as source_description,
  nullif(s.raw_payload->>'llm_display_description', '') as llm_display_description,
  nullif(s.raw_payload->>'llm_display_description', '') as about_description,
  s.visit_dates,
  s.lawyer_name,
  s.lawyer_contact,
  s.adjudication_price_eur,
  coalesce(sb.source_blocks_by_source, '{}'::jsonb) as source_blocks_by_source,
  s.sale_venue_type,
  s.sale_legal_framework,
  s.sale_verification_status,
  s.sale_procedure,
  coalesce(s.raw_payload->'source_checks','{}'::jsonb) as source_checks,
  coalesce(s.raw_payload->'source_conflicts','[]'::jsonb) as source_conflicts,
  case when s.raw_payload->>'source_content_changed'='true' then 'pending'
    when nullif(s.raw_payload->>'llm_display_description','') is not null then 'complete'
    else coalesce(s.raw_payload->>'llm_display_status','pending') end as analysis_status,
  coalesce(s.raw_payload->'source_presence','{}'::jsonb) as source_presence
from public.auction_sales s
left join public.tribunals t on t.code = s.tribunal_code
left join lateral (
  select jsonb_object_agg(source_key, source_blocks) as source_blocks_by_source
  from (
    select
      coalesce(nullif(s.source_name, ''), 'source') || ':primary' as source_key,
      s.raw_payload->'source_blocks' as source_blocks
    where jsonb_typeof(s.raw_payload->'source_blocks') = 'object'
    union all
    select
      coalesce(nullif(observation.value->>'source_name', ''), 'source') || ':' || observation.ordinality::text as source_key,
      observation.value->'raw_payload'->'source_blocks' as source_blocks
    from jsonb_array_elements(
      case
        when jsonb_typeof(s.observations) = 'array'
          then s.observations
        else '[]'::jsonb
      end
    ) with ordinality as observation(value, ordinality)
    where jsonb_typeof(observation.value->'raw_payload'->'source_blocks') = 'object'
  ) blocks
) sb on true
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'risk_type', ar.risk_type,
      'risk_label', ar.risk_label,
      'severity', ar.severity,
      'evidence', ar.evidence,
      'evidence_json', ar.evidence_json,
      'confidence', ar.confidence,
      'detector', ar.detector,
      'detector_version', ar.detector_version,
      'score_impact', ar.score_impact,
      'updated_at', ar.updated_at,
      'occurrences', coalesce(ro.occurrences, '[]'::jsonb)
    )
    order by ar.severity desc nulls last, ar.risk_label
  ) as risks
  from public.auction_risks ar
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'document_url', aro.document_url,
        'document_label', aro.document_label,
        'document_type', aro.document_type,
        'page_number', aro.page_number,
        'excerpt', aro.excerpt,
        'confidence', aro.confidence,
        'detector', aro.detector,
        'detector_version', aro.detector_version,
        'matched_terms', aro.matched_terms,
        'score_impact', aro.score_impact,
        'updated_at', aro.updated_at
      )
      order by aro.confidence desc nulls last, aro.page_number nulls last
    ) as occurrences
    from public.auction_risk_occurrences aro
    where aro.source_url = ar.source_url
      and aro.risk_label = ar.risk_label
      and aro.is_negated = false
  ) ro on true
  where ar.source_url = s.source_url
) r on true
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'factor_order', asf.factor_order,
      'factor_key', asf.factor_key,
      'label', asf.label,
      'reason', asf.reason,
      'delta', asf.delta,
      'weight', asf.weight,
      'raw_value', asf.raw_value,
      'normalized_value', asf.normalized_value,
      'confidence', asf.confidence,
      'evidence', asf.evidence,
      'evidence_refs', asf.evidence_refs
    )
    order by asf.factor_order, asf.factor_key
  ) as score_factors
  from public.auction_score_factors asf
  where asf.source_url = s.source_url
) sf on true
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'label', ad.label,
      'url', ad.document_url,
      'type', ad.document_type,
      'document_type', ad.document_type,
      'download_status', ad.download_status,
      'extraction_status', ad.extraction_status,
      'docling_status', ad.docling_status,
      'text_chars', ad.text_chars,
      'updated_at', ad.updated_at
    )
    order by ad.document_type, ad.label
  ) as documents_rich
  from public.auction_documents ad
  where ad.source_url = s.source_url
) d on true
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'type', 'image',
      'url', image_url,
      'source', image_source
    )
    order by source_rank, image_url
  ) as media
  from (
    select distinct on (image_url)
      image_url,
      image_source,
      source_rank
    from (
      select
        nullif(s.raw_payload->>'raw_image_url', '') as image_url,
        s.source_name as image_source,
        0 as source_rank
      union all
      select
        nullif(source_image.value, '') as image_url,
        s.source_name as image_source,
        1 as source_rank
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(s.raw_payload->'source_images') = 'array'
            then s.raw_payload->'source_images'
          else '[]'::jsonb
        end
      ) as source_image(value)
      union all
      select
        nullif(observation.value->'raw_payload'->>'raw_image_url', '') as image_url,
        coalesce(observation.value->>'source_name', s.source_name) as image_source,
        2 as source_rank
      from jsonb_array_elements(
        case
          when jsonb_typeof(s.observations) = 'array'
            then s.observations
          else '[]'::jsonb
        end
      ) as observation(value)
      union all
      select
        nullif(observation_image.value, '') as image_url,
        coalesce(observation.value->>'source_name', s.source_name) as image_source,
        3 as source_rank
      from jsonb_array_elements(
        case
          when jsonb_typeof(s.observations) = 'array'
            then s.observations
          else '[]'::jsonb
        end
      ) as observation(value)
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(observation.value->'raw_payload'->'source_images') = 'array'
            then observation.value->'raw_payload'->'source_images'
          else '[]'::jsonb
        end
      ) as observation_image(value)
    ) source_media
    where image_url is not null
      and image_url ~* '^https?://'
      and image_url !~* '\.(pdf|docx?|svg)([?#].*)?$'
      and image_url !~* '(^|[/_.-])(avatar|brand|default|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)'
    order by image_url, source_rank
  ) deduped_media
) m on true
where s.status in ('upcoming', 'unknown', 'postponed')
  and coalesce(s.raw_payload->>'publication_quarantine','') = '';

revoke all on table public.v_auction_sales_app from public, anon;
grant select on table public.v_auction_sales_app to authenticated;

-- This deliberately restricted Discovery view retains its existing security barrier.
create or replace view public.v_auction_sales_discovery
with (security_invoker = false, security_barrier = true)
as
select
  s.id,
  s.title,
  null::text as description,
  null::text as source_description,
  null::text as llm_display_description,
  null::text as about_description,
  s.city,
  s.department,
  s.postal_code,
  s.address,
  s.tribunal,
  s.tribunal_code,
  t.canonical_name as tribunal_name,
  t.city as tribunal_city,
  s.property_type,
  s.starting_price_eur,
  s.sale_date,
  s.visit_dates,
  null::text as lawyer_name,
  null::text as lawyer_contact,
  null::numeric as adjudication_price_eur,
  s.latitude,
  s.longitude,
  null::text as occupancy_status,
  s.surface_m2,
  s.habitable_surface_m2,
  s.carrez_surface_m2,
  s.land_surface_m2,
  s.app_surface_m2,
  s.app_surface_kind,
  s.surface_scope,
  s.surface_source,
  null::double precision as surface_confidence,
  null::text as surface_evidence,
  s.rooms_count,
  s.bedrooms_count,
  s.bathrooms_count,
  s.parking_count,
  s.has_garden,
  s.has_terrace,
  s.has_garage,
  s.has_pool,
  s.has_air_conditioning,
  s.has_double_glazing,
  null::double precision as investment_score,
  null::text as investment_summary,
  null::text as score_version,
  null::double precision as score_confidence,
  '[]'::jsonb as score_factors,
  null::text as risk_notes,
  '[]'::jsonb as risks,
  null::text as source_name,
  null::text as primary_source,
  null::text as source_url,
  '[]'::jsonb as source_urls,
  null::text as dedupe_confidence,
  '[]'::jsonb as documents,
  '[]'::jsonb as documents_rich,
  s.status,
  '[]'::jsonb as quality_flags,
  s.created_at,
  s.updated_at,
  case
    when nullif(s.raw_payload->>'raw_image_url', '') ~* '^https?://'
      then jsonb_build_array(jsonb_build_object(
        'type', 'image',
        'url', nullif(s.raw_payload->>'raw_image_url', '')
      ))
    else '[]'::jsonb
  end as media,
  jsonb_build_object('sale_procedure', s.sale_procedure) as source_blocks,
  '{}'::jsonb as source_blocks_by_source,
  s.sale_venue_type,
  s.sale_legal_framework,
  s.sale_verification_status,
  s.sale_procedure,
  coalesce(s.raw_payload->'source_checks','{}'::jsonb) as source_checks,
  coalesce(s.raw_payload->'source_conflicts','[]'::jsonb) as source_conflicts,
  case when s.raw_payload->>'source_content_changed'='true' then 'pending'
    when nullif(s.raw_payload->>'llm_display_description','') is not null then 'complete'
    else coalesce(s.raw_payload->>'llm_display_status','pending') end as analysis_status,
  coalesce(s.raw_payload->'source_presence','{}'::jsonb) as source_presence
from public.auction_sales s
left join public.tribunals t on t.code = s.tribunal_code
where s.status in ('upcoming', 'unknown', 'postponed')
  and coalesce(s.raw_payload->>'publication_quarantine','') = '';

revoke all on table public.v_auction_sales_discovery from public, anon;
grant select on table public.v_auction_sales_discovery to authenticated;


-- Keep anonymous discovery consistent with admitted catalogue rows.
CREATE OR REPLACE FUNCTION app_private.search_auction_sales_preview_v4(p_departments text[] DEFAULT NULL::text[], p_city text DEFAULT NULL::text, p_postal_code text DEFAULT NULL::text, p_tribunal text DEFAULT NULL::text, p_keywords text[] DEFAULT NULL::text[], p_property_types text[] DEFAULT NULL::text[], p_min_price numeric DEFAULT NULL::numeric, p_max_price numeric DEFAULT NULL::numeric, p_min_surface numeric DEFAULT NULL::numeric, p_max_surface numeric DEFAULT NULL::numeric, p_min_bedrooms integer DEFAULT NULL::integer, p_min_bathrooms integer DEFAULT NULL::integer, p_occupancy_status text DEFAULT NULL::text, p_min_score numeric DEFAULT NULL::numeric, p_statuses text[] DEFAULT NULL::text[], p_north double precision DEFAULT NULL::double precision, p_south double precision DEFAULT NULL::double precision, p_east double precision DEFAULT NULL::double precision, p_west double precision DEFAULT NULL::double precision, p_sort text DEFAULT 'score_desc'::text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0, p_sale_venue_type text DEFAULT NULL::text, p_min_sale_date date DEFAULT NULL::date, p_max_sale_date date DEFAULT NULL::date)
 RETURNS TABLE(id uuid, starting_price_eur numeric, total_count bigint, sale_venue_type text, sale_verification_status text, city text, department text, property_type text, sale_date timestamp with time zone, app_surface_m2 numeric, app_surface_kind text, rooms_count integer, bedrooms_count integer, bathrooms_count integer, latitude double precision, longitude double precision, thumbnail_url text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  if p_min_sale_date > p_max_sale_date then
    raise exception using errcode = '22023', message = 'Invalid sale date range.';
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
    where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
      and coalesce(s.raw_payload->>'publication_quarantine', '') = ''
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
      and (p_min_sale_date is null or s.sale_date >= (p_min_sale_date::timestamp at time zone 'Europe/Paris'))
      and (p_max_sale_date is null or s.sale_date < ((p_max_sale_date + 1)::timestamp at time zone 'Europe/Paris'))
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
$function$;


commit;
