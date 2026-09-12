begin;
-- Unknown availability is admissible; it must not cancel independent enrichment.
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
      and s.status in ('active','unknown','upcoming','postponed','past')
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
-- Repair only tasks cancelled by the old eligibility filter; keep manual and
-- superseded cancellations, attempt budgets and newer revisions intact.
update public.auction_enrichment_jobs j set status='queued',locked_at=null,
    next_attempt_at=greatest(next_attempt_at,now()),updated_at=now(),
    last_error='Restored after correcting unknown listing eligibility'
from public.auction_sales s
where s.source_url=j.source_url and s.status='unknown' and j.status='cancelled'
  and j.last_error in ('Listing removed, expired or explicitly cancelled',
                      'Sale is no longer active or has a past sale date')
  and j.attempt_count<j.max_attempts
  and (app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload) is null
    or app_private.sale_retention_deadline(s.sale_date,s.status,s.sale_procedure,s.raw_payload)>now())
  and not exists(select 1 from public.auction_enrichment_jobs newer
    where newer.source_url=j.source_url and newer.job_type=j.job_type
      and (newer.created_at,newer.id)>(j.created_at,j.id));
commit;
