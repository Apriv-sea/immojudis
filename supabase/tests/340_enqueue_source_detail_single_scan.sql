begin;

select plan(18);

set local app.pipeline_queue_owner = 'python';

select is(
  (
    select count(*)
    from public.auction_pipeline_control
    where id
  ),
  1::bigint,
  'single pipeline control row is available'
);

update public.auction_pipeline_control
   set enabled = true,
       source_details_enabled = true
 where id;

select ok(
  (select enabled and source_details_enabled from public.auction_pipeline_control where id),
  'source-detail enqueue is enabled for the fixture'
);

insert into public.auction_source_state (
  source_name,
  enabled,
  suspended_until
)
values
  ('pgtap-enqueue-primary', true, null),
  ('pgtap-enqueue-observed', true, null),
  ('pgtap-enqueue-check', true, null),
  ('pgtap-enqueue-fresh', true, null),
  ('pgtap-enqueue-paused', true, '2026-09-14 12:00:00+00'),
  ('pgtap-enqueue-disabled', false, null),
  ('pgtap-enqueue-postponed', true, null),
  ('pgtap-enqueue-conflict', true, null);

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  status,
  sale_date,
  observations,
  raw_payload,
  sale_procedure
)
values (
  'f3400000-0000-4000-8000-000000000001',
  'pgtap-enqueue-primary',
  'https://example.test/pgtap/enqueue/canonical',
  'upcoming',
  '2026-09-15 12:00:00+00',
  jsonb_build_array(
    jsonb_build_object(
      'source_name', 'pgtap-enqueue-observed',
      'source_url', 'https://example.test/pgtap/enqueue/observed'
    ),
    jsonb_build_object(
      'source_name', 'pgtap-enqueue-primary',
      'source_url', 'https://example.test/pgtap/enqueue/canonical'
    )
  ),
  jsonb_build_object(
    'source_checks', jsonb_build_object(
      'https://example.test/pgtap/enqueue/checked',
      jsonb_build_object('source_name', 'pgtap-enqueue-check', 'checked_at', '2026-09-12T12:00:00Z'),
      'https://example.test/pgtap/enqueue/fresh',
      jsonb_build_object('source_name', 'pgtap-enqueue-fresh', 'checked_at', '2026-09-13T11:00:00Z')
    )
  ),
  '{}'::jsonb
), (
  'f3400000-0000-4000-8000-000000000002',
  'pgtap-enqueue-paused',
  'https://example.test/pgtap/enqueue/paused',
  'upcoming',
  '2026-09-15 12:00:00+00',
  '[]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb
), (
  'f3400000-0000-4000-8000-000000000003',
  'pgtap-enqueue-disabled',
  'https://example.test/pgtap/enqueue/disabled',
  'upcoming',
  '2026-09-15 12:00:00+00',
  '[]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb
), (
  'f3400000-0000-4000-8000-000000000004',
  'pgtap-enqueue-expired',
  'https://example.test/pgtap/enqueue/expired',
  'upcoming',
  '2020-01-01 12:00:00+00',
  '[]'::jsonb,
  jsonb_build_object('sale_date', '2020-01-01'),
  '{}'::jsonb
), (
  'f3400000-0000-4000-8000-000000000005',
  'pgtap-enqueue-postponed',
  'https://example.test/pgtap/enqueue/postponed',
  'postponed',
  '2020-01-01 12:00:00+00',
  '[]'::jsonb,
  jsonb_build_object('status', 'postponed', 'sale_date', '2020-01-01'),
  '{}'::jsonb
), (
  'f3400000-0000-4000-8000-000000000006',
  'pgtap-enqueue-conflict',
  'https://example.test/pgtap/enqueue/conflict',
  'upcoming',
  '2020-01-01 12:00:00+00',
  '[]'::jsonb,
  jsonb_build_object(
    'sale_date', '2020-01-01',
    'source_conflicts', jsonb_build_array(jsonb_build_object('field', 'sale_date'))
  ),
  '{}'::jsonb
);

select is(
  public.enqueue_due_source_details('2026-09-13 12:00:00+00', 100),
  5,
  'first enqueue admits canonical, observed, stale-check, postponed and contradictory-date aliases'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where job_type = 'source_detail'
      and source_url like 'https://example.test/pgtap/enqueue/%'
  ),
  5::bigint,
  'only five due source-detail jobs were inserted'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/enqueue/canonical'
      and job_type = 'source_detail'
  ),
  3::bigint,
  'canonical, observations and source_checks aliases are all considered'
);

select is(
  (
    select count(distinct detail_source_name)
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/enqueue/canonical'
      and job_type = 'source_detail'
  ),
  3::bigint,
  'alias identity keeps source names distinct'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where detail_source_url = 'https://example.test/pgtap/enqueue/checked'
      and detail_source_name = 'pgtap-enqueue-check'
  ),
  1::bigint,
  'stale source_checks timestamp is due'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where detail_source_url = 'https://example.test/pgtap/enqueue/fresh'
  ),
  0::bigint,
  'fresh source_checks timestamp is not due'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/enqueue/paused'
  ),
  0::bigint,
  'suspended source alias is excluded'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/enqueue/disabled'
  ),
  0::bigint,
  'disabled source alias is excluded'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/enqueue/expired'
  ),
  0::bigint,
  'expired sale is excluded by retention deadline'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/enqueue/postponed'
  ),
  1::bigint,
  'postponed sale remains retained without inventing an end date'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/enqueue/conflict'
  ),
  1::bigint,
  'contradictory sale date remains retained for source verification'
);

select is(
  (
    select input_hash
    from public.auction_enrichment_jobs
    where detail_source_name = 'pgtap-enqueue-primary'
      and detail_source_url = 'https://example.test/pgtap/enqueue/canonical'
  ),
  'source_detail_v1:' ||
    md5(
      'pgtap-enqueue-primary:https://example.test/pgtap/enqueue/canonical:never:2026-09-13'
    ),
  'signature preserves the v1 source-detail hash'
);

select is(
  (
    select input_hash
    from public.auction_enrichment_jobs
    where detail_source_name = 'pgtap-enqueue-check'
      and detail_source_url = 'https://example.test/pgtap/enqueue/checked'
  ),
  'source_detail_v1:' ||
    md5(
      'pgtap-enqueue-check:https://example.test/pgtap/enqueue/checked:1789214400.000000:2026-09-13'
    ),
  'checked timestamp participates in the signature'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where source_url like 'https://example.test/pgtap/enqueue/%'
      and job_type = 'source_detail'
      and priority = 100
  ),
  5::bigint,
  'source-detail jobs retain the bounded priority'
);

select is(
  public.enqueue_due_source_details('2026-09-13 12:00:00+00', 100),
  0,
  'replaying the same timestamp is idempotent'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where source_url like 'https://example.test/pgtap/enqueue/%'
      and job_type = 'source_detail'
  ),
  5::bigint,
  'idempotent replay does not create duplicate revisions'
);

select * from finish();
rollback;
