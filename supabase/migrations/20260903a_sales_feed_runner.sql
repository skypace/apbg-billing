-- Inventory: the sales feed gets a RUNNER. Until now nothing ran it.
--
-- WHAT WAS FOUND (2026-09-03): 20260902x shipped fn_apply_sales_to_ledger and a
-- mode switch (off / shadow / live), and the Stock → On-Hand panel let a human
-- flip the switch. But NOTHING CALLED THE FUNCTION WITH COMMIT — not a pg_cron
-- job, not the deployed sync-qbo edge function (v47 refreshes the sales view
-- and stops), not another database function, not the panel (it only reads the
-- preview and sets the mode). Checked every caller class before writing this.
-- So "live" would have changed a label and deducted nothing, and the ledger
-- would have gone on losing a day of stock a day with the switch showing green.
--
-- THIS MIGRATION:
--   1. ops.fn_sales_ledger_run() — one call: apply the feed with commit, count
--      what it did, and write ops.sync_log. Honours the mode: in shadow it
--      still runs (so the health check can see the runner is alive) but the
--      inner function writes nothing. Never raises — a failure is RECORDED and
--      returned, because a cron that throws leaves no row behind and reads as
--      "nothing to do".
--   2. pg_cron 'sales-ledger-apply' every 15 minutes at :05/:20/:35/:50 — five
--      minutes AFTER qbo-cdc-sync (:00/:15/:30/:45) pulls the invoices, so each
--      run works the lines the sync just landed.
--   3. ops.fn_sales_feed_health() wired into ops.sync_health() by read-modify-
--      write on the LIVE fn_sync_health_extra (never rebuilt from a copy — the
--      2026-08-21 lesson). Red when a run errors or the cron goes quiet while
--      the feed is live; green in shadow/off, saying so.
--
-- ⚠ Guard rule (20260820b): the runner is SECURITY DEFINER and carries the
-- staff-or-service guard INLINE. pg_cron runs as postgres and passes; a staff
-- login passes; any other authenticated login is refused. EXECUTE is revoked
-- from public/anon.

-- 1 ── allow the new sync_log source ------------------------------------------
-- The allow-list is what stops a typo'd source orphaning a check (2026-08-23).
alter table ops.sync_log drop constraint if exists sync_log_source_check;
alter table ops.sync_log add constraint sync_log_source_check check (
  source is null or source = any (array[
    'qbo','sf','sf-receipt-sync','sf-expense-sweep','sf-inbound','sf-cancel',
    'sf-connect','invoice-inbound','resq-sync-tick','resq-sync-watch',
    'resq-inbound','fleet','fleetcomplete','zoho_crm','bambee','pg_net',
    'brixpense','distributor','vendors','sf-reconcile','inventory'
  ])
) not valid;

-- 2 ── the runner ---------------------------------------------------------------
create or replace function ops.fn_sales_ledger_run()
returns jsonb
language plpgsql
security definer
set search_path to 'ops', 'pg_temp'
as $$
declare
  v_mode     text;
  v_started  timestamptz := clock_timestamp();
  v_new      int := 0;
  v_edited   int := 0;
  v_voided   int := 0;
  v_units    numeric := 0;
  v_pending  int := 0;
  v_result   jsonb;
  v_err      text;
begin
  perform ops.fn_assert_staff_or_service();

  select mode into v_mode from ops.sales_ledger_config;

  if v_mode = 'off' then
    v_result := jsonb_build_object('mode', v_mode, 'written', false,
      'new', 0, 'edited', 0, 'voided', 0, 'units', 0,
      'note', 'feed is off — nothing computed');
  else
    begin
      -- p_commit=true; the inner function itself only WRITES when mode='live'.
      -- In shadow this is a dry run that returns what it would have done.
      select count(*) filter (where action = 'new'),
             count(*) filter (where action = 'edited'),
             count(*) filter (where action = 'voided'),
             coalesce(sum(qty), 0)
        into v_new, v_edited, v_voided, v_units
        from ops.fn_apply_sales_to_ledger(true);

      -- What is STILL pending after the run. Live and correct → 0. Shadow →
      -- everything, by design.
      select count(*) into v_pending from ops.v_sales_ledger_pending where qty_delta <> 0;

      v_result := jsonb_build_object('mode', v_mode, 'written', v_mode = 'live',
        'new', v_new, 'edited', v_edited, 'voided', v_voided, 'units', v_units,
        'pending_after', v_pending);
    exception when others then
      v_err := left(sqlerrm, 500);
      v_result := jsonb_build_object('mode', v_mode, 'written', false, 'error', v_err);
    end;
  end if;

  -- Log every run, including shadow: a run that leaves no row is
  -- indistinguishable from a cron that never fired.
  insert into ops.sync_log (source, sync_type, status, started_at, completed_at,
                            records_synced, error_message, metadata)
  values ('inventory', 'sales_feed',
          case when v_err is null then 'success' else 'error' end,
          v_started, clock_timestamp(),
          case when v_mode = 'live' then v_new + v_edited + v_voided else 0 end,
          v_err, v_result);

  return v_result;
end;
$$;

revoke all on function ops.fn_sales_ledger_run() from public, anon;
grant execute on function ops.fn_sales_ledger_run() to authenticated, service_role;

-- 3 ── the watcher ---------------------------------------------------------------
create or replace function ops.fn_sales_feed_health()
returns table(check_name text, status text, last_event_at timestamptz, age_seconds integer, detail text)
language plpgsql
security definer
set search_path to 'ops', 'public'
as $$
declare
  v_mode    text;
  v_at      timestamptz;
  v_status  text;
  v_err     text;
  v_meta    jsonb;
  v_pending int;
  v_units   numeric;
begin
  select mode into v_mode from ops.sales_ledger_config;
  select s.completed_at, s.status, s.error_message, s.metadata
    into v_at, v_status, v_err, v_meta
    from ops.sync_log s
    where s.source = 'inventory' and s.sync_type = 'sales_feed'
    order by s.completed_at desc nulls last limit 1;
  select count(*), coalesce(sum(qty_delta), 0) into v_pending, v_units
    from ops.v_sales_ledger_pending where qty_delta <> 0;

  check_name := 'sales_feed';
  last_event_at := v_at;
  age_seconds := coalesce(extract(epoch from (now() - v_at))::int, null);

  if v_mode = 'off' then
    status := 'green';
    detail := 'sales feed is OFF — sales are not deducted from the stock ledger (Stock → On-Hand to switch on)';
  elsif v_at is null then
    -- Deliberately green: the cron lands within 15 minutes of this shipping.
    status := 'green';
    detail := 'sales feed runner has not logged yet (pg_cron sales-ledger-apply, every 15 min)';
  else
    status := case
      when v_status = 'error' then 'red'
      when v_at < now() - interval '60 minutes' then (case when v_mode = 'live' then 'red' else 'yellow' end)
      else 'green' end;
    detail := case when v_mode = 'live' then 'LIVE' else 'watching only (shadow)' end
      || ' · last run ' || greatest(0, extract(epoch from (now()-v_at))::int/60) || 'm ago'
      || case when v_mode = 'live'
           then ' · ' || coalesce(v_meta->>'new','0') || ' new / ' || coalesce(v_meta->>'edited','0')
                || ' edited / ' || coalesce(v_meta->>'voided','0') || ' voided line(s) last run'
                || case when v_pending > 0 then ' · ' || v_pending || ' line(s) still pending' else '' end
           else ' · ' || v_pending || ' line(s) / ' || v_units || ' unit(s) it would deduct' end
      || case when v_status = 'error' then ' [ERROR: ' || coalesce(left(v_err,140),'') || ']' else '' end;
  end if;
  return next;
end;
$$;

-- Reached only from inside ops.sync_health() — never callable with the
-- anon/authenticated key on its own.
revoke all on function ops.fn_sales_feed_health() from public, anon, authenticated;

-- 4 ── wire into fn_sync_health_extra (read-modify-write on the LIVE def) ------
do $$
declare
  v_def text;
  v_anchor text := '  -- Bills paid in QuickBooks outside Brixpense.';
  v_insert text := '  -- The stock ledger sales feed (pg_cron sales-ledger-apply, every 15 min).' || chr(10)
    || '  return query select * from ops.fn_sales_feed_health();' || chr(10) || chr(10);
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';
  if v_def is null then
    raise exception 'ops.fn_sync_health_extra not found — wire fn_sales_feed_health by hand';
  end if;
  if position('fn_sales_feed_health' in v_def) > 0 then
    raise notice 'fn_sales_feed_health already wired — skipping';
    return;
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'anchor line not found in live fn_sync_health_extra — it changed shape; wire fn_sales_feed_health by hand instead of guessing';
  end if;
  v_def := replace(v_def, v_anchor, v_insert || v_anchor);
  execute v_def;
end;
$$;

-- 5 ── the schedule ---------------------------------------------------------------
-- Five minutes behind qbo-cdc-sync (*/15), so each run works the invoice lines
-- the sync just landed. A plain SQL job: pg_cron runs it as postgres, which
-- passes the inline guard, and nothing leaves the database.
select cron.schedule(
  'sales-ledger-apply',
  '5,20,35,50 * * * *',
  $cron$ select ops.fn_sales_ledger_run(); $cron$
);
