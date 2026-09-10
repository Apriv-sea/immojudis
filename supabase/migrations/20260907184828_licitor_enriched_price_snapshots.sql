-- Additive enrichment: old immutable builds retain NULL enrichment.
alter table public.adjudication_price_statistics_snapshots
  add column extra_statistics jsonb;
create view licitor_ingestion.diagnostic_price_enrichments
with (security_invoker=true) as
with parsed as (
  select
    coalesce(nullif(candidate.payload->>'property_type', ''), 'unknown') as property_type,
    nullif(pg_catalog.btrim(candidate.payload->>'tribunal'), '') as raw_tribunal_label,
    case when pg_catalog.pg_input_is_valid(candidate.payload->>'starting_price_eur', 'numeric')
      then (candidate.payload->>'starting_price_eur')::numeric end as starting_price_eur,
    case when pg_catalog.pg_input_is_valid(candidate.payload->>'adjudication_price_eur', 'numeric')
      then (candidate.payload->>'adjudication_price_eur')::numeric end as hammer_price_eur,
    coalesce(candidate.payload->>'sale_venue_type', 'tribunal') as sale_venue_type,
    coalesce(candidate.payload->'quality_flags', '[]'::jsonb) as quality_flags
  from licitor_ingestion.active_candidates candidate
), eligible as (
  select parsed.*
  from parsed
  where parsed.sale_venue_type = 'tribunal'
    and not (parsed.quality_flags ?| array[
      'index_detail_date_conflict',
      'conflicting_announcement_alias_capture',
      'cached_reparse_failed',
      'source_result_changed_pending_review',
      'lot_missing_in_latest_capture'
    ])
    and parsed.starting_price_eur > 1000
    and parsed.hammer_price_eur > 0
), scoped as (
  select
    'national'::text as scope_type,
    null::uuid as court_id,
    null::text as court_code,
    'France entière'::text as scope_label,
    null::text as judicial_region,
    eligible.property_type,
    eligible.starting_price_eur,
    eligible.hammer_price_eur
  from eligible
  union all
  select
    'tribunal'::text,
    mapping.court_id,
    mapping.court_code,
    mapping.court_name,
    mapping.judicial_region,
    eligible.property_type,
    eligible.starting_price_eur,
    eligible.hammer_price_eur
  from eligible
  join licitor_ingestion.diagnostic_court_mappings mapping
    on mapping.raw_tribunal_label = eligible.raw_tribunal_label
   and mapping.mapping_status = 'unique_official_name_contained'
), grouped as (
  select scope_type, court_id, property_type, grouping(property_type) as all_types,
    count(*) as n,
    jsonb_build_object(
      'sampleSize', count(*),
      'hammerPriceMiddle50Eur', jsonb_build_object(
        'p25', percentile_cont(0.25) within group(order by hammer_price_eur),
        'p75', percentile_cont(0.75) within group(order by hammer_price_eur)),
      'ratioMiddle50', jsonb_build_object(
        'p25', percentile_cont(0.25) within group(order by hammer_price_eur/starting_price_eur),
        'p75', percentile_cont(0.75) within group(order by hammer_price_eur/starting_price_eur)),
      'bidDistribution', jsonb_build_array(jsonb_build_object('band','below_starting', 'count',count(*) filter(where hammer_price_eur < starting_price_eur), 'share',round((count(*) filter(where hammer_price_eur < starting_price_eur))::numeric / count(*),6)),
jsonb_build_object('band','at_starting', 'count',count(*) filter(where hammer_price_eur = starting_price_eur), 'share',round((count(*) filter(where hammer_price_eur = starting_price_eur))::numeric / count(*),6)),
jsonb_build_object('band','above_1_below_1_5', 'count',count(*) filter(where hammer_price_eur > starting_price_eur and hammer_price_eur < starting_price_eur * 1.5), 'share',round((count(*) filter(where hammer_price_eur > starting_price_eur and hammer_price_eur < starting_price_eur * 1.5))::numeric / count(*),6)),
jsonb_build_object('band','from_1_5_below_2', 'count',count(*) filter(where hammer_price_eur >= starting_price_eur * 1.5 and hammer_price_eur < starting_price_eur * 2), 'share',round((count(*) filter(where hammer_price_eur >= starting_price_eur * 1.5 and hammer_price_eur < starting_price_eur * 2))::numeric / count(*),6)),
jsonb_build_object('band','at_least_2', 'count',count(*) filter(where hammer_price_eur >= starting_price_eur * 2), 'share',round((count(*) filter(where hammer_price_eur >= starting_price_eur * 2))::numeric / count(*),6)))
    ) as distribution
  from scoped
  group by grouping sets ((scope_type,court_id),(scope_type,court_id,property_type))
  having count(*) >= 10
)
select parent.scope_type, parent.court_id,
  jsonb_build_object('distribution',parent.distribution,'propertyTypes',
    coalesce((select jsonb_agg(jsonb_build_object(
       'propertyType', child.property_type, 'distribution', child.distribution)
       order by child.property_type)
     from grouped child
     where child.all_types=0 and child.property_type in
       ('apartment','house','commercial','building','land','parking','mixed')
       and child.scope_type=parent.scope_type
       and child.court_id is not distinct from parent.court_id), '[]'::jsonb)
  ) as extra_statistics
from grouped parent where parent.all_types=1;

create view licitor_ingestion.diagnostic_enriched_price_statistics
with (security_invoker=true) as
select base.*, enrich.extra_statistics
from licitor_ingestion.diagnostic_canonical_price_statistics base
left join licitor_ingestion.diagnostic_price_enrichments enrich
on enrich.scope_type=base.scope_type
and enrich.court_id is not distinct from base.court_id;

revoke all on licitor_ingestion.diagnostic_price_enrichments,
  licitor_ingestion.diagnostic_enriched_price_statistics from public, anon, authenticated;
grant select on licitor_ingestion.diagnostic_price_enrichments,
  licitor_ingestion.diagnostic_enriched_price_statistics to service_role;
create or replace function licitor_ingestion.stage_adjudication_price_statistics_build(
  p_source_run_ids text[]
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_build_id uuid;
  v_manifest_hash text;
  v_active_count integer;
  v_national_sample integer;
  v_mapped_sample integer;
  v_unmatched_sample integer;
  v_court_count integer;
  v_period_start date;
  v_period_end date;
begin
  -- Hold the source and mapping tables stable throughout hashing and insertion.
  lock table licitor_ingestion.candidates, licitor_ingestion.runs,
    public.outcome_courts, public.outcome_court_official_references in share mode;
  if p_source_run_ids is null or cardinality(p_source_run_ids) = 0 then
    raise exception 'At least one completed source run is required';
  end if;
  if exists (
    select 1
    from unnest(p_source_run_ids) requested(run_id)
    left join licitor_ingestion.runs source_run on source_run.id = requested.run_id
    where source_run.id is null
       or source_run.status not in ('completed', 'completed_with_errors')
  ) then
    raise exception 'Every source run must exist and be completed';
  end if;
  if exists (
    select 1 from licitor_ingestion.runs
    where status in ('ready', 'running')
  ) then
    raise exception 'Cannot freeze statistics while a collection run is active';
  end if;

  select
    pg_catalog.encode(
      extensions.digest(
        coalesce(
          pg_catalog.string_agg(
            pg_catalog.jsonb_build_object(
              'scope_type', stats.scope_type,
              'court_id', stats.court_id,
              'court_code', stats.court_code,
              'scope_label', stats.scope_label,
              'judicial_region', stats.judicial_region,
              'period_start', stats.period_start,
              'period_end', stats.period_end,
              'minimum_sample', stats.minimum_sample,
              'sample_size', stats.sample_size,
              'extra_statistics', stats.extra_statistics,
              'median_ratio', stats.median_hammer_to_starting_ratio,
              'above_starting_rate', stats.above_starting_rate,
              'at_least_double_rate', stats.at_least_double_rate,
              'median_hammer_price', stats.median_hammer_price_eur,
              'median_starting_price', stats.median_starting_price_eur,
              'diagnostic_status', stats.diagnostic_status,
              'methodology_version', stats.methodology_version
            )::text,
            E'\n' order by stats.scope_type, stats.court_code nulls first
          ),
          ''
        ),
        'sha256'
      ),
      'hex'
    ),
    min(stats.period_start),
    max(stats.period_end),
    max(stats.sample_size) filter (where stats.scope_type = 'national'),
    count(*) filter (where stats.scope_type = 'tribunal')
  into v_manifest_hash, v_period_start, v_period_end, v_national_sample, v_court_count
  from licitor_ingestion.diagnostic_enriched_price_statistics stats;

  if v_national_sample is null or v_period_start is null or v_period_end is null then
    raise exception 'The canonical diagnostic set is empty';
  end if;

  select count(*) into v_active_count from licitor_ingestion.active_candidates;
  select
    coalesce(sum(mapping.sample_size) filter (
      where mapping.mapping_status = 'unique_official_name_contained'
    ), 0),
    coalesce(sum(mapping.sample_size) filter (
      where mapping.mapping_status <> 'unique_official_name_contained'
    ), 0)
  into v_mapped_sample, v_unmatched_sample
  from licitor_ingestion.diagnostic_court_mappings mapping;

  select build.id into v_build_id
  from public.adjudication_price_statistics_builds build
  where build.source_manifest_hash = v_manifest_hash;
  if v_build_id is not null then
    return v_build_id;
  end if;

  insert into public.adjudication_price_statistics_builds (
    source_name,
    source_run_ids,
    period_start,
    period_end,
    window_months,
    minimum_sample,
    active_candidate_lots,
    national_sample_size,
    mapped_sample_size,
    unmatched_sample_size,
    canonical_court_count,
    methodology_version,
    source_manifest_hash
  ) values (
    'licitor',
    p_source_run_ids,
    v_period_start,
    v_period_end,
    36,
    10,
    v_active_count,
    v_national_sample,
    v_mapped_sample,
    v_unmatched_sample,
    v_court_count,
    'licitor_canonical_price_statistics_v1',
    v_manifest_hash
  ) returning id into v_build_id;

  insert into public.adjudication_price_statistics_snapshots (
    build_id,
    scope_type,
    court_id,
    court_code,
    scope_label,
    judicial_region,
    period_start,
    period_end,
    minimum_sample,
    sample_size,
    median_hammer_to_starting_ratio,
    above_starting_rate,
    at_least_double_rate,
    median_hammer_price_eur,
    median_starting_price_eur,
    quality_status,
    methodology_version,
    statistics_hash,
    extra_statistics
  )
  select
    v_build_id,
    stats.scope_type,
    stats.court_id,
    stats.court_code,
    stats.scope_label,
    stats.judicial_region,
    stats.period_start,
    stats.period_end,
    stats.minimum_sample,
    stats.sample_size,
    stats.median_hammer_to_starting_ratio,
    stats.above_starting_rate,
    stats.at_least_double_rate,
    stats.median_hammer_price_eur,
    stats.median_starting_price_eur,
    stats.diagnostic_status,
    stats.methodology_version,
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.jsonb_build_object(
          'build_id', v_build_id,
          'scope_type', stats.scope_type,
          'court_id', stats.court_id,
          'sample_size', stats.sample_size,
          'extra_statistics', stats.extra_statistics,
              'median_ratio', stats.median_hammer_to_starting_ratio,
          'above_starting_rate', stats.above_starting_rate,
          'at_least_double_rate', stats.at_least_double_rate,
          'median_hammer_price', stats.median_hammer_price_eur,
          'median_starting_price', stats.median_starting_price_eur
        )::text,
        'sha256'
      ),
      'hex'
    ),
    stats.extra_statistics
  from licitor_ingestion.diagnostic_enriched_price_statistics stats;

  return v_build_id;
end;
$function$;

revoke all on function licitor_ingestion.stage_adjudication_price_statistics_build(text[])
  from public, anon, authenticated, licitor_collector;
grant execute on function licitor_ingestion.stage_adjudication_price_statistics_build(text[])
  to service_role;


create or replace view public.published_adjudication_price_statistics
with (security_invoker = true) as
select
  snapshot.id,
  snapshot.build_id,
  snapshot.scope_type,
  snapshot.court_id,
  snapshot.court_code,
  snapshot.scope_label,
  snapshot.judicial_region,
  snapshot.period_start,
  snapshot.period_end,
  snapshot.minimum_sample,
  snapshot.sample_size,
  snapshot.median_hammer_to_starting_ratio,
  snapshot.above_starting_rate,
  snapshot.at_least_double_rate,
  snapshot.median_hammer_price_eur,
  snapshot.median_starting_price_eur,
  snapshot.methodology_version,
  build.source_name,
  build.built_at,
  review.reviewed_at,
  snapshot.extra_statistics
from public.adjudication_price_statistics_snapshots snapshot
join public.adjudication_price_statistics_builds build on build.id = snapshot.build_id
join public.adjudication_price_statistics_build_reviews review on review.build_id = build.id
where review.decision = 'approved'
  and review.rights_basis_confirmed
  and review.methodology_approved
  and review.court_mappings_approved
  and snapshot.sample_size >= snapshot.minimum_sample
  and snapshot.quality_status = 'sample_threshold_met_not_reviewed';

revoke all on public.published_adjudication_price_statistics
  from public, anon, authenticated, service_role;
grant select on public.published_adjudication_price_statistics to service_role;

