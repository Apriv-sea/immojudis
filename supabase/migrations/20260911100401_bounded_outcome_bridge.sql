-- Bounded, idempotent archive batches. No broader API timeout or privileges.
create or replace function app_private.validate_auction_round_local_timezone()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- The default IANA zone is constant; avoid enumerating every installed zone per row.
  if new.local_timezone = 'Europe/Paris' then
    return new;
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_timezone_names timezone_row
    where timezone_row.name = new.local_timezone
  ) then
    raise exception using
      errcode = '23514',
      message = 'Auction rounds require a valid IANA local timezone.';
  end if;
  return new;
end;
$$;

create or replace function public.bridge_auction_sales_to_outcome_graph_batch(p_after_id uuid default null, p_limit integer default 25)
returns table (
  scanned_count bigint,
  created_count bigint,
  reused_count bigint,
  linked_count bigint,
  complete boolean,
  next_cursor uuid,
  has_more boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  sale_row public.auction_sales%rowtype;
  selected_ids uuid[];
  last_id uuid;
  existing_bridge public.auction_sale_outcome_bridges%rowtype;
  stable_source_key text;
  resolved_court_id uuid;
  resolved_address_id uuid;
  created_case_id uuid;
  created_lot_id uuid;
  created_round_id uuid;
  created_announcement_event_id uuid;
  created_unknown_outcome_id uuid;
  catalogue_source_id uuid;
  resolved_court_method text;
  resolved_address_method text;
  court_input jsonb;
  address_input jsonb;
  source_input jsonb;
  catalogue_total bigint := 0;
  bridge_created bigint := 0;
  bridge_reused bigint := 0;
  bridge_linked bigint := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception using errcode = '22023', message = 'Bridge batch size must be between 1 and 25.';
  end if;
  -- One RPC call is one transaction.  The table lock produces a stable scan;
  -- the deletion trigger below remains the final fail-closed guard after this
  -- transaction releases the lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('immojudis:outcome_catalogue_bridge:v1', 0)
  );
  lock table public.auction_sales in share mode;

  insert into public.data_sources (
    name,
    publisher,
    official,
    legal_review_status,
    ingestion_policy,
    active
  ) values (
    'immojudis_catalogue_bridge',
    'Immojudis',
    false,
    'pending',
    'disabled',
    false
  )
  on conflict (name) do nothing;

  select source_row.id into catalogue_source_id
  from public.data_sources source_row
  where source_row.name = 'immojudis_catalogue_bridge';

  if catalogue_source_id is null then
    raise exception using
      errcode = '23514',
      message = 'The Outcome catalogue bridge provenance source is missing.';
  end if;

  insert into public.outcome_courts (
    code,
    name,
    court_type,
    judicial_region,
    active
  )
  select
    tribunal_row.code,
    tribunal_row.canonical_name,
    'tribunal_judiciaire',
    null,
    true
  from public.tribunals tribunal_row
  on conflict (code) do nothing;

  insert into public.outcome_courts (code, name, court_type, active)
  values (
    'legacy:unmapped',
    'Tribunal non déterminé (pont catalogue)',
    'unknown',
    false
  )
  on conflict (code) do nothing;

  select coalesce(array_agg(page.id order by page.id), array[]::uuid[])
  into selected_ids
  from (
    select id from public.auction_sales
    where p_after_id is null or id > p_after_id
    order by id limit p_limit
  ) page;
  catalogue_total := cardinality(selected_ids);
  last_id := selected_ids[cardinality(selected_ids)];

  for sale_row in
    select sale.*
    from public.auction_sales sale
    where sale.id = any(selected_ids)
    order by sale.id
  loop
    stable_source_key := app_private.auction_sale_catalogue_source_key(sale_row.source_url);

    select bridge.* into existing_bridge
    from public.auction_sale_outcome_bridges bridge
    where bridge.source_key = stable_source_key
    for update;

    if found then
      if existing_bridge.source_name_snapshot <> sale_row.source_name
        or existing_bridge.source_url_snapshot <> sale_row.source_url then
        raise exception using
          errcode = '23514',
          message = 'An existing Outcome bridge conflicts with the catalogue source identity.';
      end if;
      if existing_bridge.auction_sale_id is not null
        and existing_bridge.auction_sale_id <> sale_row.id then
        raise exception using
          errcode = '23514',
          message = 'An existing Outcome bridge is attached to another catalogue row.';
      end if;

      update public.auction_sale_outcome_bridges
      set auction_sale_id = sale_row.id
      where id = existing_bridge.id
        and auction_sale_id is null;

      update public.auction_lots
      set auction_sale_id = sale_row.id,
          updated_at = now()
      where id = existing_bridge.lot_id
        and auction_sale_id is null;

      if not exists (
        select 1
        from public.auction_lots lot_row
        join public.auction_rounds round_row
          on round_row.id = existing_bridge.round_id
          and round_row.lot_id = lot_row.id
        join public.auction_events announcement
          on announcement.id = existing_bridge.announcement_event_id
          and announcement.case_id = existing_bridge.case_id
          and announcement.lot_id = lot_row.id
          and announcement.round_id = round_row.id
          and announcement.event_type = 'announcement_observed'
        join public.auction_outcomes unknown_outcome
          on unknown_outcome.id = existing_bridge.unknown_outcome_id
          and unknown_outcome.round_id = round_row.id
          and unknown_outcome.outcome_status = 'unknown'
          and not unknown_outcome.training_eligible
        where lot_row.id = existing_bridge.lot_id
          and lot_row.auction_case_id = existing_bridge.case_id
          and lot_row.auction_sale_id = sale_row.id
      ) then
        raise exception using
          errcode = '23514',
          message = 'An existing Outcome bridge has an incomplete case/lot/round lineage.';
      end if;

      bridge_reused := bridge_reused + 1;
      continue;
    end if;

    if sale_row.tribunal_code is not null then
      select court_row.id into resolved_court_id
      from public.outcome_courts court_row
      where court_row.code = sale_row.tribunal_code;
      resolved_court_method := 'tribunal_code_exact';
    else
      select court_row.id into resolved_court_id
      from public.outcome_courts court_row
      where court_row.code = 'legacy:unmapped';
      resolved_court_method := 'unmapped';
    end if;

    if resolved_court_id is null then
      raise exception using
        errcode = '23514',
        message = 'The catalogue court mapping could not be resolved.';
    end if;

    court_input := jsonb_strip_nulls(jsonb_build_object(
      'tribunal_code', sale_row.tribunal_code,
      'tribunal_label', sale_row.tribunal,
      'department', sale_row.department,
      'city', sale_row.city,
      'resolved_outcome_court_id', resolved_court_id,
      'mapping_method', resolved_court_method
    ));

    address_input := jsonb_strip_nulls(jsonb_build_object(
      'address', sale_row.address,
      'postal_code', sale_row.postal_code,
      'city', sale_row.city,
      'latitude', sale_row.latitude,
      'longitude', sale_row.longitude
    ));

    resolved_address_id := null;
    if address_input = '{}'::jsonb then
      resolved_address_method := 'not_available';
    else
      if nullif(btrim(sale_row.address), '') is not null then
        resolved_address_method := 'catalogue_address_snapshot';
      else
        resolved_address_method := 'catalogue_location_snapshot';
      end if;

      insert into public.outcome_addresses (
        label,
        street,
        postal_code,
        city,
        latitude,
        longitude,
        geocoding_source,
        geocoding_score
      ) values (
        nullif(
          btrim(concat_ws(' ', sale_row.address, sale_row.postal_code, sale_row.city)),
          ''
        ),
        nullif(btrim(sale_row.address), ''),
        nullif(btrim(sale_row.postal_code), ''),
        nullif(btrim(sale_row.city), ''),
        sale_row.latitude::double precision,
        sale_row.longitude::double precision,
        case
          when sale_row.latitude is not null and sale_row.longitude is not null
            then 'auction_sales_snapshot'
          else null
        end,
        null
      )
      returning id into resolved_address_id;
    end if;

    insert into public.auction_cases (
      court_id,
      court_case_number,
      portalis_number,
      procedure_type,
      case_status,
      pursuing_law_firm_label
    ) values (
      resolved_court_id,
      null,
      null,
      'unknown',
      'announced',
      nullif(btrim(sale_row.lawyer_name), '')
    )
    returning id into created_case_id;

    insert into public.auction_lots (
      auction_case_id,
      auction_sale_id,
      lot_number,
      lot_label,
      property_type,
      address_id,
      occupation_status,
      occupation_confidence,
      living_area_m2,
      carrez_area_m2,
      land_area_m2,
      room_count,
      bedroom_count,
      parking_count,
      initial_starting_price_eur,
      active
    ) values (
      created_case_id,
      sale_row.id,
      null,
      nullif(btrim(sale_row.title), ''),
      coalesce(nullif(btrim(sale_row.property_type), ''), 'unknown'),
      resolved_address_id,
      case sale_row.occupancy_status
        when 'vacant' then 'vacant'
        when 'owner_occupied' then 'owner_occupied'
        when 'rented' then 'tenant_occupied'
        when 'occupied' then 'occupied_other'
        when 'squatted' then 'occupied_other'
        else 'unknown'
      end,
      null,
      coalesce(sale_row.habitable_surface_m2, sale_row.surface_m2),
      sale_row.carrez_surface_m2,
      sale_row.land_surface_m2,
      sale_row.rooms_count,
      sale_row.bedrooms_count,
      sale_row.parking_count,
      sale_row.starting_price_eur,
      true
    )
    returning id into created_lot_id;

    insert into public.auction_rounds (
      lot_id,
      round_kind,
      sequence_number,
      scheduled_at,
      local_timezone,
      court_id,
      initial_starting_price_eur,
      effective_starting_price_eur,
      current_status,
      publication_first_seen_at,
      result_first_seen_at,
      status_confidence
    ) values (
      created_lot_id,
      'initial',
      1,
      sale_row.sale_date,
      'Europe/Paris',
      resolved_court_id,
      sale_row.starting_price_eur,
      sale_row.starting_price_eur,
      case
        when sale_row.sale_date is null then 'draft'
        when sale_row.sale_date > statement_timestamp() then 'scheduled'
        else 'unknown_outcome'
      end,
      coalesce(sale_row.first_seen_at, sale_row.created_at, now()),
      null,
      null
    )
    returning id into created_round_id;

    insert into public.auction_events (
      case_id,
      lot_id,
      round_id,
      event_type,
      event_at,
      observed_at,
      source_id,
      payload,
      confidence_score
    ) values (
      created_case_id,
      created_lot_id,
      created_round_id,
      'announcement_observed',
      coalesce(sale_row.first_seen_at, sale_row.created_at, now()),
      coalesce(sale_row.first_seen_at, sale_row.created_at, now()),
      catalogue_source_id,
      jsonb_build_object(
        'source_key', stable_source_key,
        'catalogue_status', 'announced',
        'outcome_status', 'unknown',
        'mapping_version', 'auction-sales-bridge/v1'
      ),
      null
    )
    returning id into created_announcement_event_id;

    insert into public.auction_outcomes (
      round_id,
      version,
      outcome_status,
      initial_hammer_price_eur,
      final_hammer_price_eur,
      result_observed_at,
      canonical_confidence,
      training_eligible
    ) values (
      created_round_id,
      1,
      'unknown',
      null,
      null,
      null,
      null,
      false
    )
    returning id into created_unknown_outcome_id;

    source_input := jsonb_strip_nulls(jsonb_build_object(
      'auction_sale_id_at_bridge', sale_row.id,
      'source_name', sale_row.source_name,
      'source_url', sale_row.source_url,
      'external_id', sale_row.external_id,
      'title', sale_row.title,
      'legacy_status', sale_row.status,
      'sale_date', sale_row.sale_date,
      'starting_price_eur', sale_row.starting_price_eur,
      'property_type', sale_row.property_type,
      'surface_m2', sale_row.surface_m2,
      'habitable_surface_m2', sale_row.habitable_surface_m2,
      'snapshot_note', 'catalogue_only_not_verified_outcome'
    ));

    insert into public.auction_sale_outcome_bridges (
      source_key,
      source_name_snapshot,
      source_url_snapshot,
      external_id_snapshot,
      auction_sale_id,
      case_id,
      lot_id,
      round_id,
      announcement_event_id,
      unknown_outcome_id,
      catalogue_status,
      outcome_status,
      case_mapping_method,
      court_mapping_method,
      address_mapping_method,
      court_mapping_input,
      address_mapping_input,
      source_snapshot,
      training_eligible
    ) values (
      stable_source_key,
      sale_row.source_name,
      sale_row.source_url,
      sale_row.external_id,
      sale_row.id,
      created_case_id,
      created_lot_id,
      created_round_id,
      created_announcement_event_id,
      created_unknown_outcome_id,
      'announced',
      'unknown',
      'isolated_catalogue_listing',
      resolved_court_method,
      resolved_address_method,
      court_input,
      address_input,
      source_input,
      false
    );

    bridge_created := bridge_created + 1;
  end loop;

  select count(*) into bridge_linked
  from public.auction_sales catalogue_sale
  join public.auction_sale_outcome_bridges bridge
    on bridge.source_key = app_private.auction_sale_catalogue_source_key(catalogue_sale.source_url)
    and bridge.auction_sale_id = catalogue_sale.id
    and bridge.source_name_snapshot = catalogue_sale.source_name
    and bridge.source_url_snapshot = catalogue_sale.source_url
  join public.auction_cases case_row on case_row.id = bridge.case_id
  join public.auction_lots lot_row
    on lot_row.id = bridge.lot_id
    and lot_row.auction_case_id = bridge.case_id
    and lot_row.auction_sale_id = catalogue_sale.id
  join public.auction_rounds round_row
    on round_row.id = bridge.round_id
    and round_row.lot_id = bridge.lot_id
  join public.auction_events announcement
    on announcement.id = bridge.announcement_event_id
    and announcement.case_id = bridge.case_id
    and announcement.lot_id = bridge.lot_id
    and announcement.round_id = bridge.round_id
    and announcement.event_type = 'announcement_observed'
  join public.auction_outcomes unknown_outcome
    on unknown_outcome.id = bridge.unknown_outcome_id
    and unknown_outcome.round_id = bridge.round_id
    and unknown_outcome.outcome_status = 'unknown'
    and not unknown_outcome.training_eligible
  where catalogue_sale.id = any(selected_ids)
    and bridge.catalogue_status = 'announced'
    and bridge.outcome_status = 'unknown'
    and not bridge.training_eligible;

  return query select
    catalogue_total,
    bridge_created,
    bridge_reused,
    bridge_linked,
    catalogue_total = bridge_linked,
    last_id,
    exists(select 1 from public.auction_sales where id > last_id);
end;
$$;


create or replace function public.bridge_auction_sales_to_outcome_graph()
returns table(scanned_count bigint, created_count bigint, reused_count bigint, linked_count bigint, complete boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  part record;
  cursor_id uuid;
  scanned bigint := 0;
  created bigint := 0;
  reused bigint := 0;
  linked bigint := 0;
begin
  loop
    select * into part from public.bridge_auction_sales_to_outcome_graph_batch(cursor_id, 25);
    if not part.complete then
      raise exception using errcode = '23514', message = 'Incomplete outcome bridge batch.';
    end if;
    scanned := scanned + part.scanned_count;
    created := created + part.created_count;
    reused := reused + part.reused_count;
    linked := linked + part.linked_count;
    exit when not part.has_more;
    cursor_id := part.next_cursor;
  end loop;
  return query select scanned, created, reused, linked, scanned = linked;
end;
$$;
revoke all on function public.bridge_auction_sales_to_outcome_graph_batch(uuid, integer) from public, anon, authenticated;
grant execute on function public.bridge_auction_sales_to_outcome_graph_batch(uuid, integer) to service_role;
