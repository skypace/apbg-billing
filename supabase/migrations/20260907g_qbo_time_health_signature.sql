-- 20260907g — fix the row shape of ops.fn_qbo_time_sync_health()
--
-- The board's rows are (check_name, status, last_event_at, age_seconds,
-- detail) — FIVE columns. 20260907f declared three. It compiled clean, applied
-- clean, and then threw 42804 "structure of query does not match function
-- result type" on the first read of ops.sync_health(), taking the whole board
-- down until this landed.
--
-- ⚠ Same class of failure as fn_sf_job_sync_coverage's 42702 earlier the same
-- day: plpgsql defers this to EXECUTION, so a successful apply proves nothing
-- about a health check. READ THE BOARD after wiring one in, every time.
--
-- 20260907f now declares the correct five columns too, so re-running either
-- file converges on the same state.

drop function if exists ops.fn_qbo_time_sync_health();

create or replace function ops.fn_qbo_time_sync_health()
returns table (check_name text, status text, last_event_at timestamptz, age_seconds integer, detail text)
language plpgsql security definer set search_path = ops, public as $fn$
#variable_conflict use_column
declare
  v_rows        bigint;
  v_last_txn    date;
  v_last_create timestamptz;
  v_last_run    timestamptz;
  v_err         text;
  v_days        numeric;
begin
  select count(*), max(t.txn_date), max(t.qbo_created_at)
    into v_rows, v_last_txn, v_last_create
  from ops.qbo_time_activities t;

  select max(l.completed_at), max(l.error_message)
    into v_last_run, v_err
  from ops.sync_log l
  where l.source = 'qbo' and l.sync_type = 'time_activities'
    and l.completed_at > now() - interval '3 days';

  check_name    := 'qbo_time_sync';
  last_event_at := v_last_create;
  age_seconds   := case when v_last_create is null then null
                        else extract(epoch from (now() - v_last_create))::int end;

  if v_rows = 0 then
    status := 'yellow';
    detail := 'no QuickBooks time entries mirrored yet — run /api/qbo-time-sync';
    return next; return;
  end if;

  if v_last_run is null then
    status := 'yellow';
    detail := 'no time sync run in 3 days (newest work day ' || coalesce(v_last_txn::text, '—') || ')';
    return next; return;
  end if;

  if v_err is not null then
    status := 'red';
    detail := 'time sync errored: ' || left(v_err, 160);
    return next; return;
  end if;

  -- Measured against CREATION. Entries land ~14 days after the work (measured
  -- 9–20, mean 14) because QuickBooks writes them at payroll close, so a check
  -- that watched the work date would sit permanently amber and teach everyone
  -- to ignore it.
  v_days := extract(epoch from (now() - v_last_create)) / 86400.0;
  if v_days > 21 then
    status := 'red';
    detail := 'QuickBooks has created no time entries in ' || round(v_days) ||
              ' days (newest work day ' || coalesce(v_last_txn::text, '—') ||
              ') — payroll not run, or the QuickBooks Time sync has stopped';
  elsif v_days > 14 then
    status := 'yellow';
    detail := 'newest time entry was created ' || round(v_days) ||
              ' days ago (work day ' || coalesce(v_last_txn::text, '—') ||
              ') — normal lag is ~14 days, worth a look';
  else
    status := 'green';
    detail := v_rows || ' time entries on file, newest work day ' ||
              coalesce(v_last_txn::text, '—') || ' (entries land ~14 days after the work)';
  end if;
  return next;
end $fn$;

revoke all on function ops.fn_qbo_time_sync_health() from public, anon;
grant execute on function ops.fn_qbo_time_sync_health() to authenticated, service_role;

-- Daily at 07:40 UTC. Once a day, deliberately: the feed is two weeks behind by
-- construction, so a 15-minute cadence would be pure QBO traffic for nothing.
select cron.schedule(
  'qbo-time-sync',
  '40 7 * * *',
  $cron$
  select net.http_post(
    url := 'https://apbg-billing.netlify.app/api/qbo-time-sync',
    headers := jsonb_build_object(
      -- The shared cron secret, same value 20260904d's 'qbo-purchasing-sync'
      -- job uses. ⚠ Rotating it means editing BOTH migrations and the Netlify
      -- env var SF_AUTOPOST_CRON_SECRET.
      'x-sf-autopost-secret', '1b50240878fe88f031165ed9c22c777628337f8c4a80e816',
      'Content-Type', 'application/json'
    ),
    body := '{"source":"pg_cron"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
