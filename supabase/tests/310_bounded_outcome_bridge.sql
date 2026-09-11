begin;
select plan(11);
select ok(not has_function_privilege('anon','public.bridge_auction_sales_to_outcome_graph_batch(uuid,integer)','EXECUTE'),'no anonymous bridge access');
select ok(has_function_privilege('service_role','public.bridge_auction_sales_to_outcome_graph_batch(uuid,integer)','EXECUTE'),'worker can bridge batches');
insert into public.auction_sales(id,source_name,source_url,status,starting_price_eur,sale_date) values
('ffffffff-ffff-ffff-ffff-ffffffffff01','batch-test','https://example.test/batch/1','upcoming',12345.67,now()+interval '7 days'),
('ffffffff-ffff-ffff-ffff-ffffffffff02','batch-test','https://example.test/batch/2','upcoming',22345.67,now()+interval '7 days'),
('ffffffff-ffff-ffff-ffff-ffffffffff03','batch-test','https://example.test/batch/3','upcoming',32345.67,now()+interval '7 days');
create temporary table first_batch as select * from public.bridge_auction_sales_to_outcome_graph_batch('ffffffff-ffff-ffff-ffff-ffffffffff00',2);
select is((select scanned_count from first_batch),2::bigint,'bounded scan');
select ok((select complete and has_more from first_batch),'first batch complete but catalogue has more');
select is((select next_cursor from first_batch),'ffffffff-ffff-ffff-ffff-ffffffffff02'::uuid,'cursor is last processed row');
select is((select reused_count from public.bridge_auction_sales_to_outcome_graph_batch('ffffffff-ffff-ffff-ffff-ffffffffff00',2)),2::bigint,'batch replay reuses immutable lineage');
select ok((select complete and not has_more and scanned_count=1 from public.bridge_auction_sales_to_outcome_graph_batch('ffffffff-ffff-ffff-ffff-ffffffffff02',2)),'second batch finishes');
select is((select round_row.initial_starting_price_eur from public.auction_rounds round_row join public.auction_sale_outcome_bridges b on b.round_id=round_row.id where b.auction_sale_id='ffffffff-ffff-ffff-ffff-ffffffffff01'),12345.67::numeric,'price precision preserved');
select throws_ok($$select * from public.bridge_auction_sales_to_outcome_graph_batch(null,26)$$,'22023','Bridge batch size must be between 1 and 25.','batch upper bound enforced');
select throws_ok($$update public.auction_rounds set local_timezone='Not/AZone' where id=(select round_id from public.auction_sale_outcome_bridges where auction_sale_id='ffffffff-ffff-ffff-ffff-ffffffffff01')$$,'23514','Auction rounds require a valid IANA local timezone.','invalid timezone still rejected');
select lives_ok($$insert into public.auction_rounds(lot_id,round_kind,sequence_number,local_timezone,court_id,previous_round_id) select lot_id,'postponed',2,'America/Guadeloupe',court_id,id from public.auction_rounds where id=(select round_id from public.auction_sale_outcome_bridges where auction_sale_id='ffffffff-ffff-ffff-ffff-ffffffffff01')$$,'overseas timezone still accepted');
select * from finish();
rollback;
