-- Active acquisition window, not a publication/quality eligibility view.
-- Keep older candidates and immutable evidence in the existing private archive.
create view licitor_ingestion.active_candidates
with (security_invoker = true) as
select c.* from licitor_ingestion.candidates c
where case
  when c.payload->>'sale_date' ~ '^\d{4}-\d{2}-\d{2}$'
       and pg_catalog.pg_input_is_valid(c.payload->>'sale_date', 'date')
  then (c.payload->>'sale_date')::date between
       ((now() at time zone 'UTC')::date - interval '3 years')::date
       and (now() at time zone 'UTC')::date
  else false
end;
revoke all on licitor_ingestion.active_candidates from public, anon, authenticated;
grant select on licitor_ingestion.active_candidates to licitor_collector;
comment on view licitor_ingestion.active_candidates is
  'Private candidates within three rolling calendar years (UTC, inclusive). Not reviewed or publication eligible. Older evidence remains archived.';