-- Only the FK-triggered detachment of a deleted listing is mutable. Evidence remains immutable.
create or replace function app_private.guard_competent_court_audit_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and tg_table_schema = 'public'
    and tg_table_name in ('auction_sale_competent_court_assignments','catalogue_court_reconciliation_events')
    and pg_trigger_depth() > 1
    and to_jsonb(old)->>'auction_sale_id' is not null
    and to_jsonb(new)->>'auction_sale_id' is null
    and (to_jsonb(new)-'auction_sale_id') = (to_jsonb(old)-'auction_sale_id')
    and not exists(select 1 from public.auction_sales where id=(to_jsonb(old)->>'auction_sale_id')::uuid)
  then return new;
  end if;
  raise exception using errcode='55000', message='Competent-court audit rows are immutable.';
end;
$$;
revoke all on function app_private.guard_competent_court_audit_mutation() from public,anon,authenticated;
create or replace function app_private.guard_court_enrichment_audit_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and tg_table_schema = 'public'
    and tg_table_name in ('auction_sale_court_label_assignments','auction_sale_court_document_assignments')
    and pg_trigger_depth() > 1
    and to_jsonb(old)->>'auction_sale_id' is not null
    and to_jsonb(new)->>'auction_sale_id' is null
    and (to_jsonb(new)-'auction_sale_id') = (to_jsonb(old)-'auction_sale_id')
    and not exists(select 1 from public.auction_sales where id=(to_jsonb(old)->>'auction_sale_id')::uuid)
  then return new;
  end if;
  raise exception using errcode='55000', message='Court enrichment audit rows are immutable.';
end;
$$;
revoke all on function app_private.guard_court_enrichment_audit_mutation() from public,anon,authenticated;
