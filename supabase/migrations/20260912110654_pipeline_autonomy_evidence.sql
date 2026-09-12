begin;

create table public.auction_source_state (
  source_name text primary key,
  enabled boolean not null default false,
  suspension_reason text,
  suspended_until timestamptz,
  next_inventory_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  last_inventory_complete_at timestamptz,
  last_publication_complete_at timestamptz,
  last_run_id uuid references public.auction_runs(id) on delete set null,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  availability text not null default 'unchecked'
    check (availability in ('unchecked','available','partial','unavailable','access_denied')),
  coverage jsonb not null default '{}',
  last_error text,
  updated_at timestamptz not null default now()
);
insert into public.auction_source_state(source_name)
select unnest(array['avoventes','licitor','vench','info_encheres','encheres_publiques',
  'petites_affiches','cessions_etat','agrasc','encheres_immobilieres','notaires']);

create table public.auction_collection_items (
  run_id uuid not null references public.auction_runs(id) on delete cascade,
  source_name text not null,
  source_url text not null,
  identity_hash text not null,
  canonical_source_url text,
  decision text not null default 'discovered' check (decision in
    ('discovered','normalized','merged','admitted','published','expired','quarantined','excluded','publication_failed','normalization_failed')),
  reason text,
  evidence jsonb not null default '{}',
  discovered_at timestamptz not null default now(),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(run_id, source_name, identity_hash)
);
create index auction_collection_items_pending_idx on public.auction_collection_items(run_id,decision);
create index auction_collection_items_source_url_idx on public.auction_collection_items(source_name,source_url,discovered_at desc);
alter table public.auction_source_state enable row level security;
alter table public.auction_collection_items enable row level security;
revoke all on public.auction_source_state, public.auction_collection_items from public, anon, authenticated;
grant select,insert,update,delete on public.auction_source_state, public.auction_collection_items to service_role;

comment on table public.auction_collection_items is 'Collection decisions and public-source evidence. Follows auction_runs retention by cascading delete. No inference of sold from expiration.';
create table public.auction_collection_checkpoints (
  run_id uuid not null references public.auction_runs(id) on delete cascade,
  source_url text not null,
  signature text not null,
  payload jsonb not null,
  observed_at timestamptz not null default now(),
  primary key(run_id,source_url)
);
alter table public.auction_collection_checkpoints enable row level security;
revoke all on public.auction_collection_checkpoints from public,anon,authenticated;
grant select,insert,update,delete on public.auction_collection_checkpoints to service_role;
commit;
