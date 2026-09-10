-- Diagnostic-only aggregates over the private three-year Licitor window.
-- Raw court labels still require reconciliation with the official court registry.
create view licitor_ingestion.diagnostic_price_statistics
with (security_invoker = true) as
with parsed as (
  select
    nullif(pg_catalog.btrim(c.payload->>'tribunal'), '') as tribunal,
    (c.payload->>'sale_date')::date as sale_date,
    case when pg_catalog.pg_input_is_valid(c.payload->>'starting_price_eur', 'numeric')
      then (c.payload->>'starting_price_eur')::numeric end as starting_price_eur,
    case when pg_catalog.pg_input_is_valid(c.payload->>'adjudication_price_eur', 'numeric')
      then (c.payload->>'adjudication_price_eur')::numeric end as hammer_price_eur,
    coalesce(c.payload->>'sale_venue_type', 'tribunal') as sale_venue_type,
    coalesce(c.payload->'quality_flags', '[]'::jsonb) as quality_flags
  from licitor_ingestion.active_candidates c
), eligible as (
  select tribunal, sale_date, starting_price_eur, hammer_price_eur
  from parsed
  where sale_venue_type = 'tribunal'
    and not (quality_flags ?| array[
        'index_detail_date_conflict',
        'conflicting_announcement_alias_capture',
        'cached_reparse_failed',
        'source_result_changed_pending_review',
        'lot_missing_in_latest_capture'
      ])
    and starting_price_eur > 1000
    and hammer_price_eur > 0
), aggregates as (
  select
    'national'::text as scope_type,
    'France entière'::text as scope_label,
    count(*) as sample_size,
    (percentile_cont(0.5) within group (order by hammer_price_eur / starting_price_eur))::numeric as median_ratio,
    avg((hammer_price_eur > starting_price_eur)::integer) as above_starting_rate,
    avg((hammer_price_eur >= 2 * starting_price_eur)::integer) as at_least_double_rate,
    (percentile_cont(0.5) within group (order by hammer_price_eur))::numeric as median_hammer_price,
    (percentile_cont(0.5) within group (order by starting_price_eur))::numeric as median_starting_price
  from eligible
  union all
  select
    'tribunal'::text,
    tribunal,
    count(*),
    (percentile_cont(0.5) within group (order by hammer_price_eur / starting_price_eur))::numeric,
    avg((hammer_price_eur > starting_price_eur)::integer),
    avg((hammer_price_eur >= 2 * starting_price_eur)::integer),
    (percentile_cont(0.5) within group (order by hammer_price_eur))::numeric,
    (percentile_cont(0.5) within group (order by starting_price_eur))::numeric
  from eligible
  where tribunal is not null
  group by tribunal
)
select
  scope_type,
  scope_label,
  ((now() at time zone 'UTC')::date - interval '3 years')::date as period_start,
  (now() at time zone 'UTC')::date as period_end,
  10::integer as minimum_sample,
  sample_size,
  case when sample_size >= 10 then round(median_ratio, 4) end as median_hammer_to_starting_ratio,
  case when sample_size >= 10 then round(above_starting_rate, 6) end as above_starting_rate,
  case when sample_size >= 10 then round(at_least_double_rate, 6) end as at_least_double_rate,
  case when sample_size >= 10 then round(median_hammer_price) end as median_hammer_price_eur,
  case when sample_size >= 10 then round(median_starting_price) end as median_starting_price_eur,
  case
    when sample_size >= 10 then 'sample_threshold_met_not_reviewed'
    else 'insufficient_data'
  end as diagnostic_status,
  false as publication_eligible,
  'pending'::text as review_status,
  'licitor_price_statistics_v2'::text as methodology_version
from aggregates;

revoke all on licitor_ingestion.diagnostic_price_statistics from public, anon, authenticated;
grant select on licitor_ingestion.diagnostic_price_statistics to licitor_collector;
comment on view licitor_ingestion.diagnostic_price_statistics is
  'Private three-year national and raw-tribunal Licitor price diagnostics. Values below n=10 are suppressed. Not publication eligible.';