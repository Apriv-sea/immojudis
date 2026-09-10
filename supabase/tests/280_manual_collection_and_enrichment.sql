begin;
select plan(3);
select is((select count(*) from cron.job where jobname = 'immojudis-market-valuations' and active), 0::bigint, 'No automatic valuation enrichment');
select is((select count(*) from cron.job where jobname = 'immojudis-licitor-resume' and active), 0::bigint, 'No automatic collector resumption');
select is((select count(*) from licitor_ingestion.control where monthly_enabled), 0::bigint, 'No monthly collection campaign');
select * from finish();
rollback;
