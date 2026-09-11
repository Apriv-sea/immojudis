-- One deadline for collection and scheduled retention. No guessing on postponed sales.
create or replace function app_private.sale_retention_deadline(
  p_sale_date timestamptz, p_status text, p_procedure jsonb, p_raw jsonb
) returns timestamptz language plpgsql stable security invoker set search_path = '' as $$
declare
  schedule jsonb;
  start_at timestamptz;
  end_at timestamptz;
  raw_date text := coalesce(p_raw->>'sale_date', '');
begin
  if lower(coalesce(p_status,'')) in ('postponed','reported','reportee','reporté','reportée') then return null; end if;
  foreach schedule in array array[p_procedure->'sale_window', p_procedure->'sale_session', p_raw->'source_sale_schedule'] loop
    if schedule is not null and schedule <> 'null'::jsonb then
      begin
        if (schedule->>'opens_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
          or (schedule->>'closes_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
          or schedule->>'opens_at' is null or schedule->>'closes_at' is null then return null; end if;
        start_at := (schedule->>'opens_at')::timestamptz;
        end_at := (schedule->>'closes_at')::timestamptz;
        if not isfinite(start_at) or not isfinite(end_at) or end_at <= start_at then return null; end if;
        return end_at + interval '24 hours';
      exception when invalid_datetime_format or datetime_field_overflow then return null;
      end;
    end if;
  end loop;
  if p_sale_date is null or not isfinite(p_sale_date) then return null; end if;
  -- Date-only source values are normalized to midnight UTC by old collectors.
  -- Recover the Paris civil date before adding exactly 24 elapsed hours.
  if raw_date <> '' and raw_date !~ '[0-9]{1,2}[[:space:]]*([hH]|:[0-9]{2})' then
    return (((p_sale_date at time zone 'UTC')::date)::timestamp at time zone 'Europe/Paris') + interval '24 hours';
  end if;
  return p_sale_date + interval '24 hours';
end;
$$;
revoke all on function app_private.sale_retention_deadline(timestamptz,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function app_private.sale_retention_deadline(timestamptz,text,jsonb,jsonb) to service_role;

-- A transactional outbox: Storage files are removed with the Storage API, never SQL.
create table public.sale_retention_storage_queue (
  id uuid primary key default gen_random_uuid(),
  bucket text not null check (bucket in ('information-agent-evidence','information-agent-approved')),
  object_path text not null check (length(object_path)>0),
  created_at timestamptz not null default now(),
  unique(bucket,object_path)
);
alter table public.sale_retention_storage_queue enable row level security;
revoke all on public.sale_retention_storage_queue from public,anon,authenticated;
grant select,insert,delete on public.sale_retention_storage_queue to service_role;

create or replace function public.purge_expired_auction_sales(p_now timestamptz default statement_timestamp(), p_limit integer default 25)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  sale_row public.auction_sales%rowtype;
  previous_id uuid;
  bridge_result record;
  deleted_count integer := 0;
  remaining_count integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 25 or p_now is null then
    raise exception using errcode='22023',message='Retention requires a timestamp and batch size between 1 and 25.';
  end if;
  -- Same lock order as the existing archival bridge. Protect against concurrent
  -- collection updates while rechecking the deadline, bridging and deleting.
  if not pg_try_advisory_xact_lock(hashtextextended('immojudis:outcome_catalogue_bridge:v1',0)) then
    return jsonb_build_object('deleted',0,'busy',true,'remaining',null);
  end if;
  lock table public.auction_sales in share row exclusive mode;
  for sale_row in
    select * from public.auction_sales s
    where app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload) <= p_now
    order by s.sale_date,s.id limit p_limit
  loop
    select id into previous_id from public.auction_sales where id < sale_row.id order by id desc limit 1;
    select * into bridge_result from public.bridge_auction_sales_to_outcome_graph_batch(previous_id,1);
    if not bridge_result.complete or bridge_result.next_cursor <> sale_row.id then
      raise exception 'Incomplete statistical archive before retention';
    end if;

    insert into public.sale_retention_storage_queue(bucket,object_path)
      select storage_bucket,storage_path from public.information_agent_evidence_assets
      where sale_id=sale_row.id and storage_bucket='information-agent-evidence'
      union
      select 'information-agent-approved', metadata->>'approved_public_path'
      from public.information_agent_evidence_assets where sale_id=sale_row.id
        and nullif(metadata->>'approved_public_path','') is not null
      union
      select 'information-agent-approved',file_path from public.auction_documents
      where source_url=sale_row.source_url and file_path like sale_row.id::text || '/%'
        and document_url like '%/storage/v1/object/public/information-agent-approved/%'
      on conflict(bucket,object_path) do nothing;

    -- These FKs use SET NULL and would otherwise keep personal snapshots.
    delete from public.valuation_estimates where auction_sale_id=sale_row.id;
    delete from public.information_agent_missions where sale_id=sale_row.id;
    delete from public.lawyer_placement_events where sale_id=sale_row.id;
    delete from public.lawyer_referral_requests where sale_id=sale_row.id;
    delete from public.auction_observations where canonical_source_url=sale_row.source_url or source_url=sale_row.source_url;
    -- Reports, simulations/workspaces, favorites, documents, enrichments and
    -- information-agent cases cascade. Outcome Graph lineage remains preserved.
    delete from public.auction_sales where id=sale_row.id;
    deleted_count := deleted_count+1;
  end loop;
  select count(*) into remaining_count from public.auction_sales s
    where app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload) <= p_now;
  return jsonb_build_object('deleted',deleted_count,'remaining',remaining_count,'busy',false);
end;
$$;
revoke all on function public.purge_expired_auction_sales(timestamptz,integer) from public,anon,authenticated;
grant execute on function public.purge_expired_auction_sales(timestamptz,integer) to service_role;

-- Include retention failures/missed runs in the existing operational alert.
do $$
declare definition text;
begin
  definition := pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure);
  if position('(''sale-retention''' in definition)=0 then
    if position('(''data-retention'', interval ''8 days''),' in definition)=0 then
      raise exception 'Operational health expected-jobs list changed; review retention monitoring';
    end if;
    execute replace(definition,
      '(''data-retention'', interval ''8 days''),',
      '(''data-retention'', interval ''8 days''), (''sale-retention'', interval ''20 minutes''),');
  end if;
end $$;
