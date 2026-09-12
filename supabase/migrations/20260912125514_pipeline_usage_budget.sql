begin;
alter table public.auction_pipeline_control add column max_ai_predictions_per_run integer not null default 40 check(max_ai_predictions_per_run between 1 and 100);
alter table public.auction_pipeline_control add column daily_ai_budget_usd numeric not null default 5 check(daily_ai_budget_usd>=0);
create table public.auction_pipeline_usage (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.auction_runs(id) on delete cascade,
  prediction_id text unique,
  model text not null,
  status text not null default 'reserved',
  metrics jsonb not null default '{}',
  estimated_usd numeric,
  reserved_usd numeric not null default 0.2925,
  rate_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index auction_pipeline_usage_run on public.auction_pipeline_usage(run_id,created_at);
alter table public.auction_pipeline_usage enable row level security;
revoke all on public.auction_pipeline_usage from public,anon,authenticated;
grant select,insert,update,delete on public.auction_pipeline_usage to service_role;
create or replace function public.reserve_pipeline_prediction(p_run_id uuid,p_model text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare cap integer; daily_budget numeric; reservation uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('immojudis-prediction-budget',0));
  if not exists(select 1 from public.auction_runs where id=p_run_id and scheduler_owned and status='running') then
    raise exception 'No active autonomous execution';
  end if;
  select max_ai_predictions_per_run,daily_ai_budget_usd into cap,daily_budget from public.auction_pipeline_control where id;
  if (select count(*) from public.auction_pipeline_usage where run_id=p_run_id)>=cap then
    raise exception 'AI prediction budget exhausted for this execution';
  end if;
  -- Pinned public L40S model, $0.000975/s checked 2026-09-12, maximum 5-minute prediction.
  -- https://replicate.com/zsxkib/qwen2-7b-instruct and https://replicate.com/pricing
  if p_model <> 'zsxkib/qwen2-7b-instruct:5324178307f5ec0239326b429d6b64ae338cd6b51fbe234402a55537a9998ac4' then
    raise exception 'Automatic AI model has no configured cost reservation';
  end if;
  if coalesce((select sum(coalesce(estimated_usd,reserved_usd)) from public.auction_pipeline_usage
      where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0)+0.2925>daily_budget then
    raise exception 'Daily AI budget exhausted; pending documents retained';
  end if;
  insert into public.auction_pipeline_usage(run_id,model) values(p_run_id,p_model) returning id into reservation;
  return reservation;
end;
$$;
revoke all on function public.reserve_pipeline_prediction(uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_pipeline_prediction(uuid,text) to service_role;
create or replace function public.pipeline_usage_summary()
returns jsonb language sql security invoker set search_path='' as $$
  select jsonb_build_object(
    'day_utc',(now() at time zone 'UTC')::date,
    'ai_requests',count(*),'ai_estimated_usd',coalesce(sum(estimated_usd),0),
    'ai_unpriced_requests',count(*) filter(where estimated_usd is null),
    'ai_reserved_usd',coalesce(sum(coalesce(estimated_usd,reserved_usd)),0),
    'daily_ai_budget_usd',(select daily_ai_budget_usd from public.auction_pipeline_control where id),
    'runner_seconds',(select coalesce(sum((summary->>'execution_seconds')::numeric),0) from public.auction_runs
      where scheduler_owned and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),
    'rate_source','https://replicate.com/pricing; L40S 0.000975 USD/s; checked 2026-09-12')
  from public.auction_pipeline_usage where created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
$$;
revoke all on function public.pipeline_usage_summary() from public,anon,authenticated;
grant execute on function public.pipeline_usage_summary() to service_role;
commit;
