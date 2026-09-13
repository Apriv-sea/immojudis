begin;
select plan(27);
select is(app_private.sale_retention_deadline('2000-01-01 12:00Z','upcoming','{}','{}'),'2000-01-02 12:00Z'::timestamptz,'exactly 24 hours');
select is(app_private.sale_retention_deadline('2026-09-10 00:00Z','upcoming','{}','{"sale_date":"10/09/2026"}'),'2026-09-11 22:00Z'::timestamptz,'date-only retains through Paris civil day plus 24 elapsed hours');
select is(app_private.sale_retention_deadline('2026-03-29 00:00Z','upcoming','{}','{"sale_date":"2026-03-29"}'),'2026-03-30 22:00Z'::timestamptz,'spring DST still uses 24 elapsed hours');
select is(app_private.sale_retention_deadline('2026-10-25 00:00Z','upcoming','{}','{"sale_date":"2026-10-25"}'),'2026-10-26 23:00Z'::timestamptz,'autumn DST still uses 24 elapsed hours');
select is(app_private.sale_retention_deadline('2026-09-10 00:00Z','upcoming','{}','{"sale_date":"2026-09-10T00:00:00Z","date_precision":"  ","sale_date_precision":" day "}'),'2026-09-11 22:00Z'::timestamptz,'trimmed date precision fallback protects legacy midnight normalization');
select is(app_private.sale_retention_deadline('2026-10-25 00:00:00+02:00','upcoming','{}','{"sale_date":"2026-10-25T00:00:00+02:00","date_precision":"day"}'),'2026-10-26 23:00Z'::timestamptz,'aware Paris midnight uses its civil date');
select is(app_private.sale_retention_deadline('2026-09-10 00:00Z','upcoming','{}','{"source_date":"2026-09-10"}'),'2026-09-11 00:00Z'::timestamptz,'source date alone does not infer date-only precision');
select is(app_private.sale_retention_deadline(null,'upcoming','{}','{}'),null::timestamptz,'unknown date retained');
select is(app_private.sale_retention_deadline('2000-01-01','postponed','{}','{}'),null::timestamptz,'postponed sale retained');
select is(app_private.sale_retention_deadline('2000-01-01','upcoming','{"sale_window":{"opens_at":"2000-01-01T12:00:00Z","closes_at":"2000-01-05T12:00:00Z"}}','{}'),'2000-01-06 12:00Z'::timestamptz,'online closing date takes precedence');
select is(app_private.sale_retention_deadline('2000-01-01','upcoming','{"sale_window":{"opens_at":"bad","closes_at":"bad"}}','{}'),null::timestamptz,'malformed explicit window retained');
select is(app_private.sale_retention_deadline('2000-01-01','past','{}','{"status":"Vente reportée"}'),null::timestamptz,'source postponement survives legacy normalization');
select ok(not has_function_privilege('authenticated','public.purge_expired_auction_sales(timestamptz,integer)','execute'),'users cannot purge');
select ok(not has_table_privilege('anon','public.sale_retention_storage_queue','select'),'outbox private');
insert into auth.users(id) values ('ffffffff-ffff-ffff-ffff-ffffffffff70');
insert into public.auction_sales(id,source_name,source_url,status,starting_price_eur,sale_date) values
('ffffffff-ffff-ffff-ffff-ffffffffff71','retention-test','https://example.test/retention/1','upcoming',10000,'2000-01-01 12:00Z'),
('ffffffff-ffff-ffff-ffff-ffffffffff72','retention-test','https://example.test/retention/2','upcoming',10000,'2000-01-02 12:00Z');
insert into public.saved_property_reports(user_id,sale_id,title,report_kind) values ('ffffffff-ffff-ffff-ffff-ffffffffff70','ffffffff-ffff-ffff-ffff-ffffffffff71','Personal simulation','bid_ceiling');
insert into public.sale_workspaces(user_id,sale_id,user_max_bid_eur) values ('ffffffff-ffff-ffff-ffff-ffffffffff70','ffffffff-ffff-ffff-ffff-ffffffffff71',50000);
insert into public.valuation_estimates(auction_sale_id,engine_version,engine_kind,segment) values ('ffffffff-ffff-ffff-ffff-ffffffffff71','test','comparable_ensemble','house');
insert into public.outcome_courts(code,name,court_type) values ('retention:test','Retention test court','unknown');
insert into public.auction_sale_competent_court_assignments(source_key,auction_sale_id,source_url_snapshot,insee_code,commune_name,court_id,court_code,court_name,official_court_name,court_origin_code,court_srj_code,reference_sha256,mapping_method,evidence)
select app_private.auction_sale_catalogue_source_key('https://example.test/retention/1'),'ffffffff-ffff-ffff-ffff-ffffffffff71','https://example.test/retention/1','33063','Bordeaux',id,code,name,name,'1','1',repeat('a',64),'justice_competence_insee_exact','{}' from public.outcome_courts where code='retention:test';
insert into public.auction_sale_court_label_assignments(source_key,auction_sale_id,source_url_snapshot,source_label_snapshot,normalized_source_label,court_id,court_code,court_name,matched_label,normalized_matched_label,mapping_method)
select app_private.auction_sale_catalogue_source_key('https://example.test/retention/1'),'ffffffff-ffff-ffff-ffff-ffffffffff71','https://example.test/retention/1',name,app_private.normalize_court_label(name),id,code,name,name,app_private.normalize_court_label(name),'source_tribunal_label_exact' from public.outcome_courts where code='retention:test';
select throws_ok($$update public.auction_sale_competent_court_assignments set auction_sale_id=null where source_url_snapshot='https://example.test/retention/1'$$,'55000','Competent-court audit rows are immutable.','manual evidence detachment still forbidden');
select throws_ok($$update public.auction_sale_court_label_assignments set court_name='changed' where source_url_snapshot='https://example.test/retention/1'$$,'55000','Court enrichment audit rows are immutable.','evidence content remains immutable');
set local role service_role;
select is((public.purge_expired_auction_sales('2000-01-02 11:59:59Z',25)->>'deleted')::integer,0,'not deleted before boundary');
select is((public.purge_expired_auction_sales('2000-01-02 12:00Z',25)->>'deleted')::integer,1,'deleted at boundary as service role');
reset role;
select is((select count(*) from public.auction_sales where source_name='retention-test'),1::bigint,'younger sale retained');
select is((select count(*) from public.saved_property_reports where user_id='ffffffff-ffff-ffff-ffff-ffffffffff70'),0::bigint,'personal reports removed');
select is((select count(*) from public.sale_workspaces where user_id='ffffffff-ffff-ffff-ffff-ffffffffff70'),0::bigint,'simulation workspace removed');
select is((select count(*) from public.valuation_estimates where engine_version='test' and auction_sale_id='ffffffff-ffff-ffff-ffff-ffffffffff71'),0::bigint,'valuation snapshot removed');
select is((select count(*) from public.auction_sale_outcome_bridges where source_url_snapshot='https://example.test/retention/1' and auction_sale_id is null),1::bigint,'statistical history preserved');
select is((public.purge_expired_auction_sales('2000-01-02 12:00Z',25)->>'deleted')::integer,0,'replay idempotent');
select throws_ok($$select public.purge_expired_auction_sales(now(),26)$$,'22023','Retention requires a timestamp and batch size between 1 and 25.','batch bounded');
select is((select count(*) from public.auction_sale_competent_court_assignments where source_url_snapshot='https://example.test/retention/1' and auction_sale_id is null),1::bigint,'competence evidence retained and detached by FK');
select is((select count(*) from public.auction_sale_court_label_assignments where source_url_snapshot='https://example.test/retention/1' and auction_sale_id is null),1::bigint,'label evidence retained and detached by FK');
select * from finish();
rollback;
