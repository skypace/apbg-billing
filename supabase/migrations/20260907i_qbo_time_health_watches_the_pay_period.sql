-- 20260907i — the QuickBooks time check watches the PAY PERIOD, not the calendar
--
-- Correction from Sky, same day 20260907g shipped: "This will only post after we
-- run payroll, which is fine."
--
-- 20260907g coloured on DAYS SINCE THE LAST ENTRY WAS CREATED (yellow >14, red
-- >21). Measured against the real posting history, that is the resting state of
-- a healthy feed, not a fault:
--
--   * payroll is SEMI-MONTHLY — periods run 1st–15th and 16th–end of month
--   * a period's entries post 7–11 days AFTER the period closes
--   * so the gap between one posting and the next runs 3–19 days, routinely
--
-- A check with a 14-day threshold therefore goes amber during an ordinary
-- payroll cycle. This repo has already paid for that mistake once: the sf_token
-- yellow rule (fixed 2026-08-06) flapped four times a day on the normal resting
-- state and taught everybody to ignore the board.
--
-- So the question this check asks is the one an operator would ask:
--   HAS THE LAST CLOSED PAY PERIOD POSTED YET?
--
--   green   the closed period has entries — payroll posted
--   green   the closed period has no entries but closed <= 14 days ago — inside
--           the normal 7–11 day window. NOT a problem, and MUST NOT COLOUR.
--   yellow  closed > 14 days ago and still nothing — payroll is late or unrun
--   red     closed > 30 days ago and still nothing — a whole cycle skipped;
--           either payroll has not run or QuickBooks Time has stopped syncing
--
-- age_seconds is how long the closed period has gone unposted (the clock that
-- matters). last_event_at stays the last posting time.
--
-- Idempotent: this is the definition that is live. Re-running converges.

create or replace function ops.fn_qbo_time_sync_health()
returns table (
  check_name    text,
  status        text,
  last_event_at timestamptz,
  age_seconds   int,
  detail        text
)
language plpgsql
security definer
set search_path = ops, public
as $function$
#variable_conflict use_column
declare
  v_rows        bigint;
  v_last_txn    date;
  v_last_post   timestamptz;
  v_last_run    timestamptz;
  v_err         text;
  v_today       date := current_date;
  v_p_start     date;   -- the most recent pay period that has fully CLOSED
  v_p_end       date;
  v_in_period   bigint;
  v_days_closed numeric;
  v_label       text;
begin
  select count(*), max(t.txn_date), max(t.qbo_created_at)
    into v_rows, v_last_txn, v_last_post
  from ops.qbo_time_activities t;

  select max(l.completed_at), max(l.error_message)
    into v_last_run, v_err
  from ops.sync_log l
  where l.source = 'qbo' and l.sync_type = 'time_activities'
    and l.completed_at > now() - interval '3 days';

  check_name    := 'qbo_time_sync';
  last_event_at := v_last_post;

  if v_rows = 0 then
    status := 'yellow'; age_seconds := null;
    detail := 'no QuickBooks time entries mirrored yet — run /api/qbo-time-sync';
    return next; return;
  end if;

  if v_last_run is null then
    status := 'yellow'; age_seconds := null;
    detail := 'no time sync run in 3 days (newest work day ' || coalesce(v_last_txn::text, '—') || ')';
    return next; return;
  end if;

  if v_err is not null then
    status := 'red'; age_seconds := null;
    detail := 'time sync errored: ' || left(v_err, 160);
    return next; return;
  end if;

  -- Semi-monthly: 1st–15th, then 16th–end of month. Walk back to the most
  -- recent period whose END is already behind us.
  if extract(day from v_today) > 15 then
    v_p_start := date_trunc('month', v_today)::date;              -- the 1st–15th just gone
    v_p_end   := date_trunc('month', v_today)::date + 14;
  else
    v_p_start := (date_trunc('month', v_today) - interval '1 month')::date + 15;  -- 16th–EOM of last month
    v_p_end   := date_trunc('month', v_today)::date - 1;
  end if;

  v_days_closed := v_today - v_p_end;
  v_label := to_char(v_p_start, 'DD Mon') || '–' || to_char(v_p_end, 'DD Mon');

  select count(*) into v_in_period
  from ops.qbo_time_activities t
  where t.txn_date between v_p_start and v_p_end;

  -- The clock that matters is how long the closed period has gone unposted.
  age_seconds := (v_days_closed * 86400)::int;

  if v_in_period > 0 then
    status := 'green';
    detail := v_rows || ' time entries on file — the ' || v_label ||
              ' pay period has posted (' || v_in_period || ' entries). Payroll is ' ||
              'semi-monthly and posts 7–11 days after a period closes.';
  elsif v_days_closed > 30 then
    status := 'red';
    detail := 'the ' || v_label || ' pay period closed ' || round(v_days_closed) ||
              ' days ago and has still not posted — a whole cycle has been skipped; ' ||
              'check payroll ran and that QuickBooks Time is still syncing to QuickBooks';
  elsif v_days_closed > 14 then
    status := 'yellow';
    detail := 'the ' || v_label || ' pay period closed ' || round(v_days_closed) ||
              ' days ago and has not posted yet — it normally lands within 7–11 days, ' ||
              'so payroll is either late or has not been run';
  else
    -- Inside the normal posting window. Not a problem, and must not colour.
    status := 'green';
    detail := v_rows || ' time entries on file, newest work day ' ||
              coalesce(v_last_txn::text, '—') || '. The ' || v_label ||
              ' pay period closed ' || round(v_days_closed) ||
              ' days ago and normally posts 7–11 days after payroll runs.';
  end if;
  return next;
end $function$;

revoke all on function ops.fn_qbo_time_sync_health() from public, anon;
grant execute on function ops.fn_qbo_time_sync_health() to authenticated, service_role;
