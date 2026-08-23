-- Full gate: no expense auto-posts to QuickBooks anymore, period.
-- (Sky, 2026-08-14, immediately after the OCR-gate PR merged.)
--
-- Applied live to gfsdpwiqzshhexkofiif via Supabase MCP.
--
-- What changed in the app code (netlify/functions/expense-request-notify.mjs,
-- expense-request-link-bill.mjs):
--   - expense-request-notify no longer calls QBO at all for request_type=
--     'expense'. Submit now only auto-approves (draft -> approved) — the
--     same "no manager workflow" behavior as always, just without the
--     silent QBO write that used to happen in the same request.
--   - expense-request-link-bill is now the ONE place a human explicitly
--     posts to QuickBooks (mode=create), for BOTH the unpaid-Bill case
--     (as_bill=true) and the paid-Purchase case (as_bill=false, which it
--     never supported before). A human must open the approved expense in
--     Brixpense (PendingList "My Submissions" or SF Expenses) and click
--     "Post to QuickBooks" — that IS the "pay attention to the bill" gate.
--   - This applies to every expense, not just Service-Fusion-sourced ones.
--
-- Ops-side changes (this migration):
--   1. Unschedule the 'sf-expense-autopost' pg_cron job entirely — nothing
--      may auto-post SF drafts on a timer anymore. sf-expense-autopost-
--      background.mjs itself is left in place (superadmin-gated,
--      SF_AUTOPOST_ENABLED-gated) as a manual escape hatch only; nothing
--      calls it automatically.
--   2. Drop the sf_expense_autopost check from ops.fn_sync_health_core() —
--      it would otherwise sit permanently red (nothing ever calls that
--      sync_type again) and spam the 15-min health-alert cron forever.
--      sf_expense_ocr's check stays — that pipeline (OCR + bill_number
--      extraction) is still live and still useful, it just no longer feeds
--      an automatic poster.

select cron.unschedule('sf-expense-autopost');

create or replace function ops.fn_sync_health_core()
 returns table(check_name text, status text, last_event_at timestamp with time zone, age_seconds integer, detail text)
 language plpgsql
 security definer
 set search_path to 'ops', 'public'
as $function$
declare
  v_last_synced timestamptz;
  v_emp_count   int;
  v_token       ops.qbo_token_cache%rowtype;
  v_age         int;
  v_sf          ops.sf_token_cache%rowtype;
  v_ts          timestamptz;
  v_run_status  text;
  v_run_err     text;
begin
  select max(c.qbo_synced_at), count(*) into v_last_synced, v_emp_count from ops.qbo_employees_cache c;
  v_age := coalesce(extract(epoch from (now() - v_last_synced))::int, null);
  check_name    := 'qbo_employees';
  last_event_at := v_last_synced;
  age_seconds   := v_age;
  status := case
    when v_last_synced is null then 'red'
    when v_age > 4 * 3600      then 'red'
    when v_age > 90 * 60       then 'yellow'
    else 'green' end;
  detail := case
    when v_last_synced is null then 'cache empty — sync has never run'
    else v_emp_count || ' employees, last sync ' || greatest(0, v_age / 60) || ' min ago' end;
  return next;

  select * into v_token from ops.qbo_token_cache t where t.realm_id = '9130352144155116';
  check_name := 'qbo_token';
  if v_token.realm_id is null then
    last_event_at := null; age_seconds := null; status := 'red';
    detail := 'no token cached for production realm';
  else
    last_event_at := v_token.updated_at;
    age_seconds := extract(epoch from (now() - v_token.updated_at))::int;
    status := case
      when v_token.last_error is not null and v_token.updated_at > now() - interval '15 minutes' then 'red'
      when v_token.access_token_expires_at < now() - interval '5 minutes' then 'yellow'
      else 'green' end;
    detail := 'refresh #' || v_token.refresh_count || ' by ' || coalesce(v_token.last_refreshed_by, '—') ||
      case when v_token.last_error is not null then ' [last_error: ' || v_token.last_error || ']' else '' end;
  end if;
  return next;

  select * into v_sf from ops.sf_token_cache t where t.id = 1;
  check_name := 'sf_token';
  if v_sf.id is null or coalesce(v_sf.refresh_token, '') in ('', 'none') then
    last_event_at := null; age_seconds := null; status := 'red';
    detail := 'no Service Fusion token cached — re-auth (apbg-billing CLAUDE.md → Service Fusion OAuth)';
  else
    last_event_at := v_sf.updated_at;
    age_seconds := coalesce(extract(epoch from (now() - v_sf.updated_at))::int, null);
    status := case
      when v_sf.updated_at is null then 'red'
      when v_sf.last_refresh_error_at is not null and v_sf.last_refresh_error_at > v_sf.updated_at then 'red'
      when v_sf.updated_at < now() - interval '30 hours' then 'red'
      when v_sf.updated_at < now() - interval '8 hours' then 'yellow'
      else 'green' end;
    detail := 'SF token last written ' || coalesce(greatest(0, extract(epoch from (now() - v_sf.updated_at))::int / 3600)::text, '?') || 'h ago' ||
      case when v_sf.last_refresh_error is not null and v_sf.last_refresh_error_at > coalesce(v_sf.updated_at, to_timestamp(0))
           then ' [refresh FAILING: ' || left(v_sf.last_refresh_error, 160) || ' — re-auth per CLAUDE.md → Service Fusion OAuth]'
           else '' end;
  end if;
  return next;

  select max(s.completed_at) into v_ts from ops.sync_log s where s.source = 'sf-receipt-sync' and s.status = 'success';
  select s.status, coalesce(s.error_message, s.metadata->>'error')
    into v_run_status, v_run_err
    from ops.sync_log s where s.source = 'sf-receipt-sync'
    order by s.completed_at desc nulls last limit 1;
  check_name := 'sf_receipt_sync';
  last_event_at := v_ts;
  age_seconds := coalesce(extract(epoch from (now() - v_ts))::int, null);
  status := case
    when v_ts is null then 'red'
    when v_ts < now() - interval '30 hours' then 'red'
    when v_ts < now() - interval '14 hours' then 'yellow'
    else 'green' end;
  detail := case
    when v_ts is null then 'SF expense landing has NEVER logged a successful run'
    else 'last success ' || greatest(0, extract(epoch from (now() - v_ts))::int / 3600) || 'h ago' end ||
    case when v_run_status = 'error' then ' [latest run errored: ' || coalesce(left(v_run_err, 140), '?') || ']' else '' end;
  return next;

  select max(s.completed_at) into v_ts from ops.sync_log s where s.source = 'sf' and s.sync_type = 'sf-expense-ocr' and s.status = 'success';
  check_name := 'sf_expense_ocr';
  last_event_at := v_ts;
  age_seconds := coalesce(extract(epoch from (now() - v_ts))::int, null);
  status := case
    when v_ts is null then 'red'
    when v_ts < now() - interval '52 hours' then 'red'
    when v_ts < now() - interval '27 hours' then 'yellow'
    else 'green' end;
  detail := case when v_ts is null then 'OCR gate has never logged a successful run'
    else 'last success ' || greatest(0, extract(epoch from (now() - v_ts))::int / 3600) || 'h ago (daily 10:15 UTC)' end;
  return next;

  select max(s.completed_at) into v_ts from ops.sync_log s where s.source = 'sf' and s.sync_type = 'jobs' and s.status = 'success';
  check_name := 'sf_jobs_sync';
  last_event_at := v_ts;
  age_seconds := coalesce(extract(epoch from (now() - v_ts))::int, null);
  status := case
    when v_ts is null then 'red'
    when v_ts < now() - interval '52 hours' then 'red'
    when v_ts < now() - interval '27 hours' then 'yellow'
    else 'green' end;
  detail := case when v_ts is null then 'sync-sf has never logged a successful run'
    else 'last success ' || greatest(0, extract(epoch from (now() - v_ts))::int / 3600) || 'h ago (daily 09:00 UTC)' end;
  return next;
end;
$function$;
