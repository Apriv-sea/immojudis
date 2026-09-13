begin;

-- The explicit family RPC lets bounded workers reserve one lane at a time.
-- Keep all queue lifecycle and lease protections in this single implementation;
-- the historical RPC below remains a compatibility wrapper for old callers.
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
begin
  if v_family not in ('source_detail', 'enrichment', 'all') then
    raise exception 'Unknown enrichment queue family: %', p_family
      using errcode = '22023';
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

  return query
  with candidates as (
    select j.id
      from public.auction_enrichment_jobs j
      join public.auction_sales s on s.source_url = j.source_url
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
       and (
         app_private.sale_retention_deadline(
           s.sale_date, s.status, s.sale_procedure, s.raw_payload
         ) is null
         or app_private.sale_retention_deadline(
           s.sale_date, s.status, s.sale_procedure, s.raw_payload
         ) > now()
       )
       and not exists (
         select 1
           from public.auction_enrichment_jobs active
          where active.source_url = j.source_url
            and active.status = 'running'
            and coalesce(active.locked_at, active.updated_at) >= now() - interval '30 minutes'
       )
     -- Preserve the historical detail-first order for the all-family wrapper;
     -- proximity remains the first ordering key inside each explicit family.
     order by (v_family = 'all' and j.job_type = 'source_detail') desc,
              (s.sale_date between now() and now() + interval '7 days') desc,
              j.priority + extract(epoch from (now() - j.created_at)) / 3600 desc,
              j.created_at,
              j.id
     for update of j, s skip locked
     limit greatest(1, least(coalesce(p_limit, 10), 100))
  )
  update public.auction_enrichment_jobs j
     set status = 'running',
         attempt_count = j.attempt_count + 1,
         locked_at = statement_timestamp(),
         updated_at = statement_timestamp(),
         last_error = null
    from candidates c
   where c.id = j.id
  returning j.*;
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
