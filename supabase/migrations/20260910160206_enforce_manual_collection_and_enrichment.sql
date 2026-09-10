-- Collection and enrichment require an explicit operator action.
begin;
select cron.alter_job(jobid, active := false)
from cron.job
where jobname in ('immojudis-market-valuations', 'immojudis-licitor-resume');
update licitor_ingestion.control
set monthly_enabled = false, updated_at = now()
where singleton and monthly_enabled;
commit;
