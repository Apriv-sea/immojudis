begin;
alter table public.auction_pipeline_control add column source_details_enabled boolean not null default false;
alter table public.auction_enrichment_jobs drop constraint auction_enrichment_jobs_job_type_check;
alter table public.auction_enrichment_jobs add constraint auction_enrichment_jobs_job_type_check
  check(job_type in ('pdf','fact_extraction','display_description','source_detail'));
alter table public.auction_enrichment_jobs add column detail_source_name text references public.auction_source_state(source_name);
alter table public.auction_enrichment_jobs add column detail_source_url text;
alter table public.auction_enrichment_jobs add constraint auction_enrichment_detail_identity_check
  check(job_type<>'source_detail' or (detail_source_name is not null and detail_source_url is not null));

create function app_private.pipeline_checked_at(p_value text,p_now timestamptz)
returns timestamptz language plpgsql stable set search_path='' as $$
declare checked timestamptz;
begin
  checked := p_value::timestamptz;
  return case when checked<=p_now then checked else null end;
exception when invalid_datetime_format or datetime_field_overflow then return null;
end;
$$;
revoke all on function app_private.pipeline_checked_at(text,timestamptz) from public,anon,authenticated;
grant execute on function app_private.pipeline_checked_at(text,timestamptz) to service_role;

create function public.enqueue_due_source_details(p_now timestamptz default now(),p_limit integer default 500)
returns integer language plpgsql security invoker set search_path='' as $$
declare inserted integer;
begin
  if not exists(select 1 from public.auction_pipeline_control where id and enabled and source_details_enabled) then return 0; end if;
  with candidates as (
    select s.source_url as canonical_url,u.source_name,u.source_url,
      app_private.pipeline_checked_at(s.raw_payload->'source_checks'->u.source_url->>'checked_at',p_now) as checked,
      case when s.sale_date between p_now and p_now+interval '7 days' then interval '5 hours' else interval '23 hours' end as cadence
    from public.auction_sales s cross join lateral (
      select s.source_name,s.source_url
      union select o.value->>'source_name',o.value->>'source_url'
        from jsonb_array_elements(case when jsonb_typeof(s.observations)='array' then s.observations else '[]'::jsonb end) o
      union select c.value->>'source_name',c.key
        from jsonb_each(case when jsonb_typeof(s.raw_payload->'source_checks')='object' then s.raw_payload->'source_checks' else '{}'::jsonb end) c
    ) u join public.auction_source_state state on state.source_name=u.source_name
    where s.status in ('active','upcoming','postponed','unknown') and u.source_url is not null
      and state.enabled and (state.suspended_until is null or state.suspended_until<=p_now)
      and (app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload) is null
        or app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload)>p_now)
  ), due as (
    select *, 'source_detail_v1:'||md5(source_name||':'||source_url||':'||coalesce(extract(epoch from checked)::text,'never')||':'||(p_now at time zone 'UTC')::date::text) as signature
    from candidates where checked is null or checked+cadence<=p_now
  ), chosen as (
    select d.* from due d where not exists(
      select 1 from public.auction_enrichment_jobs j where j.source_url=d.canonical_url and j.job_type='source_detail'
        and j.detail_source_name=d.source_name and j.detail_source_url=d.source_url
        and (j.input_hash=d.signature or j.status in ('queued','running') or (j.status='failed' and j.attempt_count<j.max_attempts))
    ) order by checked nulls first,canonical_url,source_name,source_url limit greatest(1,least(p_limit,1000))
  ) insert into public.auction_enrichment_jobs(source_url,job_type,input_hash,detail_source_name,detail_source_url,priority)
    select canonical_url,'source_detail',signature,source_name,source_url,100 from chosen
    on conflict(source_url,job_type,input_hash) do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;
revoke all on function public.enqueue_due_source_details(timestamptz,integer) from public,anon,authenticated;
grant execute on function public.enqueue_due_source_details(timestamptz,integer) to service_role;

create or replace function public.claim_auction_enrichment_jobs(p_limit integer default 10)
returns setof public.auction_enrichment_jobs language plpgsql security invoker set search_path='' as $$
begin
  update public.auction_enrichment_jobs j set status='cancelled',locked_at=null,updated_at=now(),
    last_error='Listing removed, expired or explicitly cancelled'
    where (j.status in ('queued','failed') or (j.status='running' and coalesce(j.locked_at,j.updated_at)<now()-interval '30 minutes'))
      and not exists(select 1 from public.auction_sales s where s.source_url=j.source_url
        and s.status in ('active','unknown','upcoming','postponed','past')
        and (app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload) is null
          or app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload)>now()));

  with ranked as (
    select id,row_number() over(partition by source_url,job_type,detail_source_name,detail_source_url order by created_at desc,
      (input_hash like 'pipeline_v2:%') desc,id desc) revision_rank
    from public.auction_enrichment_jobs where status<>'cancelled'
  ) update public.auction_enrichment_jobs j set status='cancelled',locked_at=null,updated_at=now(),
      last_error='Superseded by a newer input revision'
    from ranked r where r.id=j.id and r.revision_rank>1 and
      (j.status in ('queued','failed') or (j.status='running' and coalesce(j.locked_at,j.updated_at)<now()-interval '30 minutes'));

  update public.auction_enrichment_jobs set status='failed',locked_at=null,updated_at=now(),
    last_error='Worker lease expired and retry budget exhausted'
    where status='running' and coalesce(locked_at,updated_at)<now()-interval '30 minutes' and attempt_count>=max_attempts;

  return query with candidates as (
    select j.id from public.auction_enrichment_jobs j join public.auction_sales s on s.source_url=j.source_url
    where (j.status in ('queued','failed') or (j.status='running' and coalesce(j.locked_at,j.updated_at)<now()-interval '30 minutes'))
      and j.next_attempt_at<=now() and j.attempt_count<j.max_attempts
      and (j.job_type<>'source_detail' or (exists(select 1 from public.auction_pipeline_control where id and enabled and source_details_enabled)
        and exists(select 1 from public.auction_source_state state where state.source_name=j.detail_source_name
          and state.enabled and (state.suspended_until is null or state.suspended_until<=now()))))
      and s.status in ('active','unknown','upcoming','postponed','past')
      and (app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload) is null
        or app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload)>now())
      and not exists(select 1 from public.auction_enrichment_jobs active where active.source_url=j.source_url
        and active.status='running' and coalesce(active.locked_at,active.updated_at)>=now()-interval '30 minutes')
    order by (j.job_type='source_detail') desc, (s.sale_date between now() and now()+interval '7 days') desc,
      j.priority + extract(epoch from (now()-j.created_at))/3600 desc,j.created_at,j.id
    for update of j,s skip locked limit greatest(1,least(coalesce(p_limit,10),100))
  ) update public.auction_enrichment_jobs j set status='running',attempt_count=j.attempt_count+1,
      locked_at=statement_timestamp(),updated_at=statement_timestamp(),last_error=null
    from candidates c where c.id=j.id returning j.*;
end;
$$;
revoke all on function public.claim_auction_enrichment_jobs(integer) from public,anon,authenticated;
grant execute on function public.claim_auction_enrichment_jobs(integer) to service_role;

create or replace function public.claim_autonomous_pipeline_run()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  chosen text;
  run_uuid uuid;
  worker_due timestamptz;
  selected_mode text;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('immojudis-pipeline-dispatch',0)) then return null; end if;
  select next_enrichment_at into worker_due from public.auction_pipeline_control where id and enabled for update;
  if not found then return null; end if;
  perform public.enqueue_due_source_details(now(),500);
  -- Bounded automatic jobs expire after 60 min; legacy manual jobs after their
  -- existing 180-minute runner limit plus grace. Preserve committed evidence.
  update public.auction_runs set status='failed',finished_at=now(),updated_at=now(),
    summary=coalesce(summary,'{}') || '{"completion_status":"lease_expired"}',
    errors=coalesce(errors,'{}') || '{"runner":["Execution lease expired; committed batches preserved"]}'
  where status in ('queued','running') and coalesce(started_at,created_at) <
    now() - case when scheduler_owned then interval '60 minutes' else interval '190 minutes' end;
  if exists(select 1 from public.auction_runs where status in ('queued','running')) then return null; end if;
  update public.auction_source_state s set next_inventory_at=least(s.next_inventory_at,now())
    from public.auction_runs r where r.id=s.last_run_id and r.summary->>'completion_status'='lease_expired';
  select source_name into chosen from public.auction_source_state
    where enabled and (suspended_until is null or suspended_until<=now()) and next_inventory_at<=now()
    order by next_inventory_at,source_name limit 1 for update skip locked;
  if chosen is null or worker_due < now()-interval '30 minutes' then
    if worker_due > now() then return null; end if;
    if exists(select 1 from public.auction_enrichment_jobs where status in ('queued','running','failed')
              and attempt_count<max_attempts and next_attempt_at<=now()) then
      chosen := 'enrichment-queue';
    elsif chosen is null then
      update public.auction_pipeline_control set next_enrichment_at=now()+interval '30 minutes' where id;
      return null;
    end if;
  end if;
  selected_mode := case when chosen='enrichment-queue' then 'enrichment' else 'collect' end;
  insert into public.auction_runs(status,source,use_llm,scheduler_owned,summary,errors)
    values('queued',chosen,false,true,jsonb_build_object('trigger','autonomous','mode',selected_mode),'{}')
    returning id into run_uuid;
  if selected_mode='collect' then
    update public.auction_source_state set last_run_id=run_uuid,last_attempt_at=now(),
      next_inventory_at=now()+interval '6 hours',updated_at=now() where source_name=chosen;
  else
    update public.auction_pipeline_control set next_enrichment_at=now()+interval '30 minutes' where id;
  end if;
  update public.auction_pipeline_control set last_dispatch_at=now(),updated_at=now() where id;
  return jsonb_build_object('id',run_uuid,'source',chosen,'mode',selected_mode);
end;
$$;
revoke all on function public.claim_autonomous_pipeline_run() from public,anon,authenticated;
grant execute on function public.claim_autonomous_pipeline_run() to service_role;

commit;
