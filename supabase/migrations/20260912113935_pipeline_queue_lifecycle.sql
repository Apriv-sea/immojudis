begin;
alter table public.auction_sales drop constraint if exists auction_sales_status_check;
alter table public.auction_sales add constraint auction_sales_status_check
  check(status in ('upcoming','past','adjudicated','unknown','postponed','cancelled','withdrawn','quarantined'));
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
  if lower(coalesce(p_raw->>'status','')) ~ '(postponed|reported|report[eé]e?)' then return null; end if;
  if jsonb_path_exists(coalesce(p_raw,'{}'), '$.source_conflicts[*] ? (@.field == "sale_date")') then return null; end if;
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


create or replace function public.claim_auction_enrichment_jobs(p_limit integer default 10)
returns setof public.auction_enrichment_jobs language plpgsql security invoker set search_path='' as $$
begin
  update public.auction_enrichment_jobs j set status='cancelled',locked_at=null,updated_at=now(),
    last_error='Listing removed, expired or explicitly cancelled'
    where (j.status in ('queued','failed') or (j.status='running' and coalesce(j.locked_at,j.updated_at)<now()-interval '30 minutes'))
      and not exists(select 1 from public.auction_sales s where s.source_url=j.source_url
        and s.status in ('active','upcoming','postponed','past')
        and (app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload) is null
          or app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload)>now()));

  with ranked as (
    select id,row_number() over(partition by source_url,job_type order by created_at desc,
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
      and s.status in ('active','upcoming','postponed','past')
      and (app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload) is null
        or app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload)>now())
      and not exists(select 1 from public.auction_enrichment_jobs active where active.source_url=j.source_url
        and active.status='running' and coalesce(active.locked_at,active.updated_at)>=now()-interval '30 minutes')
    order by (s.sale_date between now() and now()+interval '7 days') desc,
      j.priority + extract(epoch from (now()-j.created_at))/3600 desc,j.created_at,j.id
    for update of j,s skip locked limit greatest(1,least(coalesce(p_limit,10),100))
  ) update public.auction_enrichment_jobs j set status='running',attempt_count=j.attempt_count+1,
      locked_at=statement_timestamp(),updated_at=statement_timestamp(),last_error=null
    from candidates c where c.id=j.id returning j.*;
end;
$$;
revoke all on function public.claim_auction_enrichment_jobs(integer) from public,anon,authenticated;
grant execute on function public.claim_auction_enrichment_jobs(integer) to service_role;
-- Use the same source-aware end of sale for status transitions and expiry.
create or replace function public.mark_elapsed_auction_sales()
returns integer language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  update public.auction_sales set status='past',updated_at=now()
    where status in ('active','upcoming','unknown') and
      app_private.sale_retention_deadline(sale_date,status,sale_procedure,raw_payload)-interval '24 hours' < now();
  get diagnostics changed = row_count;
  return changed;
end;
$$;
revoke all on function public.mark_elapsed_auction_sales() from public,anon,authenticated;
grant execute on function public.mark_elapsed_auction_sales() to service_role;
commit;
