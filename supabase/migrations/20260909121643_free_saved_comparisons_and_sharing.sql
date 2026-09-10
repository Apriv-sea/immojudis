begin;

-- Ownership policies remain in force; tier limits now belong to the quota
-- trigger so Discovery can use its bounded comparison allowance.
drop policy if exists analysis_access_required on public.user_sale_analysis_sets;
drop policy if exists analysis_access_required on public.user_sale_analysis_items;

-- A saved comparison may be shared through a short-lived opaque token. Only a
-- SHA-256 digest is retained, so reading the database cannot recover live URLs.
alter table public.user_sale_analysis_sets
  add column if not exists share_token_hash text,
  add column if not exists shared_snapshot jsonb,
  add column if not exists shared_at timestamptz,
  add column if not exists share_expires_at timestamptz;

alter table public.user_sale_analysis_sets
  drop constraint if exists user_sale_analysis_sets_share_token_hash_check,
  add constraint user_sale_analysis_sets_share_token_hash_check check (
    share_token_hash is null
    or share_token_hash ~ '^[0-9a-f]{64}$'
  ),
  drop constraint if exists user_sale_analysis_sets_share_window_check,
  add constraint user_sale_analysis_sets_share_window_check check (
    (
      share_token_hash is null
      and shared_at is null
      and share_expires_at is null
    )
    or (
      share_token_hash is not null
      and shared_at is not null
      and share_expires_at is not null
      and share_expires_at > shared_at
      and share_expires_at <= shared_at + interval '31 days'
    )
  );

create unique index if not exists user_sale_analysis_sets_share_token_hash_idx
  on public.user_sale_analysis_sets (share_token_hash)
  where share_token_hash is not null;

comment on column public.user_sale_analysis_sets.share_token_hash is
  'SHA-256 digest of the active opaque comparison sharing token. Server-owned.';
comment on column public.user_sale_analysis_sets.share_expires_at is
  'Mandatory expiry for an active comparison sharing link, capped at 31 days.';

-- Sharing metadata is server-owned. Keep authenticated CRUD on the fields used
-- by the existing RLS-protected analysis-set API, but remove direct writes to
-- ownership, timestamps and token material.
revoke insert, update on table public.user_sale_analysis_sets from authenticated;
grant insert (
  id,
  user_id,
  name,
  analysis_kind,
  notes,
  assumptions,
  summary_snapshot,
  is_archived
) on table public.user_sale_analysis_sets to authenticated;
grant update (
  name,
  analysis_kind,
  notes,
  assumptions,
  summary_snapshot,
  is_archived,
  updated_at
) on table public.user_sale_analysis_sets to authenticated;

-- Discovery accounts receive one three-property comparison. Every other
-- finite resource remains gated behind Analyse. The advisory locks preserve
-- the existing race-safe quota checks.
create or replace function app_private.enforce_finite_resource_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_count bigint;
  quota_key text;
  target_user_id uuid;
  has_analysis_access boolean;
  resource_limit integer;
begin
  if tg_table_name = 'sale_workspace_collaborators' then
    target_user_id := new.owner_id;
  else
    target_user_id := new.user_id;
  end if;

  if target_user_id is null then
    raise exception using errcode = '23514', message = 'Quota owner is required.';
  end if;

  has_analysis_access :=
    (session_user in ('postgres', 'supabase_admin') and auth.uid() is null)
    or app_private.has_active_analysis_access(target_user_id)
    or coalesce(public.is_admin(), false);

  if tg_table_name not in ('user_sale_analysis_sets', 'user_sale_analysis_items')
    and session_user not in ('postgres', 'supabase_admin')
    and not has_analysis_access then
    raise exception using errcode = '42501', message = 'Analyse access is required.';
  end if;

  if tg_table_name = 'user_sale_analysis_sets' then
    if not has_analysis_access and new.analysis_kind <> 'comparison' then
      raise exception using errcode = '42501', message = 'Only saved comparisons are available on Discovery.';
    end if;
  end if;

  quota_key := tg_table_name || ':' || target_user_id::text;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(quota_key, 0));

  case tg_table_name
    when 'user_api_keys' then
      if new.revoked_at is not null then return new; end if;
      select count(*) into current_count
      from public.user_api_keys item
      where item.user_id = new.user_id
        and item.revoked_at is null
        and item.id <> new.id;
      if current_count >= 2 then
        raise exception using errcode = 'P0001', message = 'Quota de 2 clés API actives atteint.';
      end if;
    when 'user_watched_zones' then
      if not new.is_active then return new; end if;
      select count(*) into current_count
      from public.user_watched_zones item
      where item.user_id = new.user_id
        and item.is_active
        and item.id <> new.id;
      if current_count >= 25 then
        raise exception using errcode = 'P0001', message = 'Quota de 25 zones surveillées atteint.';
      end if;
    when 'user_alerts' then
      if not new.is_active then return new; end if;
      select count(*) into current_count
      from public.user_alerts item
      where item.user_id = new.user_id
        and item.is_active
        and item.id <> new.id;
      if current_count >= 25 then
        raise exception using errcode = 'P0001', message = 'Quota de 25 alertes actives atteint.';
      end if;
    when 'user_sale_analysis_sets' then
      if new.is_archived then return new; end if;
      resource_limit := case when has_analysis_access then 20 else 1 end;
      select count(*) into current_count
      from public.user_sale_analysis_sets item
      where item.user_id = new.user_id
        and not item.is_archived
        and item.id <> new.id;
      if current_count >= resource_limit then
        raise exception using
          errcode = 'P0001',
          message = format('Quota de %s comparaison(s) active(s) atteint.', resource_limit);
      end if;
    when 'user_sale_analysis_items' then
      resource_limit := case when has_analysis_access then 12 else 3 end;
      quota_key := tg_table_name || ':' || new.analysis_set_id::text;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(quota_key, 0));
      select count(*) into current_count
      from public.user_sale_analysis_items item
      where item.analysis_set_id = new.analysis_set_id
        and item.id <> new.id;
      if current_count >= resource_limit then
        raise exception using
          errcode = 'P0001',
          message = format('Quota de %s biens par comparaison atteint.', resource_limit);
      end if;
    when 'sale_workspace_collaborators' then
      if new.status = 'revoked' then return new; end if;
      quota_key := tg_table_name || ':' || new.workspace_id::text;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(quota_key, 0));
      select count(*) into current_count
      from public.sale_workspace_collaborators item
      where item.workspace_id = new.workspace_id
        and item.status <> 'revoked'
        and item.id <> new.id;
      if current_count >= 25 then
        raise exception using errcode = 'P0001', message = 'Quota de 25 collaborateurs par dossier atteint.';
      end if;
    else
      raise exception using errcode = '0A000', message = 'Unsupported quota trigger table.';
  end case;

  return new;
end;
$$;

revoke all on function app_private.enforce_finite_resource_quota()
  from public, anon, authenticated;

drop trigger if exists enforce_user_sale_analysis_sets_quota on public.user_sale_analysis_sets;
create trigger enforce_user_sale_analysis_sets_quota
before insert or update of user_id, is_archived, analysis_kind
on public.user_sale_analysis_sets
for each row execute function app_private.enforce_finite_resource_quota();

-- One invoker transaction keeps metadata and ordered items together. RLS and
-- quota triggers apply to every statement, including direct RPC calls.
create or replace function public.save_sale_analysis_set(p_metadata jsonb, p_items jsonb, p_set_id uuid default null)
returns public.user_sale_analysis_sets
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved public.user_sale_analysis_sets;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Authentication required.';
  end if;
  if p_items is not null and (
    jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 12
  ) then
    raise exception using errcode = '22023', message = 'Invalid comparison items.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'user_sale_analysis_sets:' || auth.uid()::text, 0));
  if p_set_id is null then
    if p_items is null then
      raise exception using errcode = '22023', message = 'Comparison items required.';
    end if;
    insert into public.user_sale_analysis_sets
      (user_id, name, analysis_kind, notes, assumptions, summary_snapshot, is_archived)
    values (auth.uid(), p_metadata->>'name', p_metadata->>'analysis_kind',
      p_metadata->>'notes', coalesce(p_metadata->'assumptions', '{}'::jsonb),
      coalesce(p_metadata->'summary_snapshot', '{}'::jsonb),
      coalesce((p_metadata->>'is_archived')::boolean, false))
    returning * into saved;
  else
    update public.user_sale_analysis_sets
    set name = p_metadata->>'name', analysis_kind = p_metadata->>'analysis_kind',
      notes = p_metadata->>'notes', assumptions = p_metadata->'assumptions',
      summary_snapshot = p_metadata->'summary_snapshot',
      is_archived = (p_metadata->>'is_archived')::boolean
    where id = p_set_id and user_id = auth.uid()
    returning * into saved;
    if not found then
      raise exception using errcode = '42501', message = 'Comparison unavailable.';
    end if;
  end if;
  if p_items is not null then
    delete from public.user_sale_analysis_items
    where analysis_set_id = saved.id and user_id = auth.uid();
    insert into public.user_sale_analysis_items
      (analysis_set_id, user_id, sale_id, item_order, decision_status,
       user_max_bid_eur, target_yield_pct, expected_margin_pct, notes)
    select saved.id, auth.uid(), (item->>'saleId')::uuid, (ordinality - 1)::integer,
      coalesce(item->>'decisionStatus', 'watching'),
      (item->>'userMaxBidEur')::numeric, (item->>'targetYieldPct')::numeric,
      (item->>'expectedMarginPct')::numeric, item->>'notes'
    from jsonb_array_elements(p_items) with ordinality as entries(item, ordinality);
  end if;
  return saved;
end;
$$;
revoke all on function public.save_sale_analysis_set(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.save_sale_analysis_set(jsonb, jsonb, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
