-- Private acquisition only: no grants to the public catalogue or Premium corpus.
create schema if not exists licitor_ingestion;
revoke all on schema licitor_ingestion from public;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'licitor_collector') then
    create role licitor_collector nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end $$;
grant usage on schema licitor_ingestion to licitor_collector;

create table licitor_ingestion.control (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  monthly_enabled boolean not null default false,
  network_paused boolean not null default false,
  authorization_record jsonb not null,
  lease_token uuid,
  lease_until timestamptz,
  last_request_at timestamptz,
  last_dispatch_at timestamptz,
  last_dispatch_id bigint,
  updated_at timestamptz not null default now()
);

create table licitor_ingestion.runs (
  id text primary key,
  mode text not null check (mode in ('backfill', 'monthly')),
  status text not null default 'ready' check (status in ('ready','running','paused','completed','completed_with_errors')),
  cutoff_date date,
  max_requests integer not null check (max_requests between 1 and 50000),
  network_requests integer not null default 0 check (network_requests >= 0),
  consecutive_failures integer not null default 0,
  stop_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index licitor_runs_active on licitor_ingestion.runs (created_at, id)
  where status in ('ready','running');

create table licitor_ingestion.tasks (
  run_id text not null references licitor_ingestion.runs(id),
  task_key text not null,
  kind text not null check (kind in ('index','detail')),
  url text not null,
  zone text,
  page_number integer not null default 0,
  refresh boolean not null default false,
  status text not null default 'pending' check (status in ('pending','working','done','error')),
  attempts integer not null default 0,
  retry_at timestamptz not null default now(),
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (run_id, task_key)
);
create index licitor_tasks_pending on licitor_ingestion.tasks (run_id, kind, page_number, task_key)
  where status in ('pending','working');

create table licitor_ingestion.captures (
  url text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  kind text not null check (kind in ('index','detail','robots')),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  html_gzip bytea not null,
  primary key (url, sha256),
  check (octet_length(html_gzip) <= 3000000)
);
create index licitor_capture_latest on licitor_ingestion.captures (url, last_seen_at desc);

create table licitor_ingestion.announcements (
  id text primary key check (id ~ '^[0-9]+$'),
  canonical_url text not null unique,
  current_capture_hash text,
  parsed_at timestamptz,
  parser_version text
);
create table licitor_ingestion.aliases (
  url text primary key,
  announcement_id text not null references licitor_ingestion.announcements(id)
);
create index licitor_alias_announcement on licitor_ingestion.aliases (announcement_id);

create table licitor_ingestion.index_pages (
  run_id text not null references licitor_ingestion.runs(id),
  url text not null,
  zone text not null,
  page_number integer not null,
  entry_count integer not null,
  declared_total integer,
  declared_pages integer,
  next_url text,
  old_known_page boolean not null default false,
  observed_at timestamptz not null default now(),
  primary key (run_id, url),
  unique (run_id, zone, page_number)
);
create table licitor_ingestion.index_entries (
  run_id text not null,
  page_url text not null,
  position integer not null,
  announcement_id text not null references licitor_ingestion.announcements(id),
  detail_url text not null,
  payload jsonb not null,
  primary key (run_id, page_url, position),
  foreign key (run_id, page_url) references licitor_ingestion.index_pages(run_id, url)
);
create index licitor_entries_announcement on licitor_ingestion.index_entries (announcement_id, run_id);

create table licitor_ingestion.candidates (
  external_id text primary key,
  announcement_id text not null references licitor_ingestion.announcements(id),
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  check (payload @> '{"publication_eligible":false,"training_eligible":false,"candidate_grade":"C","evidence_grade":"C","review_status":"pending"}'::jsonb)
);
create index licitor_candidates_announcement on licitor_ingestion.candidates (announcement_id);
create table licitor_ingestion.candidate_versions (
  external_id text not null,
  version_hash text not null,
  payload jsonb not null,
  observed_at timestamptz not null default now(),
  primary key (external_id, version_hash)
);
create table licitor_ingestion.events (
  id bigint generated always as identity primary key,
  run_id text references licitor_ingestion.runs(id),
  event text not null,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index licitor_events_run on licitor_ingestion.events (run_id, created_at desc);

-- The dedicated login will be provisioned separately; its password never enters a migration.
grant select on licitor_ingestion.control to licitor_collector;
grant update (lease_token, lease_until, last_request_at, network_paused, updated_at)
  on licitor_ingestion.control to licitor_collector;
grant select, insert, update on licitor_ingestion.runs, licitor_ingestion.tasks,
  licitor_ingestion.captures, licitor_ingestion.announcements, licitor_ingestion.aliases,
  licitor_ingestion.index_pages, licitor_ingestion.candidates to licitor_collector;
grant select, insert, update, delete on licitor_ingestion.index_entries to licitor_collector;
grant select, insert on licitor_ingestion.candidate_versions, licitor_ingestion.events to licitor_collector;
grant usage on sequence licitor_ingestion.events_id_seq to licitor_collector;

-- Defense in depth even though this schema is not exposed through PostgREST.
do $$ declare t text; begin
  foreach t in array array['control','runs','tasks','captures','announcements','aliases',
    'index_pages','index_entries','candidates','candidate_versions','events'] loop
    execute format('alter table licitor_ingestion.%I enable row level security', t);
    execute format('create policy collector_only on licitor_ingestion.%I to licitor_collector using (true) with check (true)', t);
    execute format('revoke all on licitor_ingestion.%I from public', t);
  end loop;
end $$;

-- Called by pg_cron as postgres. The worker cannot read Vault or change its destination.
create function licitor_ingestion.dispatch_pending() returns bigint
language plpgsql security invoker set search_path = '' as $$
declare c licitor_ingestion.control%rowtype; endpoint text; secret text; request_id bigint;
begin
  select * into c from licitor_ingestion.control where singleton for update skip locked;
  if not found or not c.enabled or c.network_paused
    or c.lease_until > now() or c.last_dispatch_at > now() - interval '4 minutes'
    or not exists (select 1 from licitor_ingestion.runs where status in ('ready','running')) then
    return null;
  end if;
  select decrypted_secret into endpoint from vault.decrypted_secrets where name='immojudis_licitor_worker_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name='immojudis_licitor_cron_secret';
  if endpoint is null or secret is null or endpoint !~ '^https://[a-z0-9-]+\.vercel\.app/api/tick$' then
    return null;
  end if;
  select net.http_get(url := endpoint,
    headers := jsonb_build_object('Authorization', 'Bearer ' || secret),
    timeout_milliseconds := 290000) into request_id;
  update licitor_ingestion.control set last_dispatch_at=now(), last_dispatch_id=request_id where singleton;
  insert into licitor_ingestion.events(event,summary) values ('dispatch',jsonb_build_object('request_id',request_id));
  return request_id;
end $$;
revoke all on function licitor_ingestion.dispatch_pending() from public, licitor_collector;

-- This is only a resumption watchdog, not a new collection campaign every minute.
-- Monthly campaign creation is performed by the authenticated Vercel cron endpoint.
do $$ begin
  if exists (select 1 from pg_namespace where nspname='cron') then
    perform cron.schedule('immojudis-licitor-resume', '* * * * *',
      'select licitor_ingestion.dispatch_pending()');
  end if;
end $$;
