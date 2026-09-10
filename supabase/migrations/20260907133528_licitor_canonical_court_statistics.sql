-- Resolve raw Licitor court labels conservatively against the current official
-- Justice references. Ambiguous or unmatched labels remain visible for review
-- but are excluded from canonical tribunal statistics.
create view licitor_ingestion.diagnostic_court_mappings
with (security_invoker = true) as
with labels as (
  select
    stats.scope_label as raw_tribunal_label,
    stats.sample_size,
    app_private.normalize_court_label(stats.scope_label) as normalized_label
  from licitor_ingestion.diagnostic_price_statistics stats
  where stats.scope_type = 'tribunal'
), official_names as (
  select distinct
    court.id as court_id,
    app_private.normalize_court_label(reference.official_name) as normalized_official_name
  from public.outcome_court_official_references reference
  join public.outcome_courts court on court.id = reference.court_id
  where court.active
    and court.court_type = 'tribunal_judiciaire'
), candidate_matches as (
  select distinct
    label.raw_tribunal_label,
    official.court_id
  from labels label
  join official_names official
    on position(official.normalized_official_name in label.normalized_label) > 0
), match_sets as (
  select
    label.raw_tribunal_label,
    label.normalized_label,
    label.sample_size,
    coalesce(
      array_agg(candidate.court_id order by candidate.court_id)
        filter (where candidate.court_id is not null),
      array[]::uuid[]
    ) as court_ids
  from labels label
  left join candidate_matches candidate
    on candidate.raw_tribunal_label = label.raw_tribunal_label
  group by label.raw_tribunal_label, label.normalized_label, label.sample_size
)
select
  match_set.raw_tribunal_label,
  match_set.normalized_label,
  match_set.sample_size,
  cardinality(match_set.court_ids)::integer as candidate_count,
  case cardinality(match_set.court_ids)
    when 0 then 'unmatched'
    when 1 then 'unique_official_name_contained'
    else 'ambiguous'
  end as mapping_status,
  case when cardinality(match_set.court_ids) = 1 then court.id end as court_id,
  case when cardinality(match_set.court_ids) = 1 then court.code end as court_code,
  case when cardinality(match_set.court_ids) = 1 then court.name end as court_name,
  case when cardinality(match_set.court_ids) = 1 then court.judicial_region end as judicial_region,
  false as publication_eligible,
  'pending'::text as review_status
from match_sets match_set
left join public.outcome_courts court
  on cardinality(match_set.court_ids) = 1
 and court.id = match_set.court_ids[1];

create view licitor_ingestion.diagnostic_canonical_price_statistics
with (security_invoker = true) as
with parsed as (
  select
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
    eligible.starting_price_eur,
    eligible.hammer_price_eur
  from eligible
  join licitor_ingestion.diagnostic_court_mappings mapping
    on mapping.raw_tribunal_label = eligible.raw_tribunal_label
   and mapping.mapping_status = 'unique_official_name_contained'
), aggregates as (
  select
    scope_type,
    court_id,
    court_code,
    scope_label,
    judicial_region,
    count(*) as sample_size,
    (percentile_cont(0.5) within group (order by hammer_price_eur / starting_price_eur))::numeric as median_ratio,
    avg((hammer_price_eur > starting_price_eur)::integer) as above_starting_rate,
    avg((hammer_price_eur >= 2 * starting_price_eur)::integer) as at_least_double_rate,
    (percentile_cont(0.5) within group (order by hammer_price_eur))::numeric as median_hammer_price,
    (percentile_cont(0.5) within group (order by starting_price_eur))::numeric as median_starting_price
  from scoped
  group by scope_type, court_id, court_code, scope_label, judicial_region
)
select
  scope_type,
  court_id,
  court_code,
  scope_label,
  judicial_region,
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
  'licitor_canonical_price_statistics_v1'::text as methodology_version
from aggregates;

revoke all on licitor_ingestion.diagnostic_court_mappings from public, anon, authenticated;
revoke all on licitor_ingestion.diagnostic_canonical_price_statistics from public, anon, authenticated;

-- Server-only read path for the future reviewed publication bridge. This does
-- not grant access to anon/authenticated and does not alter Premium visibility.
grant usage on schema licitor_ingestion to service_role;
grant select on licitor_ingestion.candidates to service_role;
grant select on licitor_ingestion.active_candidates,
  licitor_ingestion.diagnostic_price_statistics,
  licitor_ingestion.diagnostic_court_mappings,
  licitor_ingestion.diagnostic_canonical_price_statistics
to service_role;

comment on view licitor_ingestion.diagnostic_court_mappings is
  'Private conservative mapping of raw Licitor court labels to official active courts. Unique containment only; pending review.';
comment on view licitor_ingestion.diagnostic_canonical_price_statistics is
  'Private three-year national and official-court Licitor diagnostics. Values below n=10 are suppressed. Not publication eligible.';
