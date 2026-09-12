begin;
alter table public.auction_runs add column scheduler_owned boolean not null default false;
create table public.auction_pipeline_control (
  id boolean primary key default true check(id),
  enabled boolean not null default false,
  next_enrichment_at timestamptz not null default now(),
  last_dispatch_at timestamptz,
  observation_started_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.auction_pipeline_control(id) values(true);
alter table public.auction_pipeline_control enable row level security;
revoke all on public.auction_pipeline_control from public,anon,authenticated;
grant select,update on public.auction_pipeline_control to service_role;

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
