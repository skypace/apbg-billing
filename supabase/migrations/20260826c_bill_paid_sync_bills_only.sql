-- 20260826c_bill_paid_sync_bills_only.sql
-- The QuickBooks paid-check is for BILLS only. A posted Purchase (as_bill=false)
-- was paid at posting, and its qbo_bill_id is a Purchase id — the sync's Bill
-- query can never find it, so every posted Purchase read as "QuickBooks no
-- longer returns this bill" (20 false positives / $21.6k flagged yellow on
-- 2026-08-26, drowning the 3 REAL deleted-in-QBO bills). Companion code fix:
-- lib/qbo-bill-status.mjs pool query gains as_bill=eq.true.

-- Health counts: same scope, all three (waiting / missing / partial).
create or replace function ops.fn_bill_paid_sync_health()
 returns table(check_name text, status text, last_event_at timestamp with time zone, age_seconds integer, detail text)
 language plpgsql
 security definer
 set search_path to 'ops', 'public'
as $function$
declare
  v_last      timestamptz;
  v_last_err  text;
  v_waiting   int;
  v_missing   int;
  v_partial   int;
begin
  perform ops.fn_assert_internal();

  select max(coalesce(sl.completed_at, sl.started_at)) into v_last
    from ops.sync_log sl
   where sl.source = 'brixpense' and sl.sync_type = 'bill_paid_sync';

  select sl.error_message into v_last_err
    from ops.sync_log sl
   where sl.source = 'brixpense' and sl.sync_type = 'bill_paid_sync'
     and sl.status = 'error'
     and coalesce(sl.completed_at, sl.started_at) > now() - interval '24 hours'
   order by coalesce(sl.completed_at, sl.started_at) desc limit 1;

  -- as_bill = true throughout: Purchases are paid at posting and their ids
  -- are not Bill ids — they have no business in the unpaid-bill pool.
  select count(*) into v_waiting
    from ops.expense_requests r
   where r.qbo_bill_id is not null and r.paid_at is null and r.archived_at is null
     and r.as_bill is true;

  select count(*) into v_missing
    from ops.expense_requests r
   where r.qbo_bill_id is not null and r.paid_at is null and r.archived_at is null
     and r.as_bill is true
     and r.qbo_checked_at is not null and r.qbo_balance is null;

  select count(*) into v_partial
    from ops.expense_requests r
   where r.qbo_bill_id is not null and r.paid_at is null and r.archived_at is null
     and r.as_bill is true
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
end $function$;

-- Wipe the meaningless "checked, not found" stamps the old scope left on
-- posted Purchases — they were never findable as Bills, so the evidence
-- columns carry noise, not information.
update ops.expense_requests
   set qbo_checked_at = null, qbo_balance = null
 where as_bill is false and qbo_checked_at is not null and qbo_balance is null;
