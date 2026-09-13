begin;

-- Scan each active sale once before expanding source aliases.  In particular,
-- keep the retention guard and source-check payload in the same materialized
-- row so a TOASTed raw payload and the STABLE deadline function are not
-- revisited by the source-detail candidate predicate.
create or replace function public.enqueue_due_source_details(
  p_now timestamptz default now(),
  p_limit integer default 500
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inserted integer;
begin
  if not exists (
    select 1
      from public.auction_pipeline_control
     where id
       and enabled
       and source_details_enabled
  ) then
    return 0;
  end if;

  with base as materialized (
    select
      s.source_url as canonical_url,
      s.source_name,
      s.sale_date,
      case
        when jsonb_typeof(s.observations) = 'array' then s.observations
        else '[]'::jsonb
      end as observations,
      case
        when jsonb_typeof(s.raw_payload->'source_checks') = 'object'
          then s.raw_payload->'source_checks'
        else '{}'::jsonb
      end as checks,
      app_private.sale_retention_deadline(
        s.sale_date,
        s.status,
        s.sale_procedure,
        s.raw_payload
      ) as retention_deadline
    from public.auction_sales s
    where s.status in ('active', 'upcoming', 'postponed', 'unknown')
  ),
  eligible_aliases as materialized (
    select
      b.canonical_url,
      b.sale_date,
      b.checks,
      u.source_name,
      u.source_url
    from base b
    cross join lateral (
      select
        b.source_name as source_name,
        b.canonical_url as source_url
      where b.canonical_url is not null

      union

      select
        o.value->>'source_name' as source_name,
        o.value->>'source_url' as source_url
      from jsonb_array_elements(b.observations) o

      union

      select
        c.value->>'source_name' as source_name,
        c.key as source_url
      from jsonb_each(b.checks) c
    ) u
    join public.auction_source_state state
      on state.source_name = u.source_name
    where u.source_url is not null
      and state.enabled
      and (
        state.suspended_until is null
        or state.suspended_until <= p_now
      )
      and (
        b.retention_deadline is null
        or b.retention_deadline > p_now
      )
  ),
  checked as materialized (
    select
      e.*,
      app_private.pipeline_checked_at(
        e.checks->e.source_url->>'checked_at',
        p_now
      ) as checked,
      case
        when e.sale_date between p_now and p_now + interval '7 days'
          then interval '5 hours'
        else interval '23 hours'
      end as cadence
    from eligible_aliases e
  ),
  due as (
    select
      c.*,
      'source_detail_v1:' ||
        md5(
          c.source_name || ':' ||
          c.source_url || ':' ||
          coalesce(extract(epoch from c.checked)::text, 'never') || ':' ||
          (p_now at time zone 'UTC')::date::text
        ) as signature
    from checked c
    where c.checked is null
       or c.checked + c.cadence <= p_now
  ),
  chosen as (
    select d.*
    from due d
    where not exists (
      select 1
      from public.auction_enrichment_jobs j
      where j.source_url = d.canonical_url
        and j.job_type = 'source_detail'
        and j.detail_source_name = d.source_name
        and j.detail_source_url = d.source_url
        and (
          j.input_hash = d.signature
          or j.status in ('queued', 'running')
          or (
            j.status = 'failed'
            and j.attempt_count < j.max_attempts
          )
        )
    )
    order by
      d.checked nulls first,
      d.canonical_url,
      d.source_name,
      d.source_url
    limit greatest(1, least(p_limit, 1000))
  )
  insert into public.auction_enrichment_jobs (
    source_url,
    job_type,
    input_hash,
    detail_source_name,
    detail_source_url,
    priority
  )
  select
    canonical_url,
    'source_detail',
    signature,
    source_name,
    source_url,
    100
  from chosen
  on conflict (source_url, job_type, input_hash) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

commit;
