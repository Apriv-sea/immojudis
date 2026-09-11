begin;
select plan(3);
select lives_ok($$select * from public.search_auction_sales_preview_v4(p_min_sale_date=>'2026-09-11',p_max_sale_date=>'2026-09-30',p_limit=>1)$$, 'public date range executes');
select throws_ok($$select * from public.search_auction_sales_preview_v4(p_min_sale_date=>'2026-10-01',p_max_sale_date=>'2026-09-01')$$, '22023', 'Invalid sale date range.', 'inverted date range is rejected');
set local role anon;
select throws_ok($$select * from public.search_auction_sales_preview_v4(p_occupancy_status=>'free')$$, '42501', 'Protected filters are not available in the public preview.', 'date search preserves protected filter boundary');
reset role;
select * from finish();
rollback;
