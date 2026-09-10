begin;

-- Keep the existing owner-only policies and premium sale-data boundaries.
drop policy if exists analysis_access_required on public.user_favorites;

create or replace function app_private.enforce_favorite_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and auth.uid() is distinct from new.user_id then
    raise exception using errcode = '42501', message = 'Favorite owner mismatch.';
  end if;
  if new.user_id is null then
    raise exception using errcode = '23514', message = 'Favorite owner is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('user_favorites:' || new.user_id::text, 0)
  );
  -- Existing duplicates must reach the unique constraint, allowing idempotent API retries.
  if exists (
    select 1 from public.user_favorites
    where user_id = new.user_id and sale_id = new.sale_id
  ) then return new; end if;
  if not app_private.has_active_analysis_access(new.user_id)
    and not coalesce(public.is_admin(), false)
    and (select count(*) from public.user_favorites where user_id = new.user_id) >= 10 then
    raise exception using errcode = 'P0001', message = 'Quota de 10 favoris gratuits atteint. Retirez un favori pour en ajouter un autre.';
  end if;
  return new;
end;
$$;
revoke all on function app_private.enforce_favorite_quota() from public, anon, authenticated;
drop trigger if exists enforce_favorite_quota on public.user_favorites;
create trigger enforce_favorite_quota
before insert on public.user_favorites
for each row execute function app_private.enforce_favorite_quota();

commit;
