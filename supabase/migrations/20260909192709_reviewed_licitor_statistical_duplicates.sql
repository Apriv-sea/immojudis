-- Keep every source capture and acquisition candidate. Only reviewed statistical
-- aliases are excluded, while both reviewed capture hashes still match.
create table licitor_ingestion.reviewed_statistical_duplicates (
  duplicate_external_id text primary key references licitor_ingestion.candidates(external_id),
  canonical_external_id text not null references licitor_ingestion.candidates(external_id),
  duplicate_capture_sha256 text not null check (duplicate_capture_sha256 ~ '^[a-f0-9]{64}$'),
  canonical_capture_sha256 text not null check (canonical_capture_sha256 ~ '^[a-f0-9]{64}$'),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object' and evidence <> '{}'::jsonb),
  reviewed_at timestamptz not null default now(),
  check (canonical_external_id < duplicate_external_id)
);
revoke all on licitor_ingestion.reviewed_statistical_duplicates from public, anon, authenticated;
grant select on licitor_ingestion.reviewed_statistical_duplicates to service_role, licitor_collector;

create view licitor_ingestion.statistics_candidates
with (security_invoker = true) as
select candidate.*
from licitor_ingestion.active_candidates candidate
where not exists (
  select 1
  from licitor_ingestion.reviewed_statistical_duplicates review
  join licitor_ingestion.active_candidates canonical
    on canonical.external_id = review.canonical_external_id
  where review.duplicate_external_id = candidate.external_id
    and candidate.payload->>'source_content_hash' = review.duplicate_capture_sha256
    and canonical.payload->>'source_content_hash' = review.canonical_capture_sha256
    and canonical.payload->>'sale_date' = candidate.payload->>'sale_date'
    and canonical.payload->>'starting_price_eur' = candidate.payload->>'starting_price_eur'
    and canonical.payload->>'adjudication_price_eur' = candidate.payload->>'adjudication_price_eur'
    and not exists (
      select 1 from licitor_ingestion.reviewed_statistical_duplicates parent_review
      where parent_review.duplicate_external_id = review.canonical_external_id
    )
    -- A changed or excluded canonical source cannot silently remove its alias.
    and coalesce(canonical.payload->>'sale_venue_type', 'tribunal') = 'tribunal'
    and not (coalesce(canonical.payload->'quality_flags', '[]'::jsonb) ?| array[
      'index_detail_date_conflict', 'conflicting_announcement_alias_capture',
      'cached_reparse_failed', 'source_result_changed_pending_review',
      'lot_missing_in_latest_capture'
    ])
    and case when pg_catalog.pg_input_is_valid(canonical.payload->>'starting_price_eur', 'numeric')
      then (canonical.payload->>'starting_price_eur')::numeric > 1000 else false end
    and case when pg_catalog.pg_input_is_valid(canonical.payload->>'adjudication_price_eur', 'numeric')
      then (canonical.payload->>'adjudication_price_eur')::numeric > 0 else false end
);
revoke all on licitor_ingestion.statistics_candidates from public, anon, authenticated;
grant select on licitor_ingestion.statistics_candidates to service_role, licitor_collector;

-- Preserve existing aggregate definitions, column contracts and grants. The
-- acquisition window and immutable published snapshots are deliberately retained.
do $migration$
declare
  view_name text;
  definition text;
begin
  foreach view_name in array array[
    'diagnostic_price_statistics',
    'diagnostic_canonical_price_statistics',
    'diagnostic_price_enrichments'
  ] loop
    select pg_catalog.pg_get_viewdef(
      pg_catalog.to_regclass('licitor_ingestion.' || view_name), true
    ) into definition;
    if definition is null or position('licitor_ingestion.active_candidates' in definition) = 0 then
      raise exception 'Unexpected diagnostic view definition: %', view_name;
    end if;
    execute pg_catalog.format(
      'create or replace view licitor_ingestion.%I with (security_invoker=true) as %s',
      view_name,
      pg_catalog.replace(definition, 'licitor_ingestion.active_candidates', 'licitor_ingestion.statistics_candidates')
    );
  end loop;
end;
$migration$;

comment on table licitor_ingestion.reviewed_statistical_duplicates is
  'Source-reviewed same-sale lot aliases. No automatic address/price deduplication. Re-review when capture hashes change.';
