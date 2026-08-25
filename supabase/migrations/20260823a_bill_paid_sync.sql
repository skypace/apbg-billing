-- Ask QuickBooks whether a bill has actually been paid.
--
-- Brixpense stamps paid_at when WE pay a bill (vendor-pay / the Stripe
-- webhook). A bill paid any other way — a cheque written in QuickBooks, QBO
-- Bill Pay, a card run by the bookkeeper — is invisible to us, so it sits in
-- ops.v_ap_aging forever and keeps offering a Pay button for money that has
-- already gone out. QuickBooks is the system of record for that fact and the
-- only place it exists.
--
-- Nothing we mirror can answer it: ops.qbo_expense_lines is line-level and
-- carries no header balance. So the poller asks QBO per bill id.
--
-- Two observation columns, deliberately separate from paid_at:
--   qbo_balance    what QuickBooks last said is still owed on this bill
--   qbo_checked_at when we last asked
-- paid_at stays the DECISION (this bill is settled); the pair above is the
-- EVIDENCE. Keeping them apart is what lets a partial payment be recorded
-- honestly — balance below the total but above zero is not paid, and marking
-- it so would drop a real payable out of the aging view.
--
-- A bill QuickBooks does not return (deleted or voided there) records
-- checked_at with a NULL balance rather than being marked paid. We do not know
-- that it was paid; we know it is gone. The health check surfaces that.

alter table ops.expense_requests
  add column if not exists qbo_balance    numeric,
  add column if not exists qbo_checked_at timestamptz;

comment on column ops.expense_requests.qbo_balance is
  'Open balance QuickBooks last reported for qbo_bill_id. 0 = paid (paid_at is then stamped). NULL after a check means QBO did not return the bill — deleted or voided there, NOT paid.';
comment on column ops.expense_requests.qbo_checked_at is
  'When bill-paid-sync last asked QuickBooks about this bill.';

-- Partial index: the poller only ever looks at posted, unpaid, live bills.
create index if not exists expense_requests_qbo_paid_check_idx
  on ops.expense_requests (qbo_checked_at nulls first)
  where qbo_bill_id is not null and paid_at is null and archived_at is null;

-- ── Watcher ──────────────────────────────────────────────────────────────
-- No pipeline without a watcher (CLAUDE.md). This one guards three failures:
-- the cron stopping, QBO refusing us, and bills that have gone missing in QBO.
--
-- Note the never-run case is YELLOW, not green. Unlike inbound mail — where a
-- quiet day is genuinely quiet — we control this cron, so "posted bills
-- waiting and no run has ever happened" is a config gap, and reading it green
-- is the exact silent-outage shape that let three writers log into a rejecting
-- CHECK constraint unnoticed.
-- ⚠ Two bugs were caught applying this live, both worth knowing:
--   1. The board's contract is FIVE columns (check_name, status, last_event_at,
--      age_seconds, detail). Returning three made ops.sync_health() throw for
--      every caller. Return type cannot change under CREATE OR REPLACE, hence
--      the drop.
--   2. `status` is both an OUT parameter here and a column on ops.sync_log, so
--      an unqualified reference is ambiguous AT RUNTIME, not at create time.
--      Every sync_log read is aliased.
drop function if exists ops.fn_bill_paid_sync_health();

create function ops.fn_bill_paid_sync_health()
returns table (check_name text, status text, last_event_at timestamptz,
               age_seconds integer, detail text)
language plpgsql
security definer
set search_path = ops, public
as $$
declare
  v_last      timestamptz;
  v_last_err  text;
  v_waiting   int;
  v_missing   int;
  v_partial   int;
begin
  -- fn_assert_internal, NOT staff_or_service: this runs inside ops.sync_health(),
  -- whose wrapper asserts exactly this. A stricter inner guard would throw for a
  -- finance or sales login that legitimately passes the front door.
  perform ops.fn_assert_internal();

  select max(coalesce(sl.completed_at, sl.started_at)) into v_last
    from ops.sync_log sl
   where sl.source = 'brixpense' and sl.sync_type = 'bill_paid_sync';

  -- Only an error from the last 24h counts; an old one that has since been
  -- followed by good runs is history, not an outage.
  select sl.error_message into v_last_err
    from ops.sync_log sl
   where sl.source = 'brixpense' and sl.sync_type = 'bill_paid_sync'
     and sl.status = 'error'
     and coalesce(sl.completed_at, sl.started_at) > now() - interval '24 hours'
   order by coalesce(sl.completed_at, sl.started_at) desc limit 1;

  select count(*) into v_waiting
    from ops.expense_requests r
   where r.qbo_bill_id is not null and r.paid_at is null and r.archived_at is null;

  select count(*) into v_missing
    from ops.expense_requests r
   where r.qbo_bill_id is not null and r.paid_at is null and r.archived_at is null
     and r.qbo_checked_at is not null and r.qbo_balance is null;

  select count(*) into v_partial
    from ops.expense_requests r
   where r.qbo_bill_id is not null and r.paid_at is null and r.archived_at is null
     and r.qbo_balance is not null and r.qbo_balance > 0;

  check_name    := 'bill_paid_sync';
  last_event_at := v_last;
  age_seconds   := case when v_last is null then null
                        else floor(extract(epoch from (now() - v_last)))::int end;

  if v_last is null then
    if v_waiting > 0 then
      status := 'yellow';
      detail := v_waiting || ' posted bills are waiting on a QuickBooks paid check and the sync has never run.';
    else
      status := 'green';
      detail := 'No posted bills to check yet; the sync has never needed to run.';
    end if;
  elsif v_last_err is not null then
    status := 'red';
    detail := 'Last QuickBooks paid check errored: ' || left(coalesce(v_last_err,''), 200);
  elsif v_last < now() - interval '48 hours' then
    status := 'red';
    detail := 'No QuickBooks paid check since ' || to_char(v_last, 'YYYY-MM-DD HH24:MI') || ' (runs daily).';
  elsif v_missing > 0 then
    status := 'yellow';
    detail := v_missing || ' bill(s) QuickBooks no longer returns — deleted or voided there. Not marked paid; open them and decide.';
  else
    status := 'green';
    detail := v_waiting || ' unpaid bill(s) tracked'
              || case when v_partial > 0 then ', ' || v_partial || ' partly paid' else '' end
              || '; last checked ' || to_char(v_last, 'YYYY-MM-DD HH24:MI') || '.';
  end if;

  return next;
end $$;

-- Reachable only through ops.sync_health(), which is SECURITY DEFINER and owned by
-- postgres — so the owner's privileges satisfy this call and `authenticated` never
-- needs EXECUTE of its own. See the hygiene block below for why that matters.
revoke execute on function ops.fn_bill_paid_sync_health() from public, anon, authenticated;
grant execute on function ops.fn_bill_paid_sync_health() to service_role;

-- ── Wire it into the board ───────────────────────────────────────────────
-- READ-MODIFY-WRITE against the LIVE definition, never a pasted body. On
-- 2026-08-21 a branch rebuilt this function from an older copy and silently
-- deleted somebody else's distributor_notify check; the anchor assertion below
-- is what makes that impossible here. Idempotent.
do $do$
declare v_src text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';
  if v_src is null then
    raise exception 'ops.fn_sync_health_extra() not found — refusing to invent one';
  end if;
  if position('fn_bill_paid_sync_health' in v_src) > 0 then return; end if;

  v_new := replace(v_src,
    'return query select * from ops.fn_ap_inbox_health();',
    'return query select * from ops.fn_ap_inbox_health();'
      || E'\n\n  -- Bills paid in QuickBooks outside Brixpense.'
      || E'\n  return query select * from ops.fn_bill_paid_sync_health();');

  if v_new = v_src then
    raise exception 'could not find the fn_ap_inbox_health anchor in fn_sync_health_extra — read the live definition and re-anchor';
  end if;
  execute v_new;
end $do$;

-- ── Grant hygiene on the health helpers (found while wiring the above) ───
-- The 20260820b pass revoked EXECUTE from PUBLIC/anon across ops and guarded
-- the SECURITY DEFINER functions. Three health helpers added AFTER it are not
-- covered, because a plain CREATE FUNCTION does not inherit any of that:
--
--   ops.fn_vendor_funding_health   (2026-08-21) — DEFAULT PUBLIC EXECUTE, so
--     callable with the anon key that ships in the JS bundle. It returns the
--     Stripe funding balance and whether we are below the floor.
--   ops.fn_ap_inbox_health         (2026-08-23) — granted to `authenticated`.
--   ops.fn_sync_health_extra       — granted to `authenticated`, and its guard
--     was lost when a later CREATE OR REPLACE overwrote the generated wrapper
--     (the documented trap). ops.sync_health() is still properly wrapped, so
--     the FRONT DOOR was never open; these were side doors.
--
-- Revoking is the whole fix and it breaks nothing: every one of these is only
-- ever reached from inside ops.sync_health(), which is SECURITY DEFINER owned
-- by postgres — permission checks there use the OWNER's privileges, not the
-- caller's. Rewriting three function bodies to add guards would be a bigger,
-- riskier change for the same outcome.
revoke execute on function ops.fn_vendor_funding_health() from public, anon, authenticated;
revoke execute on function ops.fn_ap_inbox_health()       from public, anon, authenticated;
revoke execute on function ops.fn_sync_health_extra()     from public, anon, authenticated;
grant  execute on function ops.fn_vendor_funding_health() to service_role;
grant  execute on function ops.fn_ap_inbox_health()       to service_role;
grant  execute on function ops.fn_sync_health_extra()     to service_role;

-- Stale generator orphan. ops.fn_sync_health_extra__i is a 2026-08-20 inner
-- that was superseded when the outer name was re-created with a real body; it
-- is 6782 chars of pre-AP-inbox history, executable only by postgres, and
-- referenced by nothing (pg_depend clean, no function body mentions it).
-- Dropping it because its presence is actively misleading: it makes
-- fn_sync_health_extra look guard-wrapped when it is not, which is a wrong
-- signal to hand the next person reading this.
drop function if exists ops.fn_sync_health_extra__i();
