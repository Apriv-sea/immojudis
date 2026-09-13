begin;

-- Keep the source-detail lane fair without changing the legacy queue families.
-- A claim timestamp belongs to the source, not to a particular listing, so a
-- source with many due listings cannot consume an entire batch by itself.
alter table public.auction_source_state
  add column if not exists last_detail_claim_at timestamptz;

comment on column public.auction_source_state.last_detail_claim_at is
  'Last source-detail queue claim. Used only to order eligible sources fairly.';

create or replace function public.claim_auction_enrichment_jobs_family(
  p_family text,
  p_limit integer default 10
)
returns setof public.auction_enrichment_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_family text := lower(trim(coalesce(p_family, '')));
  v_claim_limit integer := greatest(1, least(coalesce(p_limit, 10), 100));
begin
  if v_family not in ('source_detail', 'enrichment', 'all') then
    raise exception 'Unknown enrichment queue family: %', p_family
      using errcode = '22023';
  end if;

  -- Detail work can also be claimed through the historical all-family RPC.
  -- Serialize only the short SQL claim section; the worker performs HTTP and
  -- OCR after this transaction has returned its leases.
  if v_family in ('source_detail', 'all') then
    perform pg_advisory_xact_lock(
      hashtextextended('immojudis-enrichment-source-detail-claim', 0)
    );
  end if;

  -- Retain an audit trail; obsolete work must never consume a retry or a
  -- network/LLM call. This is intentionally the same cleanup as the previous
  -- claim function.
  update public.auction_enrichment_jobs j
     set status = 'cancelled',
         locked_at = null,
         updated_at = now(),
         last_error = 'Listing removed, expired or explicitly cancelled'
   where (j.status in ('queued', 'failed')
       or (j.status = 'running'
           and coalesce(j.locked_at, j.updated_at) < now() - interval '30 minutes'))
     and not exists (
       select 1
         from public.auction_sales s
        where s.source_url = j.source_url
          and s.status in ('active', 'unknown', 'upcoming', 'postponed', 'past')
          and (
            app_private.sale_retention_deadline(
              s.sale_date, s.status, s.sale_procedure, s.raw_payload
            ) is null
            or app_private.sale_retention_deadline(
              s.sale_date, s.status, s.sale_procedure, s.raw_payload
            ) > now()
          )
     );

  with ranked as (
    select id,
           row_number() over (
             partition by source_url, job_type, detail_source_name, detail_source_url
             order by created_at desc, (input_hash like 'pipeline_v2:%') desc, id desc
           ) as revision_rank
      from public.auction_enrichment_jobs
     where status <> 'cancelled'
  )
  update public.auction_enrichment_jobs j
     set status = 'cancelled',
         locked_at = null,
         updated_at = now(),
         last_error = 'Superseded by a newer input revision'
    from ranked r
   where r.id = j.id
     and r.revision_rank > 1
     and (
       j.status in ('queued', 'failed')
       or (j.status = 'running'
           and coalesce(j.locked_at, j.updated_at) < now() - interval '30 minutes')
     );

  update public.auction_enrichment_jobs
     set status = 'failed',
         locked_at = null,
         updated_at = now(),
         last_error = 'Worker lease expired and retry budget exhausted'
   where status = 'running'
     and coalesce(locked_at, updated_at) < now() - interval '30 minutes'
     and attempt_count >= max_attempts;

  if v_family = 'source_detail' then
    -- Rank within every source first. Ordering those first rows by the
    -- source's last claim gives a round-robin batch: with N sources, ranks
    -- 1..N are selected before rank N+1 is considered. The outer join back to
    -- jobs/sales is deliberate so FOR UPDATE can retain the old row locks.
    return query
    with eligible as (
      select j.id,
             j.source_url,
             j.detail_source_name,
             j.priority,
             j.created_at,
             state.last_detail_claim_at,
             coalesce((s.sale_date between now() and now() + interval '7 days'), false) as is_near
        from public.auction_enrichment_jobs j
        join public.auction_sales s on s.source_url = j.source_url
        join public.auction_source_state state
          on state.source_name = j.detail_source_name
        cross join lateral (
          select app_private.sale_retention_deadline(
            s.sale_date, s.status, s.sale_procedure, s.raw_payload
          ) as retention_deadline
          offset 0
        ) retention
       where (
         j.status in ('queued', 'failed')
         or (j.status = 'running'
             and coalesce(j.locked_at, j.updated_at) < now() - interval '30 minutes')
       )
         and j.next_attempt_at <= now()
         and j.attempt_count < j.max_attempts
         and j.job_type = 'source_detail'
         and exists (
           select 1
             from public.auction_pipeline_control c
            where c.id and c.enabled and c.source_details_enabled
         )
         and state.enabled
         and (state.suspended_until is null or state.suspended_until <= now())
         and s.status in ('active', 'unknown', 'upcoming', 'postponed', 'past')
         and (retention.retention_deadline is null or retention.retention_deadline > now())
         and not exists (
           select 1
             from public.auction_enrichment_jobs active
            where active.source_url = j.source_url
              and active.status = 'running'
              and coalesce(active.locked_at, active.updated_at) >= now() - interval '30 minutes'
         )
    ), ranked_details as (
      select e.*,
             row_number() over (
               partition by e.detail_source_name
               order by e.is_near desc,
                        e.priority + extract(epoch from (now() - e.created_at)) / 3600 desc,
                        e.created_at,
                        e.id
             ) as source_rank
        from eligible e
    ), candidates as (
      select j.id
        from ranked_details r
        join public.auction_enrichment_jobs j on j.id = r.id
        join public.auction_sales s on s.source_url = j.source_url
       order by r.source_rank,
                r.last_detail_claim_at nulls first,
                r.detail_source_name,
                r.is_near desc,
                r.priority + extract(epoch from (now() - r.created_at)) / 3600 desc,
                r.created_at,
                r.id
       for update of j, s skip locked
       limit v_claim_limit
    ), claimed as (
      update public.auction_enrichment_jobs j
         set status = 'running',
             attempt_count = j.attempt_count + 1,
             locked_at = statement_timestamp(),
             updated_at = statement_timestamp(),
             last_error = null
        from candidates c
       where c.id = j.id
      returning j.*
    ), touched_sources as (
      update public.auction_source_state state
         set last_detail_claim_at = statement_timestamp(),
             updated_at = statement_timestamp()
       where state.source_name in (
         select c.detail_source_name
           from claimed c
          where c.detail_source_name is not null
       )
      returning state.source_name
    )
    select c.*
      from claimed c
      cross join (select count(*) from touched_sources) touched;
    return;
  end if;

  -- Keep the enrichment and historical all-family order and eligibility
  -- unchanged. The all-family claim still records detail sources that it
  -- happens to lease, so legacy callers participate in the same fairness clock.
  return query
  with candidates as (
    select j.id
      from public.auction_enrichment_jobs j
      join public.auction_sales s on s.source_url = j.source_url
      cross join lateral (
        select app_private.sale_retention_deadline(
          s.sale_date, s.status, s.sale_procedure, s.raw_payload
        ) as retention_deadline
        offset 0
      ) retention
     where (
       j.status in ('queued', 'failed')
       or (j.status = 'running'
           and coalesce(j.locked_at, j.updated_at) < now() - interval '30 minutes')
     )
       and j.next_attempt_at <= now()
       and j.attempt_count < j.max_attempts
       and (
         v_family = 'all'
         or (v_family = 'source_detail' and j.job_type = 'source_detail')
         or (v_family = 'enrichment' and j.job_type <> 'source_detail')
       )
       and (
         j.job_type <> 'source_detail'
         or (
           exists (
             select 1
               from public.auction_pipeline_control c
              where c.id and c.enabled and c.source_details_enabled
           )
           and exists (
             select 1
               from public.auction_source_state state
              where state.source_name = j.detail_source_name
                and state.enabled
                and (state.suspended_until is null or state.suspended_until <= now())
           )
         )
       )
       and s.status in ('active', 'unknown', 'upcoming', 'postponed', 'past')
       and (retention.retention_deadline is null or retention.retention_deadline > now())
       and not exists (
         select 1
           from public.auction_enrichment_jobs active
          where active.source_url = j.source_url
            and active.status = 'running'
            and coalesce(active.locked_at, active.updated_at) >= now() - interval '30 minutes'
       )
     order by (v_family = 'all' and j.job_type = 'source_detail') desc,
              coalesce((s.sale_date between now() and now() + interval '7 days'), false) desc,
              j.priority + extract(epoch from (now() - j.created_at)) / 3600 desc,
              j.created_at,
              j.id
     for update of j, s skip locked
     limit v_claim_limit
  ), claimed as (
    update public.auction_enrichment_jobs j
       set status = 'running',
           attempt_count = j.attempt_count + 1,
           locked_at = statement_timestamp(),
           updated_at = statement_timestamp(),
           last_error = null
      from candidates c
     where c.id = j.id
    returning j.*
  ), touched_sources as (
    update public.auction_source_state state
       set last_detail_claim_at = statement_timestamp(),
           updated_at = statement_timestamp()
     where state.source_name in (
       select c.detail_source_name
         from claimed c
        where c.job_type = 'source_detail'
          and c.detail_source_name is not null
     )
    returning state.source_name
  )
  select c.*
    from claimed c
    cross join (select count(*) from touched_sources) touched;
end;
$$;

revoke all on function public.claim_auction_enrichment_jobs_family(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_auction_enrichment_jobs_family(text, integer)
  to service_role;

-- Historical callers still receive both families and retain the old signature.
create or replace function public.claim_auction_enrichment_jobs(p_limit integer default 10)
returns setof public.auction_enrichment_jobs
language sql
security invoker
set search_path = ''
as $$
  select * from public.claim_auction_enrichment_jobs_family('all', p_limit);
$$;

revoke all on function public.claim_auction_enrichment_jobs(integer)
  from public, anon, authenticated;
grant execute on function public.claim_auction_enrichment_jobs(integer)
  to service_role;

commit;
