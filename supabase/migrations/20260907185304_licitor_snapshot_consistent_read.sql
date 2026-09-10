-- Use an MVCC snapshot without granting source write privileges to service_role.
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
  if current_setting('transaction_isolation') not in ('repeatable read', 'serializable') then
    raise exception 'Stage statistics in a REPEATABLE READ transaction';
  end if;
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
