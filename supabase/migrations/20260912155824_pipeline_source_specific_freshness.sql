begin;
-- Measure a source's own observations, including its merged catalogue aliases.
create or replace function public.auction_source_freshness(p_source text,p_now timestamptz default now())
returns table(active_listings bigint,fresh_listings bigint)
language plpgsql stable security definer set search_path='' as $$
declare
  sale_row record;
  item record;
  checked_at timestamptz;
  candidate timestamptz;
begin
  active_listings := 0; fresh_listings := 0;
  for sale_row in
    select s.sale_date,s.raw_payload,array(
      select s.source_url where s.source_name=p_source
      union select o.value->>'source_url'
        from jsonb_array_elements(case when jsonb_typeof(s.observations)='array' then s.observations else '[]'::jsonb end) o
        where o.value->>'source_name'=p_source and o.value->>'source_url' is not null
      union select c.key from jsonb_each(case when jsonb_typeof(s.raw_payload->'source_checks')='object'
        then s.raw_payload->'source_checks' else '{}'::jsonb end) c where c.value->>'source_name'=p_source
    ) as source_urls
    from public.auction_sales s where s.status in ('active','upcoming','postponed','unknown')
  loop
    if cardinality(sale_row.source_urls)=0 then continue; end if;
    active_listings := active_listings+1;
    checked_at := null;
    for item in select * from jsonb_each(case when jsonb_typeof(sale_row.raw_payload->'source_checks')='object'
      then sale_row.raw_payload->'source_checks' else '{}'::jsonb end)
      where key=any(sale_row.source_urls)
    loop
      begin
        candidate := (item.value->>'checked_at')::timestamptz;
        if candidate<=p_now then checked_at := greatest(checked_at,candidate); end if;
      exception when invalid_datetime_format or datetime_field_overflow then null;
      end;
    end loop;
    if checked_at>=p_now-(case when sale_row.sale_date between p_now and p_now+interval '7 days'
      then interval '6 hours' else interval '24 hours' end) then fresh_listings := fresh_listings+1; end if;
  end loop;
  return next;
end;
$$;
revoke all on function public.auction_source_freshness(text,timestamptz) from public,anon,authenticated;
grant execute on function public.auction_source_freshness(text,timestamptz) to service_role;
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
    select f.active_listings,f.fresh_listings into total,fresh
      from public.auction_source_freshness(source_row.source_name,p_now) f;
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
commit;
