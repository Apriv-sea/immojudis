begin;

create schema if not exists app_private;
grant usage on schema app_private to service_role;

create table app_private.reviewed_publication_aliases (
  alias_sale_id uuid primary key references public.auction_sales(id) on delete cascade,
  canonical_sale_id uuid not null references public.auction_sales(id) on delete cascade,
  review_key text not null check (btrim(review_key) <> ''),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  reviewed_at timestamptz not null default now(),
  reviewed_by text not null check (btrim(reviewed_by) <> ''),
  constraint reviewed_publication_aliases_distinct_parents
    check (alias_sale_id <> canonical_sale_id)
);

comment on table app_private.reviewed_publication_aliases is
  'Privileged, human-reviewed secondary-to-canonical publication identities.';
comment on column app_private.reviewed_publication_aliases.evidence is
  'Review references and identity evidence; never inferred by the collector.';

create index reviewed_publication_aliases_canonical_idx
  on app_private.reviewed_publication_aliases (canonical_sale_id);

alter table app_private.reviewed_publication_aliases enable row level security;

revoke all on table app_private.reviewed_publication_aliases from public, anon, authenticated;
grant select, insert, update, delete
  on table app_private.reviewed_publication_aliases to service_role;

drop policy if exists reviewed_publication_aliases_service_role on app_private.reviewed_publication_aliases;
create policy reviewed_publication_aliases_service_role
  on app_private.reviewed_publication_aliases
  for all to service_role
  using (true)
  with check (true);

create or replace function public.list_reviewed_publication_aliases()
returns table (
  alias_sale_id uuid,
  canonical_sale_id uuid,
  alias_source_url text,
  canonical_source_url text,
  review_key text,
  evidence jsonb,
  reviewed_at timestamptz,
  reviewed_by text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    relation.alias_sale_id,
    relation.canonical_sale_id,
    alias_sale.source_url,
    canonical_sale.source_url,
    relation.review_key,
    relation.evidence,
    relation.reviewed_at,
    relation.reviewed_by
  from app_private.reviewed_publication_aliases as relation
  left join public.auction_sales as alias_sale
    on alias_sale.id = relation.alias_sale_id
  left join public.auction_sales as canonical_sale
    on canonical_sale.id = relation.canonical_sale_id
  order by relation.alias_sale_id;
$$;

revoke all on function public.list_reviewed_publication_aliases() from public, anon, authenticated;
grant execute on function public.list_reviewed_publication_aliases() to service_role;

commit;
