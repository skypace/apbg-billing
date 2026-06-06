-- SF admin-portal encrypted job id, for deep-linking a Brixpense expense draft
-- straight to its Service Fusion job page:
--   https://admin.servicefusion.com/jobs/jobView?id=<sf_admin_job_id>
-- Populated by the sf-receipt-sync edge function (resolved via the admin
-- /serviceSpot/loadGlobalSearchResults lookup). Stable per job.
alter table ops.expense_requests add column if not exists sf_admin_job_id text;
comment on column ops.expense_requests.sf_admin_job_id is
  'SF admin-portal encrypted job id. Deep link: https://admin.servicefusion.com/jobs/jobView?id=<sf_admin_job_id>. Populated by sf-receipt-sync.';
