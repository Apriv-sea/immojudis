begin;

select plan(31);

select has_table(
  'public',
  'auction_sale_competent_court_assignments',
  'verified competent-court assignments have an immutable registry'
);
select has_table(
  'public',
  'catalogue_court_reconciliation_events',
  'catalogue court corrections have an immutable audit log'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.auction_sale_competent_court_assignments'::regclass),
  'assignment registry has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.catalogue_court_reconciliation_events'::regclass),
  'reconciliation event log has RLS enabled'
);
select ok(
  not has_table_privilege('anon', 'public.auction_sale_competent_court_assignments', 'SELECT'),
  'anonymous users cannot read assignment evidence'
);
select ok(
  not has_table_privilege('authenticated', 'public.catalogue_court_reconciliation_events', 'SELECT'),
  'authenticated users cannot read reconciliation events'
);
select ok(
  has_table_privilege('service_role', 'public.auction_sale_competent_court_assignments', 'SELECT')
    and has_table_privilege('service_role', 'public.auction_sale_competent_court_assignments', 'INSERT')
    and not has_table_privilege('service_role', 'public.auction_sale_competent_court_assignments', 'UPDATE')
    and not has_table_privilege('service_role', 'public.auction_sale_competent_court_assignments', 'DELETE'),
  'service role can append but not mutate assignment evidence'
);
select ok(
  not has_function_privilege('authenticated', 'public.reconcile_catalogue_competent_courts()', 'EXECUTE'),
  'authenticated users cannot reconcile catalogue courts'
);
select ok(
  has_function_privilege('service_role', 'public.reconcile_catalogue_competent_courts()', 'EXECUTE'),
  'service role can run the reconciliation RPC'
);

insert into public.tribunals(code, canonical_name, department, city, aliases)
values
  ('court_wrong', 'TJ Incorrect', '99', 'Incorrect', '[]'::jsonb),
  ('court_correct', 'TJ Bourg-en-Bresse', '01', 'Bourg-en-Bresse',
   '["Tribunal judiciaire de Bourg-en-Bresse"]'::jsonb);

insert into public.data_sources (
  id, name, publisher, official, base_url, license,
  legal_review_status, ingestion_policy, active
) values (
  'c2000000-0000-4000-8000-000000000001',
  'competence-reconciliation-pgtap',
  'Test publisher',
  true,
  'https://example.test/competence-source',
  'Test-only',
  'approved',
  'allowed_automated',
  true
);

insert into public.raw_artifacts (
  id, source_id, external_record_id, canonical_url, storage_object_path,
  mime_type, byte_size, content_hash, captured_at, connector_version
) values (
  'c2100000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000001',
  'court-reconciliation-record',
  'https://example.test/competence-source/record',
  'outcome-sources/test/court-reconciliation-record.json',
  'application/json',
  17,
  repeat('c', 64),
  '2026-08-20T12:00:00Z',
  'test-connector/1.0.0'
);

insert into public.judicial_source_records (
  id, source_id, raw_artifact_id, record_kind, external_record_id,
  normalized_data, content_hash, connector_version
) values (
  'c2200000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000001',
  'c2100000-0000-4000-8000-000000000001',
  'auction_result_candidate',
  'court-reconciliation-record',
  '{"source":"test"}'::jsonb,
  repeat('d', 64),
  'test-connector/1.0.0'
);

insert into public.auction_sales(
  id, source_name, source_url, tribunal, tribunal_code, department, city,
  address, postal_code, property_type, sale_date, status, raw_payload
)
values
  (
    'c1000000-0000-4000-8000-000000000001',
    'competence-test',
    'https://example.test/competence/verified',
    'TJ Incorrect',
    'court_wrong',
    '01',
    'Haut-Valromey',
    '1 route du Test',
    '01260',
    'house',
    statement_timestamp() + interval '20 days',
    'upcoming',
    '{}'::jsonb
  ),
  (
    'c1000000-0000-4000-8000-000000000002',
    'competence-test',
    'https://example.test/competence/unverified',
    'TJ Incorrect',
    'court_wrong',
    '99',
    'Commune inconnue',
    '2 route du Test',
    '99000',
    'house',
    statement_timestamp() + interval '21 days',
    'upcoming',
    '{}'::jsonb
  );

select * from public.bridge_auction_sales_to_outcome_graph();

insert into public.source_record_matches (
  source_record_id, round_id, match_score, match_method, match_signals, status
)
select
  'c2200000-0000-4000-8000-000000000001',
  bridge.round_id,
  0.7000,
  'parcel',
  '{"parcel":true}'::jsonb,
  'candidate'
from public.auction_sale_outcome_bridges bridge
where bridge.auction_sale_id = 'c1000000-0000-4000-8000-000000000001';

update public.auction_sales
set tribunal = 'TJ Bourg-en-Bresse',
    tribunal_code = 'court_correct',
    raw_payload = jsonb_build_object(
      'geocode', jsonb_build_object(
        'provider', 'ban_geoplateforme',
        'accepted', true,
        'citycode', '01187'
      ),
      'tribunal_assignment', jsonb_build_object(
        'schema_version', 'justice_competent_court_assignment_v1',
        'status', 'verified',
        'mapping_method', 'justice_competence_insee_exact',
        'insee_code', '01187',
        'commune_name', 'HAUT VALROMEY',
        'court_code', 'court_correct',
        'court_name', 'TJ Bourg-en-Bresse',
        'official_court_name', 'Tribunal judiciaire de Bourg-en-Bresse',
        'court_origin_code', '1',
        'court_srj_code', '39',
        'court_department', '01',
        'court_city', 'Bourg-en-Bresse',
        'reference_sha256', repeat('a', 64),
        'source_name', 'justice_open_data',
        'source_url', 'https://www.data.gouv.fr/datasets/liste-des-juridictions-competentes-pour-les-communes-de-france'
      )
    )
where id = 'c1000000-0000-4000-8000-000000000001';

select results_eq(
  $$select scanned_count, corrected_count, already_correct_count, blocked_count, complete
    from public.reconcile_catalogue_competent_courts()$$,
  $$values (2::bigint, 2::bigint, 0::bigint, 0::bigint, true)$$,
  'reconciliation corrects verified rows and demotes unverified rows atomically'
);

select ok(
  (
    select case_row.court_id = round_row.court_id
      and court_row.code = 'court_correct'
    from public.auction_sale_outcome_bridges bridge
    join public.auction_cases case_row on case_row.id = bridge.case_id
    join public.auction_rounds round_row on round_row.id = bridge.round_id
    join public.outcome_courts court_row on court_row.id = round_row.court_id
    where bridge.auction_sale_id = 'c1000000-0000-4000-8000-000000000001'
  ),
  'verified exact-INSEE evidence updates both case and round to the competent court'
);

select is(
  (
    select court_row.code
    from public.auction_sale_outcome_bridges bridge
    join public.auction_rounds round_row on round_row.id = bridge.round_id
    join public.outcome_courts court_row on court_row.id = round_row.court_id
    where bridge.auction_sale_id = 'c1000000-0000-4000-8000-000000000002'
  ),
  'legacy:unmapped',
  'an unverified tribunal is removed from the statistical lineage'
);

select results_eq(
  $$select court_mapping_method
    from public.auction_sale_outcome_bridges
    order by auction_sale_id$$,
  $$values ('justice_competence_insee_exact'::text), ('unmapped'::text)$$,
  'bridge provenance distinguishes verified competence from an unmapped court'
);

select is(
  (
    select address_row.insee_code
    from public.auction_sale_outcome_bridges bridge
    join public.auction_lots lot_row on lot_row.id = bridge.lot_id
    join public.outcome_addresses address_row on address_row.id = lot_row.address_id
    where bridge.auction_sale_id = 'c1000000-0000-4000-8000-000000000001'
  ),
  '01187',
  'the exact BAN commune code is copied to the Outcome address'
);

select ok(
  (
    select count(*) = 1
      and bool_and(mapping_method = 'justice_competence_insee_exact')
      and bool_and(reference_sha256 = repeat('a', 64))
    from public.auction_sale_competent_court_assignments
  ),
  'one immutable Ministry assignment proof is recorded'
);

select is(
  (select count(*) from public.catalogue_court_reconciliation_events),
  2::bigint,
  'every changed statistical lineage receives an audit event'
);

select throws_ok(
  $$update public.auction_sale_competent_court_assignments set commune_name = 'AUTRE'$$,
  '55000',
  'Competent-court audit rows are immutable.',
  'assignment evidence cannot be updated'
);

select throws_ok(
  $$delete from public.catalogue_court_reconciliation_events$$,
  '55000',
  'Competent-court audit rows are immutable.',
  'reconciliation events cannot be deleted'
);

select throws_ok(
  $$update public.auction_sale_outcome_bridges
    set court_mapping_input = '{}'::jsonb
    where auction_sale_id = 'c1000000-0000-4000-8000-000000000001'$$,
  '55000',
  'Outcome catalogue bridge identity and mapping are immutable.',
  'service-side callers cannot replace the exact reconciliation evidence'
);

select throws_ok(
  $$update public.auction_cases
    set court_id = (select id from public.outcome_courts where code = 'court_wrong')
    where id = (
      select case_id from public.auction_sale_outcome_bridges
      where auction_sale_id = 'c1000000-0000-4000-8000-000000000001'
    )$$,
  '55000',
  'Auction case statistical identity is immutable; create a new case.',
  'the case guard still rejects arbitrary court mutations'
);

select throws_ok(
  $$update public.auction_rounds
    set court_id = (select id from public.outcome_courts where code = 'court_wrong')
    where id = (
      select round_id from public.auction_sale_outcome_bridges
      where auction_sale_id = 'c1000000-0000-4000-8000-000000000001'
    )$$,
  '23514',
  'Auction round court must match its lot case court.',
  'the round/case consistency guard still rejects arbitrary court mutations'
);

insert into public.auction_events (
  case_id,
  lot_id,
  round_id,
  event_type,
  event_at,
  source_id,
  payload,
  confidence_score
)
select
  bridge.case_id,
  bridge.lot_id,
  bridge.round_id,
  'court_reconciliation_dependency_test',
  statement_timestamp(),
  announcement.source_id,
  '{}'::jsonb,
  1
from public.auction_sale_outcome_bridges bridge
join public.auction_events announcement on announcement.id = bridge.announcement_event_id
where bridge.auction_sale_id = 'c1000000-0000-4000-8000-000000000001';

select results_eq(
  $$select corrected_count, already_correct_count, blocked_count, complete
    from public.reconcile_catalogue_competent_courts()$$,
  $$values (0::bigint, 2::bigint, 0::bigint, true)$$,
  'reconciliation stays idempotent after downstream evidence exists'
);

select is(
  (
    select app_private.auction_sale_verified_court_code(sale_row)
    from public.auction_sales sale_row
    where id = 'c1000000-0000-4000-8000-000000000001'
  ),
  'court_correct',
  'the database accepts a complete exact-INSEE assignment contract'
);

select is(
  (
    select app_private.auction_sale_verified_court_code(sale_row)
    from public.auction_sales sale_row
    where id = 'c1000000-0000-4000-8000-000000000002'
  ),
  null,
  'the database refuses a tribunal without exact-INSEE assignment evidence'
);

select ok(
  (
    select court_mapping_input->>'reference_sha256' = repeat('a', 64)
    from public.auction_sale_outcome_bridges
    where auction_sale_id = 'c1000000-0000-4000-8000-000000000001'
  ),
  'verified bridge provenance carries the exact reference hash'
);

select ok(
  (
    select court_mapping_input->>'reason' = 'no_verified_insee_competence'
    from public.auction_sale_outcome_bridges
    where auction_sale_id = 'c1000000-0000-4000-8000-000000000002'
  ),
  'unmapped bridge provenance explains why no court was trusted'
);

insert into public.source_record_matches (
  source_record_id, round_id, match_score, match_method, match_signals, status
)
select
  'c2200000-0000-4000-8000-000000000001',
  bridge.round_id,
  0.7000,
  'court_name_address',
  '{"court":true,"address":true}'::jsonb,
  'candidate'
from public.auction_sale_outcome_bridges bridge
where bridge.auction_sale_id = 'c1000000-0000-4000-8000-000000000002';

update public.auction_sales
set tribunal = 'TJ Bourg-en-Bresse',
    tribunal_code = 'court_correct',
    raw_payload = jsonb_build_object(
      'geocode', jsonb_build_object(
        'provider', 'ban_geoplateforme',
        'accepted', true,
        'citycode', '01187'
      ),
      'tribunal_assignment', jsonb_build_object(
        'schema_version', 'justice_competent_court_assignment_v1',
        'status', 'verified',
        'mapping_method', 'justice_competence_insee_exact',
        'insee_code', '01187',
        'commune_name', 'HAUT VALROMEY',
        'court_code', 'court_correct',
        'court_name', 'TJ Bourg-en-Bresse',
        'official_court_name', 'Tribunal judiciaire de Bourg-en-Bresse',
        'court_origin_code', '1',
        'court_srj_code', '39',
        'court_department', '01',
        'court_city', 'Bourg-en-Bresse',
        'reference_sha256', repeat('b', 64),
        'source_name', 'justice_open_data',
        'source_url', 'https://www.data.gouv.fr/datasets/liste-des-juridictions-competentes-pour-les-communes-de-france'
      )
    )
where id = 'c1000000-0000-4000-8000-000000000002';

select results_eq(
  $$select corrected_count, already_correct_count, blocked_count, complete
    from public.reconcile_catalogue_competent_courts()$$,
  $$values (0::bigint, 1::bigint, 1::bigint, false)$$,
  'a court-dependent source candidate still blocks statistical identity mutation'
);

select is(
  (
    select court_row.code
    from public.auction_sale_outcome_bridges bridge
    join public.auction_rounds round_row on round_row.id = bridge.round_id
    join public.outcome_courts court_row on court_row.id = round_row.court_id
    where bridge.auction_sale_id = 'c1000000-0000-4000-8000-000000000002'
  ),
  'legacy:unmapped',
  'a blocked court-dependent lineage remains unchanged'
);

select ok(not has_function_privilege('authenticated', 'public.reconcile_catalogue_competent_courts_batch(uuid,integer)', 'EXECUTE'), 'batch RPC is private');
select throws_ok($$select * from public.reconcile_catalogue_competent_courts_batch(null, 0)$$, '22023', 'Batch limit must be between 1 and 100.', 'zero batch rejected');
select ok((select scanned_count <= 1 and next_cursor is not null and has_more from public.reconcile_catalogue_competent_courts_batch(null, 1)), 'batch is bounded and provides continuation');
select * from finish();
rollback;
