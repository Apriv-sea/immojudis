begin;

create or replace function app_private.enqueue_auction_surface_enrichment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_input_hash text := md5(
    coalesce(new.content_hash, new.source_url || coalesce(new.documents::text, '[]'))
    || ':auction_display_v8:qwen2_7b_instruct'
  );
  v_has_documents boolean := jsonb_typeof(coalesce(new.documents, '[]'::jsonb)) = 'array'
    and jsonb_array_length(coalesce(new.documents, '[]'::jsonb)) > 0;
begin
  -- Transactional Python publication owns versioned scheduling. Keep the
  -- trigger as a compatibility fallback for other catalogue writers.
  if current_setting('app.pipeline_queue_owner', true) = 'python' then
    return new;
  end if;
  if new.status not in ('active', 'upcoming') or new.sale_date < now() then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.content_hash is not distinct from old.content_hash
      and new.documents is not distinct from old.documents then
    return new;
  end if;
  if v_has_documents then
    insert into public.auction_enrichment_jobs (source_url, job_type, priority, input_hash)
    values (new.source_url, 'pdf', 30, v_input_hash)
    on conflict (source_url, job_type, input_hash) do nothing;
  end if;

  insert into public.auction_enrichment_jobs (source_url, job_type, priority, input_hash)
  values (new.source_url, 'display_description', 20, v_input_hash)
  on conflict (source_url, job_type, input_hash) do nothing;
  return new;
end;
$$;


create index if not exists auction_enrichment_jobs_revision_idx
  on public.auction_enrichment_jobs(source_url, job_type, created_at desc);

create or replace function public.claim_auction_enrichment_jobs(p_limit integer default 10)
returns setof public.auction_enrichment_jobs
language plpgsql security invoker set search_path = ''
as $$
begin
  -- Retain an audit trail; obsolete work must never consume a retry or an LLM call.
  update public.auction_enrichment_jobs j
    set status = 'cancelled', locked_at = null, updated_at = now(),
        last_error = 'Sale is no longer active or has a past sale date'
    from public.auction_sales s
    where s.source_url = j.source_url and j.status in ('queued','failed')
      and (s.sale_date < now() or s.status not in ('active','upcoming'));

  with ranked as (
    select id, row_number() over (
      partition by source_url, job_type
      order by created_at desc, (input_hash like 'pipeline_v2:%') desc, id desc
    ) as revision_rank
    from public.auction_enrichment_jobs where status <> 'cancelled'
  )
  update public.auction_enrichment_jobs j
    set status = 'cancelled', locked_at = null, updated_at = now(),
        last_error = 'Superseded by a newer input revision'
    from ranked r where j.id = r.id and r.revision_rank > 1
      and j.status in ('queued','failed');

  return query
  with candidates as (
    select j.id from public.auction_enrichment_jobs j
    join public.auction_sales s on s.source_url = j.source_url
    where (j.status in ('queued','failed') or
      (j.status = 'running' and j.locked_at < statement_timestamp() - interval '30 minutes'))
      and j.next_attempt_at <= statement_timestamp() and j.attempt_count < j.max_attempts
      and s.status in ('active','upcoming') and (s.sale_date is null or s.sale_date >= now())
      and not exists (select 1 from public.auction_enrichment_jobs active
          where active.source_url = j.source_url and active.status = 'running'
          and active.locked_at >= statement_timestamp() - interval '30 minutes')
    order by
      (s.sale_date between now() and now() + interval '7 days') desc,
      (case j.job_type when 'pdf' then 30 when 'fact_extraction' then 25 else 20 end
        + extract(epoch from (now() - j.created_at)) / 3600) desc,
      j.created_at, j.id
    for update of j skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 100))
  )
  update public.auction_enrichment_jobs j set status = 'running',
      attempt_count = j.attempt_count + 1, locked_at = statement_timestamp(),
      updated_at = statement_timestamp(), last_error = null
    from candidates c where j.id = c.id returning j.*;
end;
$$;
revoke all on function public.claim_auction_enrichment_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_auction_enrichment_jobs(integer) to service_role;
revoke all on function app_private.enqueue_auction_surface_enrichment() from public, anon, authenticated;
grant execute on function app_private.enqueue_auction_surface_enrichment() to service_role;
commit;
