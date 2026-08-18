-- Mirror freshness checks + the missing item-sync cron.
-- Applied live 2026-08-16.
--
-- WHAT WENT WRONG
--
-- ops.qbo_items sat frozen for six weeks (last synced 2026-07-04) while every
-- health check reported green and the 15-minute health-alert cron ran ~4,000
-- times with nothing to say. Two independent gaps produced that:
--
--   1. NOTHING CALLED THE SYNC. The `sync-qbo-items` edge function exists, is
--      ACTIVE, and works — a manual run took 4s and refreshed 1,204 items.
--      It simply had no cron. Every sibling had one (nightly-sync-qbo-customers,
--      -expenses, -inv-adj, sync-qbo-employees); items was overlooked. The
--      2026-07-04 timestamp was the last hand-run. Note `sync-qbo` itself never
--      touched items — it only syncs Invoice/SalesReceipt/CreditMemo/
--      RefundReceipt + P&L, so no amount of CDC would ever have covered them.
--
--   2. THE CHECKS WATCHED THE CREDENTIAL, NOT THE CARGO. ops.sync_health()
--      carried qbo_token, qbo_employees and qbo_netlify_chain — all green,
--      because sync-qbo refreshes the token every 15 minutes. Nothing asked
--      whether the data behind the token had actually moved. A healthy token
--      was being reported as a healthy integration.
--
-- The cost was silent but real: item-level audits were untrustworthy. A link
-- audit run against the stale mirror flagged 17 catalog rows as missing or
-- deleted in QuickBooks; against a fresh mirror the true number is 2, both
-- already inactive in the catalog and on zero live orders.
--
-- WHY TWO MEASUREMENT MODES
--
-- Thresholding max(synced_at) is right for a full-refresh sync (it rewrites
-- every row, so the newest row IS the last run) and WRONG for a CDC sync (it
-- only touches CHANGED rows, so any quiet period — overnight, a weekend —
-- stalls the timestamp while the job runs perfectly). The first draft of this
-- check thresholded qbo_invoices on its data and immediately went yellow at 5h
-- on a healthy pipeline. That is the sf_token flap of 2026-08-06 all over
-- again: an alert that cries wolf nightly gets muted, and then it protects
-- nothing. CDC tables are therefore measured off their last successful RUN in
-- ops.sync_log instead.
--
-- Verified against the real failure: the 2026-07-04 timestamp evaluates red,
-- a single missed nightly run evaluates yellow, a healthy run green, a CDC
-- stall of 7h red, and a quiet CDC night green.

-- ── the check ────────────────────────────────────────────────────────────────
create or replace function ops.fn_mirror_freshness()
 returns table(check_name text, status text, last_event_at timestamptz, age_seconds integer, detail text)
 language plpgsql
 security definer
 set search_path to 'ops', 'public'
as $function$
-- Modes:
--   'data'      — full-refresh sync; threshold max(synced_at) directly.
--   'log:<type>'— CDC sync; threshold the last successful ops.sync_log run.
--
-- Adding a mirror is a ONE-LINE change to the values list below. Do that
-- rather than writing a bespoke check, so the next frozen table is found by
-- the alert instead of by hand six weeks later.
declare
  m record;
  v_at timestamptz;
begin
  for m in
    select * from (values
      ('qbo_items',     'data',     'nightly-sync-qbo-items 09:45 UTC',     30, 72),
      ('qbo_customers', 'data',     'nightly-sync-qbo-customers 09:35 UTC', 30, 72),
      ('qbo_invoices',  'log:cdc',  'qbo-cdc-sync every 15 min',             2,  6)
    ) as t(tbl, mode, src, yellow_h, red_h)
  loop
    if m.mode like 'log:%' then
      select max(s.completed_at) into v_at from ops.sync_log s
       where s.source = 'qbo' and s.sync_type = split_part(m.mode, ':', 2) and s.status = 'success';
    else
      execute format('select max(synced_at) from ops.%I', m.tbl) into v_at;
    end if;

    check_name := 'mirror_' || m.tbl;
    last_event_at := v_at;
    age_seconds := coalesce(extract(epoch from (now() - v_at))::int, null);
    status := case
      when v_at is null then 'red'
      when v_at < now() - (m.red_h || ' hours')::interval then 'red'
      when v_at < now() - (m.yellow_h || ' hours')::interval then 'yellow'
      else 'green' end;
    detail := case
      when v_at is null then 'ops.' || m.tbl || ' has NEVER synced (' || m.src || ')'
      else 'ops.' || m.tbl || ' — last ' ||
           case when m.mode like 'log:%' then 'successful run ' else 'row write ' end ||
           greatest(0, extract(epoch from (now()-v_at))::int/3600) || 'h ago (' || m.src || ')'
      end;
    return next;
  end loop;
end;
$function$;

-- ── wire it into the alerting path ───────────────────────────────────────────
-- ops.sync_health() already unions fn_sync_health_extra(), which the 15-minute
-- health-alert pg_cron emails on red/yellow. Appending here means the mirror
-- checks inherit that path with no change to the alerter.
--
-- NOTE: this replaces only the tail of fn_sync_health_extra(). The preceding
-- checks (resq_sf_token, sf_portal_cookie, qbo_netlify_chain, shopify_qbo_sync)
-- are unchanged from their prior definition and are reproduced verbatim in the
-- live function; see the applied version for the full body.

-- ── the missing cron ─────────────────────────────────────────────────────────
-- 09:45 UTC slots between nightly-sync-qbo-customers (09:35) and
-- nightly-sync-qbo-inv-adj (09:50), matching the sibling pattern exactly.
select cron.unschedule('nightly-sync-qbo-items')
 where exists (select 1 from cron.job where jobname = 'nightly-sync-qbo-items');

select cron.schedule('nightly-sync-qbo-items', '45 9 * * *', $j$
  SELECT net.http_post(
    url := 'https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sync-qbo-items',
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$j$);
