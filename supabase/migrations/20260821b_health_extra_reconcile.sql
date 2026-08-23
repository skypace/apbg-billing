-- Reconcile ops.fn_sync_health_extra across two parallel branches (2026-08-21).
--
-- The vendor-portal branch and the sub-distributor branch BOTH re-declared this
-- whole function on the same day. Mine applied second, so it silently dropped
-- the distributor_notify check that 20260820b_rpc_guard_anon_hygiene.sql had
-- added — leaving the partner notification scan unmonitored, which is exactly
-- the silent-outage class this health system exists to prevent.
--
-- This restores it. The body below is the UNION: every pre-existing check,
-- distributor_notify, and the vendor_payments + vendor_funding calls.
--
-- Rule this cost us: NEVER re-declare fn_sync_health_extra from a copy in an
-- older migration. Read the LIVE definition (pg_get_functiondef) first and add
-- your check to that, or the last writer of the day wins and someone's monitor
-- disappears without a trace.

CREATE OR REPLACE FUNCTION ops.fn_sync_health_extra()
 RETURNS TABLE(check_name text, status text, last_event_at timestamp with time zone, age_seconds integer, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'orders', 'public'
AS $function$
declare
  v_resq ops.resq_sf_token_cache%rowtype;
  v_cookie_at timestamptz;
  v_fb_at timestamptz;
  v_fb_err text;
  v_shop ops.shopify_sync_config%rowtype;
  v_err_ct int;
  v_unmapped_ct int;
  v_chase_at timestamptz;
  v_chase_status text;
  v_chase_err text;
  v_dn_at timestamptz;
  v_dn_status text;
  v_dn_err text;
begin
  select * into v_resq from ops.resq_sf_token_cache t order by t.updated_at desc nulls last limit 1;
  check_name := 'resq_sf_token';
  if v_resq.id is null or coalesce(v_resq.refresh_token,'') = '' then
    last_event_at := null; age_seconds := null; status := 'red';
    detail := 'no ResQ SF token cached — re-auth via sf-connect (?start=1&secret=…)';
  else
    last_event_at := v_resq.updated_at;
    age_seconds := coalesce(extract(epoch from (now() - v_resq.updated_at))::int, null);
    status := case
      when v_resq.refresh_token_expires_at is not null and v_resq.refresh_token_expires_at < now() then 'red'
      when v_resq.last_error is not null and v_resq.updated_at > now() - interval '2 hours' then 'red'
      when v_resq.updated_at < now() - interval '72 hours' then 'yellow'
      else 'green' end;
    detail := 'ResQ SF token refresh #' || coalesce(v_resq.refresh_count::text,'?') ||
      case when v_resq.last_error is not null then ' [last_error: ' || left(v_resq.last_error,140) || ']' else '' end;
  end if;
  return next;

  select s.updated_at into v_cookie_at from orders.sf_portal_session s where s.id = 1;
  check_name := 'sf_portal_cookie';
  last_event_at := v_cookie_at;
  age_seconds := coalesce(extract(epoch from (now() - v_cookie_at))::int, null);
  status := case
    when v_cookie_at is null then 'red'
    when v_cookie_at < now() - interval '30 days' then 'red'
    when v_cookie_at < now() - interval '14 days' then 'yellow'
    else 'green' end;
  detail := case when v_cookie_at is null then 'no SF admin-portal session cookie — receipt images cannot attach'
    else 'SF admin-portal cookie last refreshed ' || greatest(0, extract(epoch from (now()-v_cookie_at))::int/86400) || 'd ago (Make hook refreshes on demand)' end;
  return next;

  select s.completed_at, s.error_message into v_fb_at, v_fb_err
    from ops.sync_log s
    where s.source = 'qbo' and s.sync_type = 'netlify_token_fallback'
    order by s.completed_at desc nulls last limit 1;
  check_name := 'qbo_netlify_chain';
  last_event_at := v_fb_at;
  age_seconds := coalesce(extract(epoch from (now() - v_fb_at))::int, null);
  status := case
    when v_fb_at is not null and v_fb_at > now() - interval '24 hours' then 'red'
    else 'green' end;
  detail := case
    when v_fb_at is not null and v_fb_at > now() - interval '24 hours'
      then 'Billing QBO chain BROKEN — riding shared edge token. Re-auth via Master Control → Connections. [' || coalesce(left(v_fb_err,140),'') || ']'
    when v_fb_at is not null
      then 'own chain healthy (last fallback signal ' || greatest(0, extract(epoch from (now()-v_fb_at))::int/86400) || 'd ago)'
    else 'own chain healthy (no fallback signals on record)' end;
  return next;

  select * into v_shop from ops.shopify_sync_config c where c.id = 1;
  select count(*) into v_err_ct from ops.shopify_sync_orders o
    where o.status = 'error' and o.updated_at > now() - interval '24 hours';
  select count(*) into v_unmapped_ct from ops.shopify_sync_orders o
    where o.had_unmapped_sku and o.updated_at > now() - interval '7 days';
  check_name := 'shopify_qbo_sync';
  last_event_at := v_shop.last_run_at;
  age_seconds := coalesce(extract(epoch from (now() - v_shop.last_run_at))::int, null);
  if v_shop.id is null or not v_shop.enabled then
    status := 'green';
    detail := 'shopify-qbo-sync not yet enabled (awaiting Shopify custom-app token + channel-app disconnect)';
  else
    status := case
      when v_err_ct > 0 then 'red'
      when v_shop.last_run_at is null or v_shop.last_run_at < now() - interval '2 hours' then 'red'
      when v_unmapped_ct > 0 then 'yellow'
      else 'green' end;
    detail := 'orders sync: ' || coalesce((v_shop.last_result->>'summary'), 'no result yet')
      || case when v_err_ct > 0 then ' [' || v_err_ct || ' order(s) in error — see ops.shopify_sync_orders]' else '' end
      || case when v_unmapped_ct > 0 then ' [' || v_unmapped_ct || ' order(s) with unmapped SKUs — add to ops.shopify_item_map]' else '' end;
  end if;
  return next;

  -- Vendor document chase (Vendor Portal Phase 2): the Monday cron logs every
  -- run, chases or not. Red = latest run errored; yellow = weekly run missed
  -- by >1 day; green before the first run (feature freshly shipped).
  select s.completed_at, s.status, s.error_message into v_chase_at, v_chase_status, v_chase_err
    from ops.sync_log s
    where s.source = 'vendors' and s.sync_type = 'vendor_doc_chase'
    order by s.completed_at desc nulls last limit 1;
  check_name := 'vendor_doc_chase';
  last_event_at := v_chase_at;
  age_seconds := coalesce(extract(epoch from (now() - v_chase_at))::int, null);
  if v_chase_at is null then
    status := 'green';
    detail := 'vendor document chase has not run yet (fires Mondays with the compliance digest)';
  else
    status := case
      when v_chase_status = 'error' then 'red'
      when v_chase_at < now() - interval '8 days' then 'yellow'
      else 'green' end;
    detail := 'weekly vendor COI/W-9 chase last ran ' || greatest(0, extract(epoch from (now()-v_chase_at))::int/86400) || 'd ago'
      || case when v_chase_status = 'error' then ' [ERROR: ' || coalesce(left(v_chase_err,140),'') || ']' else '' end;
  end if;
  return next;

  -- Sub-distributor notification scan (distributor-notify.mjs, every 15 min).
  -- A dead scan means partner orders / short receipts / agreement events go
  -- silently un-emailed. Restored here after the 2026-08-21 clobber: two
  -- parallel sessions each re-declared this whole function, and the later
  -- apply (the vendor-funding one) dropped this check. Any future check MUST
  -- be added to the CURRENT live body, never to a stale copy.
  select s.completed_at, s.status, s.error_message into v_dn_at, v_dn_status, v_dn_err
    from ops.sync_log s
    where s.source = 'distributor' and s.sync_type = 'distributor_notify'
    order by s.completed_at desc nulls last limit 1;
  check_name := 'distributor_notify';
  last_event_at := v_dn_at;
  age_seconds := coalesce(extract(epoch from (now() - v_dn_at))::int, null);
  if v_dn_at is null then
    status := 'green';
    detail := 'distributor notification scan has not logged yet (first run lands within 15 min of deploy)';
  else
    status := case
      when v_dn_status = 'error' then 'red'
      when v_dn_at < now() - interval '12 hours' then 'red'
      when v_dn_at < now() - interval '2 hours' then 'yellow'
      else 'green' end;
    detail := 'sub-distributor notify scan last ran ' || greatest(0, extract(epoch from (now()-v_dn_at))::int/60) || 'm ago'
      || case when v_dn_status = 'error' then ' [ERROR: ' || coalesce(left(v_dn_err,140),'') || ']' else '' end;
  end if;
  return next;

  -- Vendor payment ledger + the Stripe funding float (Vendor Portal Phase 3/3b).
  return query select * from ops.fn_vendor_payments_health();
  return query select * from ops.fn_vendor_funding_health();

  -- Mirror staleness for every QBO mirror table. See ops.fn_mirror_freshness()
  -- for the modes and why CDC tables must be measured off sync_log, not data.
  return query select * from ops.fn_mirror_freshness();
end;
$function$;
