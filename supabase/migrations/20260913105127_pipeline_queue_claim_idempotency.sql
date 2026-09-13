begin;

-- A provider-wide Retry-After must survive the worker process and the next
-- scheduler tick.  Keep it separate from next_enrichment_at: the latter is
-- the normal cadence and is advanced when a worker is dispatched.
alter table public.auction_pipeline_control
  add column if not exists queue_claim_not_before timestamptz;
comment on column public.auction_pipeline_control.queue_claim_not_before is
  'Provider-wide queue claim backoff. Direct service DB writes extend it with GREATEST; claim RPCs return no new lease until it expires.';

-- A request UUID is the idempotency key for one logical queue claim.  The
-- receipt is private and deliberately retains the lease identity rather than
-- re-running the family claim on an ambiguous HTTP response.
create table if not exists app_private.auction_enrichment_claim_receipts (
  request_id uuid primary key,
  family text not null check (family in ('source_detail', 'enrichment')),
  claim_limit integer not null check (claim_limit between 1 and 100),
  created_at timestamptz not null default statement_timestamp(),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'array')
);
create index if not exists auction_enrichment_claim_receipts_created_at_idx
  on app_private.auction_enrichment_claim_receipts(created_at);

comment on table app_private.auction_enrichment_claim_receipts is
  'Private idempotency receipts for queue claims. Snapshot entries contain the leased job id, attempt, and locked_at. Retain for at least the 30-minute lease window; the existing daily data-retention hook purges older history, never during a claim.';
comment on column app_private.auction_enrichment_claim_receipts.snapshot is
  'Ordered JSON array of {ordinal,id,attempt_count,locked_at}; an empty array is a committed empty claim.';

alter table app_private.auction_enrichment_claim_receipts enable row level security;
grant usage on schema app_private to service_role;
revoke all on table app_private.auction_enrichment_claim_receipts from public, anon, authenticated;
grant select, insert, update, delete on table app_private.auction_enrichment_claim_receipts to service_role;
drop policy if exists auction_enrichment_claim_receipts_service_role
  on app_private.auction_enrichment_claim_receipts;
create policy auction_enrichment_claim_receipts_service_role
  on app_private.auction_enrichment_claim_receipts
  for all
  to service_role
  using (true)
  with check (true);

-- The existing data-retention hooks are the bounded history hooks.
-- Keep this out of the claim transaction so replay remains valid for the
-- complete 30-day client request-id retention window.
create or replace function app_private.purge_auction_enrichment_claim_receipts(
  p_now timestamptz default statement_timestamp(),
  p_limit integer default 10000
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint := 0;
begin
  if p_now is null or p_limit is null or p_limit < 1 or p_limit > 100000 then
    raise exception using errcode = '22023',
      message = 'Claim receipt retention requires a timestamp and batch size between 1 and 100000.';
  end if;

  with doomed as (
    select request_id
      from app_private.auction_enrichment_claim_receipts
     where created_at < p_now - interval '30 days'
     order by created_at, request_id
     limit p_limit
  )
  delete from app_private.auction_enrichment_claim_receipts receipt
   using doomed
   where receipt.request_id = doomed.request_id;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

comment on function app_private.purge_auction_enrichment_claim_receipts(timestamptz, integer) is
  'Daily data-retention hook: delete receipts older than 30 days in a bounded batch. Never call from the claim RPC.';
revoke all on function app_private.purge_auction_enrichment_claim_receipts(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function app_private.purge_auction_enrichment_claim_receipts(timestamptz, integer)
  to service_role;

-- Extend the existing daily operational-history job when pg_cron is present;
-- this alters one scheduled command and never creates a second cron entry.
do $cron_retention_patch$
declare
  retention_job_id bigint;
  retention_command text;
begin
  if to_regclass('cron.job') is null then
    return;
  end if;

  execute 'select jobid, command from cron.job where jobname = $1'
    into retention_job_id, retention_command
    using 'immojudis-operational-history-retention';
  if retention_job_id is null or retention_command is null
     or position('purge_auction_enrichment_claim_receipts' in retention_command) > 0 then
    return;
  end if;

  retention_command := rtrim(retention_command);
  if right(retention_command, 1) <> ';' then
    retention_command := retention_command || ';';
  end if;
  retention_command := retention_command ||
    E'\nselect app_private.purge_auction_enrichment_claim_receipts();';
  execute 'select cron.alter_job($1, command := $2)'
    using retention_job_id, retention_command;
end;
$cron_retention_patch$;

-- The lock only serializes concurrent deliveries of one UUID.  It is held for
-- the SQL transaction, never while the worker performs HTTP or OCR.
create or replace function public.claim_auction_enrichment_jobs_request(
  p_request_id uuid,
  p_family text,
  p_limit integer default 1
)
returns setof public.auction_enrichment_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_family text := lower(trim(coalesce(p_family, '')));
  v_limit integer := p_limit;
  v_receipt app_private.auction_enrichment_claim_receipts%rowtype;
  v_snapshot jsonb;
  v_snapshot_count integer;
  v_valid_count integer;
  v_queue_claim_not_before timestamptz;
begin
  if p_request_id is null
     or v_family not in ('source_detail', 'enrichment')
     or v_limit is null
     or v_limit < 1
     or v_limit > 100 then
    raise exception 'Invalid queue claim request arguments'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('immojudis:queue-claim-request:' || p_request_id::text, 0)
  );

  select *
    into v_receipt
    from app_private.auction_enrichment_claim_receipts
   where request_id = p_request_id;

  if found then
    if v_receipt.family <> v_family or v_receipt.claim_limit <> v_limit then
      raise exception 'Queue claim request id already used with different family or limit'
        using errcode = '22023';
    end if;

    -- A request UUID is never allowed to reserve another slot.  Return the
    -- original leases only while every lease is still an exact live lease;
    -- if any member is obsolete, replay is intentionally empty.
    select count(*)
      into v_snapshot_count
      from jsonb_array_elements(v_receipt.snapshot);
    if v_snapshot_count = 0 then
      return;
    end if;

    select count(*)
      into v_valid_count
      from jsonb_array_elements(v_receipt.snapshot) with ordinality as item(value, ordinal)
      join public.auction_enrichment_jobs j
        on j.id = (item.value->>'id')::uuid
       and j.status = 'running'
       and j.attempt_count = (item.value->>'attempt_count')::integer
       and j.locked_at = (item.value->>'locked_at')::timestamptz
       and j.locked_at >= statement_timestamp() - interval '30 minutes';
    if v_valid_count <> v_snapshot_count then
      return;
    end if;

    return query
    select j.*
      from jsonb_array_elements(v_receipt.snapshot) with ordinality as item(value, ordinal)
      join public.auction_enrichment_jobs j
        on j.id = (item.value->>'id')::uuid
       and j.status = 'running'
       and j.attempt_count = (item.value->>'attempt_count')::integer
       and j.locked_at = (item.value->>'locked_at')::timestamptz
       and j.locked_at >= statement_timestamp() - interval '30 minutes'
     order by item.ordinal;
    return;
  end if;

  -- A long provider backoff is persisted outside the worker process.  The
  -- direct DB writer and this RPC use the same short transaction lock, so a
  -- new request cannot slip between the backoff check and the family claim.
  perform pg_advisory_xact_lock(
    hashtextextended('immojudis:queue-claim-backoff', 0)
  );
  select queue_claim_not_before
    into v_queue_claim_not_before
    from public.auction_pipeline_control
   where id;
  if v_queue_claim_not_before is not null
     and v_queue_claim_not_before > statement_timestamp() then
    return;
  end if;

  -- The family RPC and receipt insert are in this same transaction.  A
  -- rollback before the insert leaves the request reusable; once the receipt
  -- commits, all later deliveries are replay-only.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'ordinal', claimed.ordinal,
               'id', claimed.id,
               'attempt_count', claimed.attempt_count,
               'locked_at', claimed.locked_at
             ) order by claimed.ordinal
           ),
           '[]'::jsonb
         )
    into v_snapshot
    from (
      select row_number() over () as ordinal, claimed.*
        from public.claim_auction_enrichment_jobs_family(v_family, v_limit) as claimed
    ) claimed;

  insert into app_private.auction_enrichment_claim_receipts
    (request_id, family, claim_limit, snapshot)
  values (p_request_id, v_family, v_limit, v_snapshot);

  -- Return the same live leases that were recorded in the receipt.  This also
  -- keeps an empty claim a normal successful response.
  select count(*)
    into v_snapshot_count
    from jsonb_array_elements(v_snapshot);
  if v_snapshot_count = 0 then
    return;
  end if;

  return query
  select j.*
    from jsonb_array_elements(v_snapshot) with ordinality as item(value, ordinal)
    join public.auction_enrichment_jobs j
      on j.id = (item.value->>'id')::uuid
     and j.status = 'running'
     and j.attempt_count = (item.value->>'attempt_count')::integer
     and j.locked_at = (item.value->>'locked_at')::timestamptz
     and j.locked_at >= statement_timestamp() - interval '30 minutes'
   order by item.ordinal;
end;
$$;

revoke all on function public.claim_auction_enrichment_jobs_request(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_auction_enrichment_jobs_request(uuid, text, integer)
  to service_role;

commit;
