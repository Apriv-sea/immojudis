begin;

select plan(6);

set local role service_role;

insert into public.operational_job_runs (
  job_name,
  status,
  started_at,
  finished_at,
  duration_ms
)
select
  job_name,
  'success',
  '2026-07-29T09:58:00Z'::timestamptz,
  '2026-07-29T09:59:00Z'::timestamptz,
  60000
from unnest(array[
  'operational-health',
  'smart-alerts',
  'alert-notifications',
  'sale-change-monitor',
  'precompute-valuations',
  'data-retention',
  'sale-retention',
  'cnb-lawyer-directory'
]) as job_name;

insert into public.dvf_import_batches (
  id,
  source,
  status,
  imported_rows,
  error_message,
  completed_at,
  created_at,
  updated_at
) values
  (
    '80000000-0000-4000-8000-000000000001',
    'DVF',
    'failed',
    100,
    'superseded test failure',
    '2026-07-29T08:10:00Z'::timestamptz,
    '2026-07-29T08:00:00Z'::timestamptz,
    '2026-07-29T08:10:00Z'::timestamptz
  ),
  (
    '80000000-0000-4000-8000-000000000002',
    'DVF',
    'completed',
    1,
    null,
    '2026-07-29T09:00:00Z'::timestamptz,
    '2026-07-29T08:30:00Z'::timestamptz,
    '2026-07-29T09:00:00Z'::timestamptz
  );

insert into public.dvf_transactions (
  import_batch_id,
  source,
  source_mutation_id,
  sale_date,
  total_price_eur
) values (
  '80000000-0000-4000-8000-000000000002',
  'DVF',
  'phase-5-test',
  '2026-06-30',
  150000
);

select lives_ok(
  $$select public.evaluate_operational_health('2026-07-29T10:00:00Z'::timestamptz)$$,
  'a newer successful DVF import supersedes an earlier failed attempt'
);

select is(
  (
    public.evaluate_operational_health('2026-07-29T10:00:00Z'::timestamptz)
      ->>'dvf_failed_since_last_success'
  )::integer,
  0,
  'superseded DVF failures do not count as active failures'
);

select is(
  (public.evaluate_operational_health('2026-07-29T10:00:00Z'::timestamptz)->>'ok')::boolean,
  true,
  'superseded DVF failures do not keep operational health degraded'
);

insert into public.dvf_import_batches (
  source,
  status,
  imported_rows,
  error_message,
  completed_at,
  created_at,
  updated_at
) values (
  'DVF',
  'failed',
  0,
  'new test failure',
  '2026-07-29T10:02:00Z'::timestamptz,
  '2026-07-29T10:01:00Z'::timestamptz,
  '2026-07-29T10:02:00Z'::timestamptz
);

select lives_ok(
  $$select public.evaluate_operational_health('2026-07-29T10:03:00Z'::timestamptz)$$,
  'a DVF failure newer than the last success is evaluated'
);

select is(
  (select status from public.operational_alerts where alert_key = 'dvf.freshness'),
  'open',
  'a new DVF failure opens the freshness incident'
);

select is(
  (
    select (details->>'failed_since_last_success')::integer
    from public.operational_alerts
    where alert_key = 'dvf.freshness'
  ),
  1,
  'the DVF incident reports only failures newer than the last success'
);

select * from finish();

rollback;
