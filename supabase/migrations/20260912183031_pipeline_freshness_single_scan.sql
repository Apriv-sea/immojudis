begin;
create or replace function app_private.pipeline_checked_at(p_value text)
returns timestamptz language plpgsql stable set search_path='' as $$
begin
  return p_value::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow then return null;
end;
$$;
revoke all on function app_private.pipeline_checked_at(text) from public,anon,authenticated,service_role;

create or replace function public.auction_all_source_freshness(p_now timestamptz default now())
returns table(source_name text,active_listings bigint,fresh_listings bigint)
language sql stable security definer set search_path='' as $$
  with base as materialized (
    select s.source_url,s.source_name,s.sale_date,
      case when jsonb_typeof(s.observations)='array' then s.observations else '[]'::jsonb end as observations,
      case when jsonb_typeof(s.raw_payload->'source_checks')='object'
        then s.raw_payload->'source_checks' else '{}'::jsonb end as checks
    from public.auction_sales s where s.status in ('active','upcoming','postponed','unknown')
  ), links as (
    select b.source_url as canonical_url,b.source_name,b.source_url as checked_url from base b
    union select b.source_url,o.value->>'source_name',o.value->>'source_url'
      from base b cross join lateral jsonb_array_elements(b.observations) o
    union select b.source_url,c.value->>'source_name',c.key
      from base b cross join lateral jsonb_each(b.checks) c
  ), latest as (
    select l.canonical_url,l.source_name,b.sale_date,
      max(app_private.pipeline_checked_at(b.checks->l.checked_url->>'checked_at'))
        filter(where app_private.pipeline_checked_at(b.checks->l.checked_url->>'checked_at')<=p_now) as checked_at
    from links l join base b on b.source_url=l.canonical_url
    where l.source_name is not null and l.checked_url is not null
    group by l.canonical_url,l.source_name,b.sale_date
  )
  select l.source_name,count(*),count(*) filter(where l.checked_at>=p_now-
    case when l.sale_date between p_now and p_now+interval '7 days' then interval '6 hours' else interval '24 hours' end)
  from latest l group by l.source_name;
$$;
revoke all on function public.auction_all_source_freshness(timestamptz) from public,anon,authenticated;
grant execute on function public.auction_all_source_freshness(timestamptz) to service_role;

create or replace function public.auction_source_freshness(p_source text,p_now timestamptz default now())
returns table(active_listings bigint,fresh_listings bigint)
language sql stable security definer set search_path='' as $$
  select coalesce(max(f.active_listings),0),coalesce(max(f.fresh_listings),0)
    from public.auction_all_source_freshness(p_now) f where f.source_name=p_source;
$$;
revoke all on function public.auction_source_freshness(text,timestamptz) from public,anon,authenticated;
grant execute on function public.auction_source_freshness(text,timestamptz) to service_role;
create or replace function public.observe_autonomous_pipeline(p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  source_row record;
  freshness_counts jsonb;
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
  select coalesce(jsonb_object_agg(f.source_name,jsonb_build_object('active',f.active_listings,'fresh',f.fresh_listings)),'{}')
    into freshness_counts from public.auction_all_source_freshness(p_now) f;
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
    total := coalesce((freshness_counts->source_row.source_name->>'active')::integer,0);
    fresh := coalesce((freshness_counts->source_row.source_name->>'fresh')::integer,0);
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
