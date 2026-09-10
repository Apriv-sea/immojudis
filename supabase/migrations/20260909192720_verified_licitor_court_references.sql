-- Official Justice reference capture verified on 2026-09-09.
-- Dataset July 2026; SHA-256 checked against the archived CSV and manifest.
-- No source result, review decision or immutable published snapshot is changed.
do $references$
declare
  ref record;
  target public.outcome_courts%rowtype;
begin
  for ref in select * from (values
    ('justice_tj_1_181','Tribunal judiciaire du Havre','1','181','1','26','Cour d''Appel de Rouen'),
    ('justice_tj_1_200','Tribunal judiciaire des Sables-d''Olonne','1','200','1','29','Cour d''Appel de Poitiers'),
    ('justice_tj_1_126','Tribunal judiciaire de Coutances','1','126','1','2','Cour d''Appel de Caen'),
    ('justice_tj_1_100','Tribunal judiciaire de Châteauroux','1','100','1','3','Cour d''Appel de Bourges'),
    ('justice_tj_1_118','Tribunal judiciaire de Cahors','1','118','1','14','Cour d''Appel d''Agen'),
    ('justice_tj_1_102','Tribunal judiciaire de Bourgoin-Jallieu','1','102','1','12','Cour d''Appel de Grenoble'),
    ('justice_tj_1_208','Tribunal judiciaire d''Évry-Courcouronnes','1','208','9','14815','Cour d''Appel de Paris')
  ) as verified(code,name,origin,srj,appeal_origin,appeal_srj,appeal_name) loop
    insert into public.outcome_courts(code,name,court_type,judicial_region,active)
    values (ref.code,ref.name,'tribunal_judiciaire',ref.appeal_name,true)
    on conflict(code) do nothing;
    select * into strict target from public.outcome_courts where code=ref.code;
    if not target.active or target.court_type <> 'tribunal_judiciaire' then
      raise exception 'Unexpected court state for %', ref.code;
    end if;
    if target.name <> ref.name and not exists (
      select 1 from public.outcome_court_official_references existing
      where existing.court_id=target.id and existing.official_origin_code=ref.origin
        and existing.official_srj_code=ref.srj and existing.official_name=ref.name
    ) then
      raise exception 'Unverified existing court identity for %', ref.code;
    end if;
    insert into public.outcome_court_official_references
      (court_id,court_code,official_origin_code,official_srj_code,official_name,
       judicial_region_origin_code,judicial_region_srj_code,judicial_region,
       source_name,source_url,observed_on,reference_sha256)
    values (target.id,ref.code,ref.origin,ref.srj,ref.name,ref.appeal_origin,ref.appeal_srj,ref.appeal_name,
      'justice_open_data','https://www.data.gouv.fr/datasets/liste-des-juridictions-competentes-pour-les-communes-de-france',
      '2026-09-09','fdd570c31b4f7de9e1670abe5831e63653abf9a1bf0c8e09c730cdf25d406807')
    on conflict do nothing;
    if not exists (
      select 1 from public.outcome_court_official_references existing
      where existing.court_id=target.id and existing.court_code=ref.code
        and existing.official_origin_code=ref.origin and existing.official_srj_code=ref.srj
        and existing.official_name=ref.name and existing.judicial_region_origin_code=ref.appeal_origin
        and existing.judicial_region_srj_code=ref.appeal_srj and existing.judicial_region=ref.appeal_name
        and existing.reference_sha256='fdd570c31b4f7de9e1670abe5831e63653abf9a1bf0c8e09c730cdf25d406807'
    ) then
      raise exception 'Conflicting immutable official reference for %', ref.code;
    end if;
  end loop;
end;
$references$;

-- No publication approval or source-result modification.
-- Exact historic label, anchored to official origin 1 / SRJ 208.
-- Evidence: https://www.cours-appel.justice.fr/paris/tribunal-judiciaire-devry
-- Current: https://www.justice.fr/annuaire/tribunal-judiciaire-%C3%A9vry-courcouronnes
-- Resolve raw Licitor court labels conservatively against the current official
-- Justice references. Ambiguous or unmatched labels remain visible for review
-- but are excluded from canonical tribunal statistics.
create or replace view licitor_ingestion.diagnostic_court_mappings
with (security_invoker = true) as
with labels as (
  select
    stats.scope_label as raw_tribunal_label,
    stats.sample_size,
    app_private.normalize_court_label(stats.scope_label) as normalized_label
  from licitor_ingestion.diagnostic_price_statistics stats
  where stats.scope_type = 'tribunal'
), official_names as (
  select distinct
    court.id as court_id,
    app_private.normalize_court_label(reference.official_name) as normalized_official_name
  from public.outcome_court_official_references reference
  join public.outcome_courts court on court.id = reference.court_id
  where court.active
    and court.court_type = 'tribunal_judiciaire'
), candidate_matches as (
  select distinct
    label.raw_tribunal_label,
    official.court_id,
    false as historical_alias
  from labels label
  join official_names official
    on position(official.normalized_official_name in label.normalized_label) > 0
  union all
  select label.raw_tribunal_label, court.id, true
  from labels label
  join public.outcome_courts court
    on court.code = 'justice_tj_1_208'
   and court.active and court.court_type = 'tribunal_judiciaire'
  where label.normalized_label = app_private.normalize_court_label('Tribunal Judiciaire d''Évry (Essonne)')
    and exists (
      select 1 from public.outcome_court_official_references reference
      where reference.court_id = court.id
        and reference.official_origin_code = '1'
        and reference.official_srj_code = '208'
        and reference.official_name = 'Tribunal judiciaire d''Évry-Courcouronnes'
    )
), match_sets as (
  select
    label.raw_tribunal_label,
    label.normalized_label,
    label.sample_size,
    coalesce(
      array_agg(distinct candidate.court_id order by candidate.court_id)
        filter (where candidate.court_id is not null),
      array[]::uuid[]
    ) as court_ids,
    bool_or(coalesce(candidate.historical_alias, false)) as historical_alias
  from labels label
  left join candidate_matches candidate
    on candidate.raw_tribunal_label = label.raw_tribunal_label
  group by label.raw_tribunal_label, label.normalized_label, label.sample_size
)
select
  match_set.raw_tribunal_label,
  match_set.normalized_label,
  match_set.sample_size,
  cardinality(match_set.court_ids)::integer as candidate_count,
  case cardinality(match_set.court_ids)
    when 0 then 'unmatched'
    when 1 then case when match_set.historical_alias then 'unique_verified_historical_alias' else 'unique_official_name_contained' end
    else 'ambiguous'
  end as mapping_status,
  case when cardinality(match_set.court_ids) = 1 then court.id end as court_id,
  case when cardinality(match_set.court_ids) = 1 then court.code end as court_code,
  case when cardinality(match_set.court_ids) = 1 then court.name end as court_name,
  case when cardinality(match_set.court_ids) = 1 then court.judicial_region end as judicial_region,
  false as publication_eligible,
  'pending'::text as review_status
from match_sets match_set
left join public.outcome_courts court
  on cardinality(match_set.court_ids) = 1
 and court.id = match_set.court_ids[1];

-- Keep populations, grants, immutable snapshots and the existing review gate.
do $patch$
declare
  object_name text;
  definition text;
  updated_definition text;
begin
  foreach object_name in array array['diagnostic_canonical_price_statistics', 'diagnostic_price_enrichments'] loop
    definition := pg_catalog.pg_get_viewdef(pg_catalog.to_regclass('licitor_ingestion.' || object_name), true);
    updated_definition := replace(definition,
      'mapping.mapping_status = ''unique_official_name_contained''::text',
      'mapping.mapping_status in (''unique_official_name_contained'', ''unique_verified_historical_alias'')');
    if updated_definition is null or updated_definition = definition then
      raise exception 'Unexpected mapping consumer: %', object_name;
    end if;
    execute format('create or replace view licitor_ingestion.%I with (security_invoker=true) as %s', object_name, updated_definition);
  end loop;
  definition := pg_catalog.pg_get_functiondef('licitor_ingestion.stage_adjudication_price_statistics_build(text[])'::regprocedure);
  updated_definition := replace(replace(definition,
    'mapping.mapping_status = ''unique_official_name_contained''',
    'mapping.mapping_status in (''unique_official_name_contained'', ''unique_verified_historical_alias'')'),
    'mapping.mapping_status <> ''unique_official_name_contained''',
    'mapping.mapping_status not in (''unique_official_name_contained'', ''unique_verified_historical_alias'')');
  if updated_definition is null or updated_definition = definition then
    raise exception 'Unexpected staging mapping consumer';
  end if;
  execute updated_definition;
end;
$patch$;
