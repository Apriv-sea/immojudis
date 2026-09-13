begin;

-- The dispatcher is called by the 15-minute operational-health tick.  A
-- dispatch attempt is deliberately kept in the run summary: the run itself
-- is the idempotency key, while the row lock below serializes the scheduler.
create or replace function public.claim_autonomous_pipeline_run()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  chosen text;
  run_uuid uuid;
  worker_due timestamptz;
  selected_mode text;
  active_id uuid;
  active_source text;
  active_status text;
  active_scheduler_owned boolean;
  active_summary jsonb;
  dispatch jsonb;
  dispatch_state text;
  dispatch_attempt integer;
  dispatch_max_attempts integer;
  dispatch_next_at timestamptz;
  dispatch_lease_until timestamptz;
  dispatch_lease_text text;
  now_at timestamptz := statement_timestamp();
begin
  if not pg_try_advisory_xact_lock(hashtextextended('immojudis-pipeline-dispatch',0)) then return null; end if;
  select next_enrichment_at into worker_due
    from public.auction_pipeline_control where id and enabled for update;
  if not found then return null; end if;
  perform public.enqueue_due_source_details(now_at,500);

  -- A manual run keeps the legacy 190-minute lease.  A running automatic
  -- worker keeps the existing 60-minute execution lease.  A queued automatic
  -- run uses the dispatch lease recorded in its summary, so a long
  -- Retry-After or an accepted workflow cannot be expired before the next
  -- scheduler decision.
  update public.auction_runs r set status='failed',finished_at=now_at,updated_at=now_at,
    summary=coalesce(r.summary,'{}') || '{"completion_status":"lease_expired"}',
    errors=coalesce(r.errors,'{}') || '{"runner":["Execution lease expired; committed batches preserved"]}'
  where r.status in ('queued','running')
    and (
      (not r.scheduler_owned and coalesce(r.started_at,r.created_at) <
        now_at-interval '190 minutes')
      or (r.scheduler_owned and r.status='running' and
        coalesce(r.started_at,r.created_at) < now_at-interval '60 minutes')
      or (r.scheduler_owned and r.status='queued' and
        case
          when r.summary #>> '{github_dispatch,lease_until}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'
            then (r.summary #>> '{github_dispatch,lease_until}')::timestamptz
          else coalesce(r.created_at,now_at)+interval '60 minutes'
        end < now_at
        )
    );

  -- Reclaim the existing automatic row for a retry.  The row lock and the
  -- advisory lock make the increment a compare-and-set for scheduler ticks.
  select r.id,r.source,r.status,r.scheduler_owned,coalesce(r.summary,'{}')
    into active_id,active_source,active_status,active_scheduler_owned,active_summary
    from public.auction_runs r
    where r.status in ('queued','running')
    order by r.created_at,r.id
    limit 1 for update;

  if active_id is not null then
    if active_status='running' or not active_scheduler_owned then return null; end if;

    dispatch := coalesce(active_summary->'github_dispatch','{}'::jsonb);
    dispatch_state := coalesce(dispatch->>'state','legacy');
    dispatch_max_attempts := least(case
      when coalesce(dispatch->>'max_attempts','') ~ '^[1-9][0-9]*$'
        then (dispatch->>'max_attempts')::integer
      else 4
    end,4);
    dispatch_attempt := case
      when coalesce(dispatch->>'attempt','') ~ '^[0-9]+$'
        then (dispatch->>'attempt')::integer
      -- A queued automatic row created by the previous migration already
      -- represents an initial dispatch attempt, although it has no metadata.
      else case when dispatch_state='legacy' then 1 else 0 end
    end;
    dispatch_next_at := case
      when dispatch->>'next_attempt_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'
        then (dispatch->>'next_attempt_at')::timestamptz
      else case when dispatch_state='legacy' then
        coalesce((select created_at from public.auction_runs where id=active_id),now_at)+interval '15 minutes'
      end
    end;

    if dispatch_state in ('accepted','terminal','exhausted')
      or dispatch_attempt >= dispatch_max_attempts
      or dispatch_next_at is null or dispatch_next_at > now_at then
      return null;
    end if;

    dispatch_attempt := dispatch_attempt + 1;
    dispatch_lease_text := dispatch->>'lease_until';
    dispatch_lease_until := case
      when dispatch_lease_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'
        then greatest(dispatch_lease_text::timestamptz,now_at+interval '60 minutes')
      else now_at+interval '60 minutes'
    end;
    dispatch := dispatch || jsonb_build_object(
      'version',1,
      'attempt',dispatch_attempt,
      'max_attempts',dispatch_max_attempts,
      'state','in_flight',
      'attempt_started_at',now_at,
      -- This default also covers an HTTP timeout before the result RPC can
      -- persist the actual Retry-After value.
      'next_attempt_at',now_at+interval '15 minutes',
      'lease_until',dispatch_lease_until
    );
    update public.auction_runs set summary=active_summary ||
        jsonb_build_object('github_dispatch',dispatch),updated_at=now_at
      where id=active_id and status='queued';
    return jsonb_build_object('id',active_id,'source',active_source,
      'mode',case when active_source='enrichment-queue' then 'enrichment' else 'collect' end,
      'attempt',dispatch_attempt,'max_attempts',dispatch_max_attempts);
  end if;

  update public.auction_source_state s set next_inventory_at=least(s.next_inventory_at,now_at)
    from public.auction_runs r where r.id=s.last_run_id and r.summary->>'completion_status'='lease_expired';
  select source_name into chosen from public.auction_source_state
    where enabled and (suspended_until is null or suspended_until<=now_at) and next_inventory_at<=now_at
    order by next_inventory_at,source_name limit 1 for update skip locked;
  if chosen is null or worker_due < now_at-interval '30 minutes' then
    if worker_due > now_at then return null; end if;
    if exists(select 1 from public.auction_enrichment_jobs where status in ('queued','running','failed')
              and attempt_count<max_attempts and next_attempt_at<=now_at) then
      chosen := 'enrichment-queue';
    elsif chosen is null then
      update public.auction_pipeline_control set next_enrichment_at=now_at+interval '30 minutes' where id;
      return null;
    end if;
  end if;

  selected_mode := case when chosen='enrichment-queue' then 'enrichment' else 'collect' end;
  insert into public.auction_runs(status,source,use_llm,scheduler_owned,summary,errors)
    values('queued',chosen,false,true,
      jsonb_build_object('trigger','autonomous','mode',selected_mode,
        'github_dispatch',jsonb_build_object(
          'version',1,'attempt',1,'max_attempts',4,'state','in_flight',
          'attempt_started_at',now_at,
          'next_attempt_at',now_at+interval '15 minutes',
          'lease_until',now_at+interval '60 minutes')),'{}')
    returning id into run_uuid;
  if selected_mode='collect' then
    update public.auction_source_state set last_run_id=run_uuid,last_attempt_at=now_at,
      next_inventory_at=now_at+interval '6 hours',updated_at=now_at where source_name=chosen;
  else
    update public.auction_pipeline_control set next_enrichment_at=now_at+interval '30 minutes' where id;
  end if;
  update public.auction_pipeline_control set last_dispatch_at=now_at,updated_at=now_at where id;
  return jsonb_build_object('id',run_uuid,'source',chosen,'mode',selected_mode,'attempt',1,'max_attempts',4);
end;
$$;
revoke all on function public.claim_autonomous_pipeline_run() from public,anon,authenticated;
grant execute on function public.claim_autonomous_pipeline_run() to service_role;

create or replace function public.record_autonomous_pipeline_dispatch(
  p_run_id uuid,
  p_attempt integer,
  p_outcome text,
  p_status integer default null,
  p_retry_after_at timestamptz default null,
  p_retryable boolean default true,
  p_error text default null
)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  current_status text;
  current_summary jsonb;
  current_dispatch jsonb;
  current_attempt integer;
  max_attempts integer;
  retry_at timestamptz;
  existing_lease_until timestamptz;
  lease_until timestamptz;
  next_state text;
  next_attempt_at timestamptz;
begin
  if p_outcome not in ('accepted','rejected','unknown') then
    raise exception 'Invalid autonomous dispatch outcome';
  end if;
  if p_attempt is null or p_attempt < 1 then
    raise exception 'Invalid autonomous dispatch attempt';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('immojudis-pipeline-dispatch',0));
  select status,coalesce(summary,'{}') into current_status,current_summary
    from public.auction_runs where id=p_run_id for update;
  if not found then
    return jsonb_build_object('updated',false,'reason','missing');
  end if;
  if current_status<>'queued' then
    return jsonb_build_object('updated',false,'reason','worker_or_terminal_state','status',current_status);
  end if;

  current_dispatch := coalesce(current_summary->'github_dispatch','{}'::jsonb);
  current_attempt := case
    when coalesce(current_dispatch->>'attempt','') ~ '^[0-9]+$'
      then (current_dispatch->>'attempt')::integer
    else 0
  end;
  if current_attempt<>p_attempt then
    return jsonb_build_object('updated',false,'reason','stale_attempt','attempt',current_attempt);
  end if;
  if coalesce(current_dispatch->>'state','legacy')<>'in_flight' then
    return jsonb_build_object('updated',false,'reason','result_already_recorded',
      'state',coalesce(current_dispatch->>'state','legacy'));
  end if;
  max_attempts := least(case
    when coalesce(current_dispatch->>'max_attempts','') ~ '^[1-9][0-9]*$'
      then (current_dispatch->>'max_attempts')::integer
    else 4
  end,4);

  existing_lease_until := case
    when current_dispatch->>'lease_until' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'
      then (current_dispatch->>'lease_until')::timestamptz
    else now()+interval '60 minutes'
  end;

  if p_outcome='accepted' then
    next_state := 'accepted';
    next_attempt_at := null;
    lease_until := existing_lease_until;
  elsif not p_retryable or p_attempt>=max_attempts then
    next_state := 'terminal';
    next_attempt_at := null;
    lease_until := greatest(existing_lease_until,
      coalesce(p_retry_after_at,now())+interval '60 minutes');
  else
    next_state := 'retry_wait';
    retry_at := greatest(now()+interval '15 minutes',coalesce(p_retry_after_at,now()+interval '15 minutes'));
    next_attempt_at := retry_at;
    lease_until := greatest(existing_lease_until,retry_at+interval '60 minutes');
  end if;

  current_dispatch := current_dispatch || jsonb_build_object(
    'version',1,
    'attempt',p_attempt,
    'max_attempts',max_attempts,
    'state',next_state,
    'last_outcome',p_outcome,
    'last_status',p_status,
    'last_error',left(coalesce(p_error,''),1000),
    'retry_after_at',p_retry_after_at,
    'next_attempt_at',next_attempt_at,
    'lease_until',lease_until,
    'result_at',now()
  );
  update public.auction_runs set
    summary=current_summary || jsonb_build_object('github_dispatch',current_dispatch),
    errors=case when p_outcome='accepted' then coalesce(errors,'{}') - 'github_dispatch'
      when p_error is null or p_error='' then errors
      else coalesce(errors,'{}') || jsonb_build_object('github_dispatch',left(p_error,1000)) end,
    updated_at=now()
    where id=p_run_id and status='queued';
  return jsonb_build_object('updated',true,'run_id',p_run_id,'attempt',p_attempt,
    'state',next_state,'next_attempt_at',next_attempt_at);
end;
$$;
revoke all on function public.record_autonomous_pipeline_dispatch(uuid,integer,text,integer,timestamptz,boolean,text)
  from public,anon,authenticated;
grant execute on function public.record_autonomous_pipeline_dispatch(uuid,integer,text,integer,timestamptz,boolean,text)
  to service_role;

commit;
