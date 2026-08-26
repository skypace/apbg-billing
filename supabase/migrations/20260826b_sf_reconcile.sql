-- 20260826b_sf_reconcile.sql
-- Weekly SF ↔ Brixpense expense reconciliation (sf-expense-reconcile-background):
-- every Monday, re-read every SF expense on recently-updated Invoiced jobs,
-- verify each exists in ops.expense_requests, auto-land the stranded ones via
-- ?landJob=, and email a digest only when something was found.
--
-- Four pieces, all here so the pipeline ships WITH its watcher (the repo rule):
--   1. sync_log source allow-list gains 'sf-reconcile' — the CHECK rejects
--      unknown sources and every writer wraps its log insert in try/catch, so
--      skipping this step means the runs log NOTHING and the health check
--      below reads green forever (the exact v0.5.0 silent-outage shape).
--   2. ops.fn_sf_reconcile_health() — red on an errored run or >8 days silent.
--   3. Wire into ops.fn_sync_health_extra() via READ-MODIFY-WRITE of the live
--      definition. NEVER rebuild that function from a copy in a migration —
--      that is how the distributor_notify monitor got silently deleted on
--      2026-08-21. The DO block below raises if the anchor moved.
--   4. pg_cron 'sf-expense-reconcile' — Mondays 16:00 UTC.

-- 1 ── allow the new sync_log source ------------------------------------------
alter table ops.sync_log drop constraint if exists sync_log_source_check;
alter table ops.sync_log add constraint sync_log_source_check check (
  source is null or source = any (array[
    'qbo','sf','sf-receipt-sync','sf-expense-sweep','sf-inbound','sf-cancel',
    'sf-connect','invoice-inbound','resq-sync-tick','resq-sync-watch',
    'resq-inbound','fleet','fleetcomplete','zoho_crm','bambee','pg_net',
    'brixpense','distributor','vendors','sf-reconcile'
  ])
) not valid;

-- 2 ── the watcher -------------------------------------------------------------
create or replace function ops.fn_sf_reconcile_health()
returns table(check_name text, status text, last_event_at timestamptz, age_seconds integer, detail text)
language plpgsql
security definer
set search_path to 'ops', 'public'
as $$
declare
  v_at timestamptz;
  v_status text;
  v_err text;
  v_missing int;
begin
  select s.completed_at, s.status, s.error_message,
         coalesce((s.metadata->>'missing')::int, 0)
    into v_at, v_status, v_err, v_missing
    from ops.sync_log s
    where s.source = 'sf-reconcile'
    order by s.completed_at desc nulls last limit 1;

  check_name := 'sf_reconcile';
  last_event_at := v_at;
  age_seconds := coalesce(extract(epoch from (now() - v_at))::int, null);
  if v_at is null then
    -- Deliberately green: "has not run yet" is expected until the first
    -- Monday. The 8-day rule takes over after the first run.
    status := 'green';
    detail := 'weekly SF expense reconciliation has not run yet (fires Mondays 16:00 UTC)';
  else
    status := case
      when v_status = 'error' then 'red'
      when v_at < now() - interval '8 days' then 'red'
      else 'green' end;
    detail := 'weekly SF reconciliation last ran ' || greatest(0, extract(epoch from (now()-v_at))::int/86400) || 'd ago'
      || case when v_missing > 0 then ' [' || v_missing || ' stranded expense(s) found on last run]' else '' end
      || case when v_status = 'error' then ' [ERROR: ' || coalesce(left(v_err,140),'') || ']' else '' end;
  end if;
  return next;
end;
$$;

-- Reached only from inside ops.sync_health() (SECURITY DEFINER, owned by
-- postgres) — the 2026-08-23 lesson: never leave a health helper callable
-- with the anon/authenticated key.
revoke all on function ops.fn_sf_reconcile_health() from public, anon, authenticated;

-- 3 ── wire into fn_sync_health_extra (read-modify-write on the LIVE def) ------
do $$
declare
  v_def text;
  v_anchor text := '  -- Bills paid in QuickBooks outside Brixpense.';
  v_insert text := '  -- Weekly SF expense reconciliation (did the sweeps see everything?).' || chr(10)
    || '  return query select * from ops.fn_sf_reconcile_health();' || chr(10) || chr(10);
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';
  if v_def is null then
    raise exception 'ops.fn_sync_health_extra not found — wire fn_sf_reconcile_health by hand';
  end if;
  if position('fn_sf_reconcile_health' in v_def) > 0 then
    raise notice 'fn_sf_reconcile_health already wired — skipping';
    return;
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'anchor line not found in live fn_sync_health_extra — it changed shape; wire fn_sf_reconcile_health by hand instead of guessing';
  end if;
  v_def := replace(v_def, v_anchor, v_insert || v_anchor);
  execute v_def;
end;
$$;

-- 4 ── the schedule ------------------------------------------------------------
-- Mondays 16:00 UTC (after the 15:00 handbook sweep and 15:30 compliance
-- digest, so the Monday emails arrive in a predictable order). Same secret
-- header the other Netlify-background crons use.
select cron.schedule(
  'sf-expense-reconcile',
  '0 16 * * 1',
  $cron$
  select net.http_post(
    url := 'https://apbg-billing.netlify.app/api/sf-expense-reconcile-background',
    headers := jsonb_build_object(
      'x-sf-autopost-secret', '1b50240878fe88f031165ed9c22c777628337f8c4a80e816',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $cron$
);
