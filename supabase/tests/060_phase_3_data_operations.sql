begin;

select plan(30);

select has_extension('pg_cron', 'pg_cron is available for the 15-minute health scheduler');
select has_extension('pg_net', 'pg_net is available for the authenticated health callback');

select is(
  (select schedule from cron.job where jobname = 'immojudis-operational-health'),
  '*/15 * * * *',
  'operational health is scheduled every fifteen minutes'
);

select ok(
  (select active from cron.job where jobname = 'immojudis-operational-health'),
  'the operational health scheduler is active'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_operational_alert_notifications(integer,timestamptz)',
    'EXECUTE'
  ),
  'subscribers cannot claim operational alert deliveries'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.claim_operational_alert_notifications(integer,timestamptz)',
    'EXECUTE'
  ),
  'the service role can claim operational alert deliveries'
);

select ok(
  not has_function_privilege(
    'service_role',
    'app_private.invoke_operational_health_endpoint()',
    'EXECUTE'
  ),
  'the Vault-backed scheduler callback is reserved to postgres'
);

select ok(
  to_regclass('public.auction_sales_department_sale_date_idx') is not null,
  'the canonical department and sale date index survives infrastructure changes'
);

select ok(
  to_regclass('public.auction_sales_investment_score_idx') is not null,
  'the canonical investment score index survives infrastructure changes'
);

select ok(
  to_regclass('public.auction_sales_lat_lng_idx') is not null,
  'the canonical map bounding-box index survives infrastructure changes'
);

select ok(
  to_regclass('public.v_auction_map_pins') is not null,
  'the canonical map pins view survives infrastructure changes'
);

select is(
  obj_description('public.dvf_transactions_source_mutation_uidx'::regclass, 'pg_class'),
  'One canonical DVF transaction per source mutation; local and parcel source rows are aggregated by the importer.',
  'the DVF replacement index keeps its canonical metadata'
);

select ok(
  has_table_privilege(
    'service_role',
    'public.auction_sales_investment_candidates',
    'SELECT'
  ),
  'the trusted worker can read investment candidates'
);

select ok(
  has_table_privilege('authenticated', 'public.v_auction_map_pins', 'SELECT')
  and not has_table_privilege('authenticated', 'public.v_auction_map_pins', 'TRUNCATE'),
  'authenticated map access is strictly read-only'
);

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
  '2026-07-27T09:59:00Z'::timestamptz,
  '2026-07-27T10:00:00Z'::timestamptz,
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
  completed_at,
  created_at,
  updated_at
) values (
  '76000000-0000-4000-8000-000000000001',
  'DVF',
  'completed',
  1,
  '2026-07-27T09:00:00Z'::timestamptz,
  '2026-07-27T08:00:00Z'::timestamptz,
  '2026-07-27T09:00:00Z'::timestamptz
);

insert into public.dvf_transactions (
  import_batch_id,
  source,
  source_mutation_id,
  sale_date,
  total_price_eur
) values (
  '76000000-0000-4000-8000-000000000001',
  'DVF',
  'phase-3-test',
  '2026-06-30',
  150000
);

select lives_ok(
  $$select public.evaluate_operational_health('2026-07-27T10:15:00Z'::timestamptz)$$,
  'the healthy baseline can be evaluated'
);

select is(
  (public.evaluate_operational_health('2026-07-27T10:15:00Z'::timestamptz)->>'ok')::boolean,
  true,
  'the baseline meets every operational health objective'
);

select is(
  (public.evaluate_operational_health('2026-07-27T10:15:00Z'::timestamptz)->>'dvf_transactions')::bigint,
  1::bigint,
  'the DVF health signal detects data without an exact table scan'
);

delete from public.operational_job_runs where job_name = 'sale-change-monitor';

select lives_ok(
  $$select public.evaluate_operational_health('2026-07-27T10:16:00Z'::timestamptz)$$,
  'a stale cron creates an operational incident'
);

select is(
  (select status from public.operational_alerts where alert_key = 'cron.stale'),
  'open',
  'the cron incident is open'
);

select is(
  (select details->'stale_jobs'->>0 from public.operational_alerts where alert_key = 'cron.stale'),
  'sale-change-monitor',
  'the incident identifies the exact stale job'
);

select is(
  (select notification_status from public.operational_alerts where alert_key = 'cron.stale'),
  'pending',
  'a new incident is queued for external delivery'
);

select is(
  (
    select alert_key
    from public.claim_operational_alert_notifications(10, '2026-07-27T10:17:00Z'::timestamptz)
    where alert_key = 'cron.stale'
  ),
  'cron.stale',
  'the pending incident can be atomically claimed'
);

select is(
  (select notification_status from public.operational_alerts where alert_key = 'cron.stale'),
  'processing',
  'claiming prevents a concurrent duplicate delivery'
);

select lives_ok(
  $$select public.complete_operational_alert_notification(
      'cron.stale',
      (select notification_version from public.operational_alerts where alert_key = 'cron.stale'),
      true,
      null,
      '2026-07-27T10:18:00Z'::timestamptz
    )$$,
  'a successful external delivery can be acknowledged'
);

select is(
  (select notification_status from public.operational_alerts where alert_key = 'cron.stale'),
  'delivered',
  'the incident records successful external delivery'
);

insert into public.operational_job_runs (
  job_name,
  status,
  started_at,
  finished_at,
  duration_ms
) values (
  'operational-health',
  'success',
  '2026-07-27T16:18:00Z'::timestamptz,
  '2026-07-27T16:19:00Z'::timestamptz,
  60000
);

select lives_ok(
  $$select public.evaluate_operational_health('2026-07-27T16:20:00Z'::timestamptz)$$,
  'an unchanged open incident can be reevaluated after six hours'
);

select is(
  (
    select status || ':' || notification_event || ':' || notification_status
    from public.operational_alerts
    where alert_key = 'cron.stale'
  ),
  'open:opened:delivered',
  'an unchanged incident does not queue a repetitive reminder'
);

insert into public.operational_job_runs (
  job_name,
  status,
  started_at,
  finished_at,
  duration_ms
) values (
  'sale-change-monitor',
  'success',
  '2026-07-27T16:20:00Z'::timestamptz,
  '2026-07-27T16:21:00Z'::timestamptz,
  60000
);

select lives_ok(
  $$select public.evaluate_operational_health('2026-07-27T16:22:00Z'::timestamptz)$$,
  'recovery is evaluated'
);

select is(
  (
    select status || ':' || notification_event || ':' || notification_status
    from public.operational_alerts
    where alert_key = 'cron.stale'
  ),
  'resolved:resolved:pending',
  'recovery is queued as an external resolution signal'
);

reset role;

select ok(
  not has_table_privilege('authenticated', 'public.operational_alerts', 'SELECT'),
  'operational delivery state remains private'
);

select * from finish();

rollback;
