begin;

-- Owner policies remain in force; only the paid-plan restriction is removed.
drop policy if exists analysis_access_required on public.user_alerts;
drop policy if exists analysis_access_required on public.user_watched_zones;

create or replace function app_private.enforce_geographic_alert_quota()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  paid boolean;
  resource_limit integer;
  used_count bigint;
  criteria jsonb;
begin
  if auth.uid() is not null and auth.uid() <> new.user_id then
    raise exception using errcode = '42501', message = 'Alert owner mismatch.';
  end if;
  paid := app_private.has_active_analysis_access(new.user_id) or exists (select 1 from public.user_profiles where user_id = new.user_id and (account_tier = 'premium' or user_role = 'admin'));
  resource_limit := case when paid then 25 else 1 end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(tg_table_name || ':' || new.user_id::text, 0));
  if not new.is_active then return new; end if;
  if not paid then
    if tg_table_name = 'user_alerts' then
      if new.min_investment_score is not null or new.min_yield_pct is not null
        or new.min_market_discount_pct is not null or new.occupancy_status is not null
        or cardinality(new.dpe_classes) > 0 or new.require_house_with_land
        or new.alert_frequency <> 'daily' then
        raise exception using errcode = '42501', message = 'Discovery alerts support public criteria and daily notifications only.';
      end if;
      criteria := coalesce(new.advanced_criteria, '{}'::jsonb);
      if nullif(criteria->>'query', '') is not null then
        raise exception using errcode = '42501', message = 'Text search is not supported by Discovery alerts.';
      end if;
    else
      criteria := coalesce(new.alert_defaults, '{}'::jsonb);
      if criteria->>'minInvestmentScore' is not null or criteria->>'minYieldPct' is not null
        or criteria->>'minMarketDiscountPct' is not null
        or coalesce(criteria->'dpeClasses', '[]'::jsonb) <> '[]'::jsonb
        or coalesce(criteria->>'requireHouseWithLand', 'false') <> 'false' then
        raise exception using errcode = '42501', message = 'Discovery zones support public criteria only.';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' and old.user_id = new.user_id and old.is_active then return new; end if;
  if tg_table_name = 'user_alerts' then
    select count(*) into used_count from public.user_alerts
      where user_id = new.user_id and is_active and id <> new.id;
  else
    select count(*) into used_count from public.user_watched_zones
      where user_id = new.user_id and is_active and id <> new.id;
  end if;
  if used_count >= resource_limit then
    raise exception using errcode = 'P0001', message = case when paid and tg_table_name = 'user_alerts' then 'Quota de 25 alertes actives atteint.' when paid then 'Quota de 25 zones surveillées atteint.' else format('Quota de %s alerte(s) ou zone(s) active(s) atteint.', resource_limit) end;
  end if;
  return new;
end;
$$;
revoke all on function app_private.enforce_geographic_alert_quota() from public, anon, authenticated;
drop trigger if exists enforce_user_alerts_quota on public.user_alerts;
create trigger enforce_user_alerts_quota before insert or update on public.user_alerts
for each row execute function app_private.enforce_geographic_alert_quota();
drop trigger if exists enforce_user_watched_zones_quota on public.user_watched_zones;
create trigger enforce_user_watched_zones_quota before insert or update on public.user_watched_zones
for each row execute function app_private.enforce_geographic_alert_quota();

-- Snapshots are server-written. Former paid snapshots stay inaccessible after downgrade.
drop policy if exists analysis_access_required on public.user_alert_matches;
create policy analysis_access_required on public.user_alert_matches as restrictive
for select to authenticated using (
  public.has_analysis_access() or match_snapshot->>'audience' = 'discovery'
);
drop policy if exists analysis_access_required on public.user_alert_notifications;
create policy analysis_access_required on public.user_alert_notifications as restrictive
for all to authenticated using (
  public.has_analysis_access() or notification_snapshot->>'audience' = 'discovery'
) with check (
  public.has_analysis_access() or notification_snapshot->>'audience' = 'discovery'
);
notify pgrst, 'reload schema';
commit;
