-- Freeze the private Licitor diagnostics before any Premium publication.
-- Snapshot creation and review are server-only; no decision is inserted here.
create table public.adjudication_price_statistics_builds (
  id uuid primary key default gen_random_uuid(),
  source_name text not null check (source_name = 'licitor'),
  source_run_ids text[] not null check (cardinality(source_run_ids) > 0),
  period_start date not null,
  period_end date not null,
  window_months smallint not null check (window_months = 36),
  minimum_sample integer not null check (minimum_sample = 10),
  active_candidate_lots integer not null check (active_candidate_lots >= 0),
  national_sample_size integer not null check (national_sample_size >= 0),
  mapped_sample_size integer not null check (mapped_sample_size >= 0),
  unmatched_sample_size integer not null check (unmatched_sample_size >= 0),
  canonical_court_count integer not null check (canonical_court_count >= 0),
  methodology_version text not null check (
    methodology_version = 'licitor_canonical_price_statistics_v1'
  ),
  source_manifest_hash text not null unique check (
    source_manifest_hash ~ '^[a-f0-9]{64}$'
  ),
  built_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  check (national_sample_size <= active_candidate_lots),
  check (mapped_sample_size + unmatched_sample_size = national_sample_size)
);

create table public.adjudication_price_statistics_snapshots (
  id uuid primary key default gen_random_uuid(),
  build_id uuid not null references public.adjudication_price_statistics_builds(id) on delete restrict,
  scope_type text not null check (scope_type in ('national', 'tribunal')),
  court_id uuid references public.outcome_courts(id) on delete restrict,
  court_code text,
  scope_label text not null check (nullif(btrim(scope_label), '') is not null),
  judicial_region text,
  period_start date not null,
  period_end date not null,
  minimum_sample integer not null check (minimum_sample = 10),
  sample_size integer not null check (sample_size >= 0),
  median_hammer_to_starting_ratio numeric,
  above_starting_rate numeric,
  at_least_double_rate numeric,
  median_hammer_price_eur numeric,
  median_starting_price_eur numeric,
  quality_status text not null check (
    quality_status in ('sample_threshold_met_not_reviewed', 'insufficient_data')
  ),
  methodology_version text not null check (
    methodology_version = 'licitor_canonical_price_statistics_v1'
  ),
  statistics_hash text not null unique check (statistics_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique nulls not distinct (build_id, scope_type, court_id),
  check (period_end >= period_start),
  check (
    (scope_type = 'national' and court_id is null and court_code is null)
    or
    (
      scope_type = 'tribunal'
      and court_id is not null
      and nullif(btrim(court_code), '') is not null
    )
  ),
  check (
    (
      sample_size >= minimum_sample
      and quality_status = 'sample_threshold_met_not_reviewed'
      and median_hammer_to_starting_ratio is not null
      and above_starting_rate is not null
      and at_least_double_rate is not null
      and median_hammer_price_eur is not null
      and median_starting_price_eur is not null
    )
    or
    (
      sample_size < minimum_sample
      and quality_status = 'insufficient_data'
      and median_hammer_to_starting_ratio is null
      and above_starting_rate is null
      and at_least_double_rate is null
      and median_hammer_price_eur is null
      and median_starting_price_eur is null
    )
  ),
  check (above_starting_rate is null or above_starting_rate between 0 and 1),
  check (at_least_double_rate is null or at_least_double_rate between 0 and 1),
  check (median_hammer_to_starting_ratio is null or median_hammer_to_starting_ratio > 0),
  check (median_hammer_price_eur is null or median_hammer_price_eur > 0),
  check (median_starting_price_eur is null or median_starting_price_eur > 0)
);

create table public.adjudication_price_statistics_build_reviews (
  build_id uuid primary key references public.adjudication_price_statistics_builds(id) on delete restrict,
  decision text not null check (decision in ('approved', 'rejected')),
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  rights_basis_confirmed boolean not null default false,
  methodology_approved boolean not null default false,
  court_mappings_approved boolean not null default false,
  notes text not null check (nullif(btrim(notes), '') is not null),
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (
    decision <> 'approved'
    or (rights_basis_confirmed and methodology_approved and court_mappings_approved)
  )
);

create index adjudication_price_statistics_builds_latest_idx
  on public.adjudication_price_statistics_builds(period_end desc, built_at desc);
create index adjudication_price_statistics_snapshots_lookup_idx
  on public.adjudication_price_statistics_snapshots(build_id, scope_type, court_code);

create or replace function app_private.reject_adjudication_price_statistics_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'Adjudication price-statistics records are append-only';
end;
$function$;

revoke all on function app_private.reject_adjudication_price_statistics_mutation()
  from public, anon, authenticated, service_role;

create trigger adjudication_price_statistics_builds_append_only
before update or delete on public.adjudication_price_statistics_builds
for each row execute function app_private.reject_adjudication_price_statistics_mutation();

create trigger adjudication_price_statistics_snapshots_append_only
before update or delete on public.adjudication_price_statistics_snapshots
for each row execute function app_private.reject_adjudication_price_statistics_mutation();

create trigger adjudication_price_statistics_reviews_append_only
before update or delete on public.adjudication_price_statistics_build_reviews
for each row execute function app_private.reject_adjudication_price_statistics_mutation();

alter table public.adjudication_price_statistics_builds enable row level security;
alter table public.adjudication_price_statistics_snapshots enable row level security;
alter table public.adjudication_price_statistics_build_reviews enable row level security;

revoke all on table
  public.adjudication_price_statistics_builds,
  public.adjudication_price_statistics_snapshots,
  public.adjudication_price_statistics_build_reviews
from public, anon, authenticated, service_role;

grant select, insert on table
  public.adjudication_price_statistics_builds,
  public.adjudication_price_statistics_snapshots,
  public.adjudication_price_statistics_build_reviews
to service_role;
grant select on licitor_ingestion.runs to service_role;

create view public.published_adjudication_price_statistics
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
  review.reviewed_at
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
  from licitor_ingestion.diagnostic_canonical_price_statistics stats;

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
    statistics_hash
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
          'median_ratio', stats.median_hammer_to_starting_ratio,
          'above_starting_rate', stats.above_starting_rate,
          'at_least_double_rate', stats.at_least_double_rate,
          'median_hammer_price', stats.median_hammer_price_eur,
          'median_starting_price', stats.median_starting_price_eur
        )::text,
        'sha256'
      ),
      'hex'
    )
  from licitor_ingestion.diagnostic_canonical_price_statistics stats;

  return v_build_id;
end;
$function$;

revoke all on function licitor_ingestion.stage_adjudication_price_statistics_build(text[])
  from public, anon, authenticated, licitor_collector;
grant execute on function licitor_ingestion.stage_adjudication_price_statistics_build(text[])
  to service_role;

comment on table public.adjudication_price_statistics_builds is
  'Immutable manifests for private Licitor-derived price-statistics builds; not public without a separate approved review.';
comment on table public.adjudication_price_statistics_snapshots is
  'Immutable national and canonical-court cells. Sub-threshold measures are suppressed before storage.';
comment on table public.adjudication_price_statistics_build_reviews is
  'Append-only human publication decision. No row means the build remains private.';
comment on view public.published_adjudication_price_statistics is
  'Server-only reviewed price-statistics cells. Empty until an explicit complete approval exists.';
