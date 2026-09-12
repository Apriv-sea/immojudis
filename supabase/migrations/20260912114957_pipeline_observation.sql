begin;
create table public.auction_pipeline_observations (
  id bigint generated always as identity primary key,
  observed_at timestamptz not null default now(),
  source_name text not null,
  metrics jsonb not null
);
create index auction_pipeline_observations_source_time on public.auction_pipeline_observations(source_name,observed_at desc);
alter table public.auction_pipeline_observations enable row level security;
revoke all on public.auction_pipeline_observations from public,anon,authenticated;
grant select,insert,delete on public.auction_pipeline_observations to service_role;
grant usage,select on sequence public.auction_pipeline_observations_id_seq to service_role;
create or replace function app_private.sync_operational_alert(
  p_alert_key text,
  p_category text,
  p_severity text,
  p_details jsonb,
  p_active boolean,
  p_now timestamptz default statement_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_alert public.operational_alerts%rowtype;
  should_notify boolean;
  next_event text;
begin
  select * into current_alert
  from public.operational_alerts
  where alert_key = p_alert_key
  for update;

  if p_active then
    if not found then
      insert into public.operational_alerts (
        alert_key,
        category,
        severity,
        status,
        details,
        first_seen_at,
        last_seen_at,
        notification_event,
        notification_status,
        notification_next_attempt_at
      ) values (
        p_alert_key,
        p_category,
        p_severity,
        'open',
        coalesce(p_details, '{}'::jsonb),
        p_now,
        p_now,
        'opened',
        'pending',
        p_now
      );
      return;
    end if;

    -- A single notification per incident; delivery failures keep their retry state.
    should_notify := current_alert.status = 'resolved';
    next_event := case when current_alert.status = 'resolved' then 'opened' else 'updated' end;

    update public.operational_alerts
    set
      category = p_category,
      severity = p_severity,
      status = 'open',
      details = coalesce(p_details, '{}'::jsonb),
      occurrence_count = occurrence_count + 1,
      last_seen_at = p_now,
      resolved_at = null,
      notification_event = case when should_notify then next_event else notification_event end,
      notification_status = case when should_notify then 'pending' else notification_status end,
      notification_version = case
        when should_notify then notification_version + 1
        else notification_version
      end,
      notification_attempt_count = case when should_notify then 0 else notification_attempt_count end,
      notification_next_attempt_at = case
        when should_notify then p_now
        else notification_next_attempt_at
      end,
      notification_claimed_at = case when should_notify then null else notification_claimed_at end,
      notification_error = case when should_notify then null else notification_error end
    where alert_key = p_alert_key;
    return;
  end if;

  if found and current_alert.status = 'open' then
    update public.operational_alerts
    set
      status = 'resolved',
      last_seen_at = p_now,
      resolved_at = p_now,
      notification_event = 'resolved',
      notification_status = 'pending',
      notification_version = notification_version + 1,
      notification_attempt_count = 0,
      notification_next_attempt_at = p_now,
      notification_claimed_at = null,
      notification_error = null
    where alert_key = p_alert_key;
  end if;
end;
$$;

revoke all on function app_private.sync_operational_alert(
  text, text, text, jsonb, boolean, timestamptz
) from public, anon, authenticated, service_role;


create or replace function public.observe_autonomous_pipeline(p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  source_row record;
  evidence jsonb;
  backlog integer;
  delayed integer;
  failed_publication integer;
  baseline numeric;
  inventory_count integer;
  total integer;
  fresh integer;
  checked record;
  checked_at timestamptz;
  alert_active boolean;
  enabled_at timestamptz;
  latency_p95 numeric;
  decisions jsonb;
  run_summary jsonb;
  inventory_complete boolean;
begin
  delete from public.auction_collection_checkpoints where observed_at<p_now-interval '24 hours';
  select observation_started_at into enabled_at from public.auction_pipeline_control where id and enabled;
  if not found then return jsonb_build_object('enabled',false); end if;
  for source_row in select * from public.auction_source_state loop
    select count(*) into inventory_count from public.auction_collection_items where run_id=source_row.last_run_id;
    select count(*) into failed_publication from public.auction_collection_items
      where run_id=source_row.last_run_id and decision='publication_failed';
    select avg((metrics->>'inventory_count')::numeric) into baseline from (
      select metrics from (
        select distinct on (metrics->>'run_id') metrics,observed_at
        from public.auction_pipeline_observations
        where source_name=source_row.source_name and metrics->>'inventory_complete'='true'
          and metrics->>'run_id' is distinct from source_row.last_run_id::text
        order by metrics->>'run_id',observed_at desc
      ) distinct_runs order by observed_at desc limit 28
    ) recent;
    total := 0; fresh := 0;
    for checked in select sale_date,raw_payload from public.auction_sales where source_name=source_row.source_name
      and status in ('active','upcoming','postponed','unknown') loop
      total := total+1; checked_at := null;
      begin
        select max((item.value->>'checked_at')::timestamptz) into checked_at
          from jsonb_each(case when jsonb_typeof(checked.raw_payload->'source_checks')='object'
            then checked.raw_payload->'source_checks' else '{}'::jsonb end) item;
      exception when invalid_datetime_format or datetime_field_overflow then checked_at := null;
      end;
      if checked_at <= p_now and checked_at >= p_now-(case when checked.sale_date between p_now and p_now+interval '7 days'
        then interval '6 hours' else interval '24 hours' end) then fresh := fresh+1; end if;
    end loop;
    select percentile_cont(0.95) within group(order by extract(epoch from published_at-discovered_at)) into latency_p95
      from public.auction_collection_items where run_id=source_row.last_run_id and published_at is not null;
    select coalesce(jsonb_object_agg(decision,n),'{}') into decisions from
      (select decision,count(*) n from public.auction_collection_items where run_id=source_row.last_run_id group by decision) counts;
    select summary, finished_at is not null and coalesce((source_row.coverage->>'coverage_complete')::boolean,false)
      into run_summary,inventory_complete from public.auction_runs where id=source_row.last_run_id;
    evidence := jsonb_build_object('enabled',source_row.enabled,'availability',source_row.availability,
      'run_id',source_row.last_run_id,'inventory_count',inventory_count,
      'inventory_complete',coalesce(inventory_complete,false),
      'last_inventory_complete_at',source_row.last_inventory_complete_at,
      'last_publication_complete_at',source_row.last_publication_complete_at,
      'active_listings',total,'fresh_listings',fresh,'freshness_ratio',case when total>0 then fresh::numeric/total else null end,
      'failed_publication',failed_publication,'inventory_baseline',baseline,'decisions',decisions,
      'discovery_to_publication_p95_seconds',latency_p95,'execution_seconds',run_summary->'execution_seconds',
      'http_attempts',source_row.coverage->'http_attempts_including_retries');
    insert into public.auction_pipeline_observations(source_name,observed_at,metrics)
      values(source_row.source_name,p_now,evidence);
    alert_active := source_row.enabled and coalesce(source_row.last_inventory_complete_at,enabled_at,source_row.updated_at)<p_now-interval '12 hours';
    perform app_private.sync_operational_alert('pipeline.source.'||source_row.source_name||'.missed','import','critical',evidence,alert_active,p_now);
    perform app_private.sync_operational_alert('pipeline.source.'||source_row.source_name||'.drop','import','warning',evidence,
      source_row.enabled and baseline>=10 and coalesce(inventory_complete,false) and inventory_count<baseline*0.7,p_now);
    perform app_private.sync_operational_alert('pipeline.source.'||source_row.source_name||'.publication','import','critical',evidence,
      source_row.enabled and failed_publication>0,p_now);
  end loop;
  select count(*),count(*) filter(where created_at<p_now-interval '24 hours') into backlog,delayed
    from public.auction_enrichment_jobs where status in ('queued','running','failed');
  evidence := jsonb_build_object('backlog',backlog,'older_than_24h',delayed);
  insert into public.auction_pipeline_observations(source_name,observed_at,metrics) values('enrichment-queue',p_now,evidence);
  perform app_private.sync_operational_alert('pipeline.enrichment.stalled','import','warning',evidence,delayed>0,p_now);
  -- Aggregated operation metrics follow the existing 90-day operational history policy.
  delete from public.auction_pipeline_observations where observed_at<p_now-interval '90 days';
  return jsonb_build_object('enabled',true,'queue',evidence);
end;
$$;
revoke all on function public.observe_autonomous_pipeline(timestamptz) from public,anon,authenticated;
grant execute on function public.observe_autonomous_pipeline(timestamptz) to service_role;
create or replace function app_private.invoke_operational_health_endpoint()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint_url text;
  cron_secret text;
  request_id bigint;
begin
  select decrypted_secret into endpoint_url
  from vault.decrypted_secrets
  where name = 'immojudis_operational_health_url'
  order by updated_at desc
  limit 1;

  select decrypted_secret into cron_secret
  from vault.decrypted_secrets
  where name = 'immojudis_operational_health_secret'
  order by updated_at desc
  limit 1;

  if nullif(pg_catalog.btrim(endpoint_url), '') is null
    or nullif(pg_catalog.btrim(cron_secret), '') is null then
    raise warning 'ImmoJudis operational health Vault secrets are not configured.';
    return null;
  end if;

  select net.http_get(
    url => pg_catalog.rtrim(endpoint_url, '/') || '/api/cron/operational-health',
    headers => jsonb_build_object(
      'Authorization', 'Bearer ' || cron_secret,
      'Accept', 'application/json',
      'User-Agent', 'immojudis-supabase-cron/1.0'
    ),
    timeout_milliseconds => 30000
  ) into request_id;

  return request_id;
end;
$$;
commit;
