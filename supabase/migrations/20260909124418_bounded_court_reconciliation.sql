-- Bounded variant; all evidence and identity guards remain unchanged.
create or replace function public.reconcile_catalogue_competent_courts_batch(p_after_id uuid default null, p_limit integer default 25)
returns table (
  scanned_count bigint,
  corrected_count bigint,
  already_correct_count bigint,
  blocked_count bigint,
  complete boolean,
  next_cursor uuid,
  has_more boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  bridge_row public.auction_sale_outcome_bridges%rowtype;
  sale_row public.auction_sales%rowtype;
  assignment jsonb;
  verified_court_code text;
  target_court public.outcome_courts%rowtype;
  old_court_id uuid;
  desired_method text;
  desired_input jsonb;
  last_id uuid := p_after_id;
  more_rows boolean;
  total_scanned bigint := 0;
  total_corrected bigint := 0;
  total_already_correct bigint := 0;
  total_blocked bigint := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'Batch limit must be between 1 and 100.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('immojudis:competent-court-reconciliation:v1', 0)
  );

  insert into public.outcome_courts(code, name, court_type, active)
  values ('legacy:unmapped', 'Tribunal non déterminé (pont catalogue)', 'unknown', false)
  on conflict (code) do nothing;

  insert into public.outcome_courts(code, name, court_type, active)
  select tribunal_row.code, tribunal_row.canonical_name, 'tribunal_judiciaire', true
  from public.tribunals tribunal_row
  on conflict (code) do nothing;

  for bridge_row in
    select bridge.*
    from public.auction_sale_outcome_bridges bridge
    join public.auction_sales sale on sale.id = bridge.auction_sale_id
    where p_after_id is null or bridge.id > p_after_id
    order by bridge.id
    limit p_limit
    for update of bridge
  loop
    select sale.* into strict sale_row
    from public.auction_sales sale
    where sale.id = bridge_row.auction_sale_id
    for update;

    last_id := bridge_row.id;
    total_scanned := total_scanned + 1;
    assignment := sale_row.raw_payload->'tribunal_assignment';
    verified_court_code := app_private.auction_sale_verified_court_code(sale_row);
    desired_method := case
      when verified_court_code is null then 'unmapped'
      else 'justice_competence_insee_exact'
    end;

    select court_row.* into target_court
    from public.outcome_courts court_row
    where court_row.code = coalesce(verified_court_code, 'legacy:unmapped');
    if target_court.id is null then
      total_blocked := total_blocked + 1;
      continue;
    end if;

    if verified_court_code is not null then
      insert into public.auction_sale_competent_court_assignments (
        source_key,
        auction_sale_id,
        source_url_snapshot,
        insee_code,
        commune_name,
        court_id,
        court_code,
        court_name,
        official_court_name,
        court_origin_code,
        court_srj_code,
        reference_sha256,
        mapping_method,
        evidence
      ) values (
        bridge_row.source_key,
        sale_row.id,
        sale_row.source_url,
        upper(assignment->>'insee_code'),
        assignment->>'commune_name',
        target_court.id,
        verified_court_code,
        assignment->>'court_name',
        assignment->>'official_court_name',
        assignment->>'court_origin_code',
        assignment->>'court_srj_code',
        assignment->>'reference_sha256',
        'justice_competence_insee_exact',
        assignment
      ) on conflict (source_key, reference_sha256) do nothing;
    end if;

    select round_row.court_id into old_court_id
    from public.auction_rounds round_row
    where round_row.id = bridge_row.round_id;

    desired_input := case
      when verified_court_code is null then jsonb_build_object(
        'schema_version', 'catalogue_court_mapping_v2',
        'mapping_method', 'unmapped',
        'reason', 'no_verified_insee_competence',
        'resolved_outcome_court_id', target_court.id
      )
      else jsonb_build_object(
        'schema_version', 'catalogue_court_mapping_v2',
        'mapping_method', 'justice_competence_insee_exact',
        'insee_code', assignment->>'insee_code',
        'court_code', verified_court_code,
        'court_name', assignment->>'court_name',
        'reference_sha256', assignment->>'reference_sha256',
        'resolved_outcome_court_id', target_court.id
      )
    end;

    if old_court_id = target_court.id
      and bridge_row.court_mapping_method = desired_method
      and bridge_row.court_mapping_input = desired_input then
      total_already_correct := total_already_correct + 1;
      continue;
    end if;

    if not app_private.catalogue_bridge_court_is_reconcilable(
      bridge_row.id,
      target_court.id
    ) then
      total_blocked := total_blocked + 1;
      continue;
    end if;

    update public.auction_cases
    set court_id = target_court.id,
        updated_at = now()
    where id = bridge_row.case_id
      and court_id is distinct from target_court.id;

    update public.auction_rounds
    set court_id = target_court.id,
        updated_at = now()
    where id = bridge_row.round_id
      and court_id is distinct from target_court.id;

    if verified_court_code is not null then
      update public.outcome_addresses address_row
      set insee_code = upper(assignment->>'insee_code'),
          updated_at = now()
      from public.auction_lots lot_row
      where lot_row.id = bridge_row.lot_id
        and address_row.id = lot_row.address_id
        and address_row.insee_code is distinct from upper(assignment->>'insee_code');
    end if;

    update public.auction_sale_outcome_bridges
    set court_mapping_method = desired_method,
        court_mapping_input = desired_input
    where id = bridge_row.id;

    insert into public.catalogue_court_reconciliation_events (
      bridge_id,
      auction_sale_id,
      old_court_id,
      new_court_id,
      mapping_method,
      insee_code,
      reference_sha256
    ) values (
      bridge_row.id,
      sale_row.id,
      old_court_id,
      target_court.id,
      desired_method,
      case when verified_court_code is null then null else upper(assignment->>'insee_code') end,
      case when verified_court_code is null then null else assignment->>'reference_sha256' end
    ) on conflict do nothing;

    total_corrected := total_corrected + 1;
  end loop;

  select exists (
    select 1 from public.auction_sale_outcome_bridges b
    join public.auction_sales s on s.id = b.auction_sale_id
    where last_id is null or b.id > last_id
  ) into more_rows;

  return query select
    total_scanned,
    total_corrected,
    total_already_correct,
    total_blocked,
    total_blocked = 0,
    last_id,
    more_rows;
end;
$$;

revoke all on function public.reconcile_catalogue_competent_courts_batch(uuid, integer) from public, anon, authenticated;
grant execute on function public.reconcile_catalogue_competent_courts_batch(uuid, integer) to service_role;
