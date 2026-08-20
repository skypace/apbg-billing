-- ============================================================================
-- HARDENING PASS (sub-distributors follow-up, but protects the whole shared
-- project): RPC guards, function-grant hygiene, anon invoice mirror closed,
-- distributor write-deny coverage, notification health check.
--
-- Findings this migration closes (enumerated live 2026-08-20):
--
--  F1. ~130 SECURITY DEFINER ops functions were executable by ANY login (and
--      most by anon) via Postgres's DEFAULT PUBLIC EXECUTE — including
--      ops.sf_token_claim_refresh, which RETURNS the live Service Fusion
--      access + refresh tokens: credential theft one RPC call away for every
--      brix-order customer, vendor login, and distributor on the project.
--      Analytics functions (fn_items_master → purchase costs, fn_customer_*,
--      fn_sales_* → the whole margin picture) were equally open.
--
--  F2. ops.qbo_invoices / qbo_invoice_lines carried ANON SELECT USING(true)
--      policies — the full invoice mirror readable with the public anon key
--      alone. The only page that ever leaned on them (public/dashboard.html)
--      was querying the wrong schema and never actually worked; it is fixed
--      in the same change to use the signed-in superadmin's bearer.
--
--  F3. The 20260818f distributor deny-list used SELECT-only restrictive
--      policies, but several taxonomy tables carry permissive
--      FOR ALL USING(true) write policies — a distributor login could WRITE
--      channels/segments/plans/settings. Deny coverage now spans all
--      commands.
--
-- What this migration does:
--
--  1. ops.fn_assert_internal()          — raises for distributor logins.
--     ops.fn_assert_staff_or_service()  — raises for ANY non-staff
--                                         authenticated login (service_role,
--                                         pg_cron/postgres, and staff pass).
--
--  2. GUARD-WRAPPER GENERATOR: every SECURITY DEFINER ops function that is
--     executable by authenticated/anon (except the distributor allowlist and
--     trigger functions) is renamed to <name>__i (grants stripped) and
--     replaced by a same-signature wrapper that asserts the guard, then
--     delegates. Token functions get the strict staff-or-service guard;
--     everything else gets the distributor guard, so internal roles
--     (superadmin/admin/finance/sales) see ZERO change.
--       · OID references (views, RLS policies) keep pointing at the renamed
--         inner — internals unaffected.
--       · Name-based callers (PostgREST RPC, pg_cron, other plpgsql bodies)
--         resolve to the wrapper; cron/postgres/service contexts pass the
--         guards (no JWT → not a distributor, not 'authenticated').
--       · ⚠ MAINTENANCE TRAP: a later CREATE OR REPLACE FUNCTION on a
--         wrapped name replaces the WRAPPER (guard lost for that fn, old
--         __i orphaned). That is no worse than pre-hardening, but the fix
--         is to re-run this migration's generator block — it is idempotent
--         (marker-skips live wrappers, drops stale __i before re-wrapping).
--
--  3. GRANT HYGIENE: for every ops function, EXECUTE is revoked from PUBLIC
--     and anon (authenticated/service_role grants made explicit first, so
--     internal access is unchanged). anon keeps only fn_is_staff and
--     fn_is_distributor (harmless booleans used by policies).
--
--  4. Deny-list restrictive policies upgraded from FOR SELECT to FOR ALL.
--
--  5. Anon SELECT policies dropped + anon SELECT revoked on qbo_invoices,
--     qbo_invoice_lines.
--
--  6. ops.fn_sync_health_extra gains a distributor_notify check (the 15-min
--     notification scan now logs to ops.sync_log; a scan that stops running
--     goes yellow at 2h, red at 12h, and red on a logged error).
--
-- Idempotent: re-running is safe (and is the recovery path for the trap in
-- note 2).
-- ============================================================================


-- ── 1. Guards ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_assert_internal()
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ops, pg_temp AS $$
BEGIN
  IF ops.fn_is_distributor() AND NOT ops.fn_is_staff() THEN
    RAISE EXCEPTION 'This function is not available to distributor accounts'
      USING ERRCODE = '42501';
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION ops.fn_assert_staff_or_service()
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ops, pg_temp AS $$
BEGIN
  -- service_role / postgres / pg_cron contexts have auth.role() <> 'authenticated'.
  IF auth.role() = 'authenticated' AND NOT ops.fn_is_staff() THEN
    RAISE EXCEPTION 'This function requires a staff account'
      USING ERRCODE = '42501';
  END IF;
END; $$;

REVOKE ALL ON FUNCTION ops.fn_assert_internal() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.fn_assert_staff_or_service() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.fn_assert_internal() TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION ops.fn_assert_staff_or_service() TO authenticated, anon, service_role;


-- ── 2 + 6 prep. fn_sync_health_extra: add the distributor_notify check ──────
-- (Recreated BEFORE the wrapper generator so the new body is what gets
-- wrapped. Body is the live 2026-08-20 definition + the new check.)
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
  -- silently un-emailed — exactly the silent-outage class the health system
  -- exists for.
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

  -- Vendor payment ledger (Vendor Portal Phase 3).
  return query select * from ops.fn_vendor_payments_health();

  return query select * from ops.fn_mirror_freshness();
end;
$function$;


-- ── 3. Guard-wrapper generator ───────────────────────────────────────────────
DO $$
DECLARE
  allowlist TEXT[] := ARRAY[
    'fn_is_staff','fn_is_distributor','fn_is_distributor_member',
    'fn_my_distributor_ids','fn_my_distributor_location_ids',
    'fn_my_distributor_qbo_customer_ids','fn_next_sdo_number',
    'fn_distributor_create_order','fn_distributor_cancel_order',
    'fn_distributor_receive_transfer','fn_distributor_sign_agreement',
    'fn_distributor_record_depletion','fn_distributor_settlement_create',
    'fn_distributor_settlement_void','fn_fulfill_distributor_order',
    'fn_assert_internal','fn_assert_staff_or_service'
  ];
  strict_set TEXT[] := ARRAY[
    'sf_token_claim_refresh','sf_token_persist','sf_token_release_failed',
    'fn_sf_token_claim_refresh','fn_sf_token_release_refresh',
    'qbo_token_diagnostics'
  ];
  r RECORD;
  inner_name TEXT;
  guard TEXT;
  args_pass TEXT;
  body TEXT;
  wrapped_ct INT := 0;
BEGIN
  FOR r IN
    SELECT p.oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) AS idargs,
           pg_get_function_arguments(p.oid)          AS defargs,
           pg_get_function_result(p.oid)             AS res,
           p.proretset,
           p.pronargs,
           p.prosrc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops'
      AND p.prosecdef
      AND pg_get_function_result(p.oid) <> 'trigger'
      AND p.proname NOT LIKE '%\_\_i'
      AND NOT (p.proname = ANY (allowlist))
      AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
           OR has_function_privilege('anon', p.oid, 'EXECUTE'))
      AND p.prosrc NOT LIKE '%GENERATED GUARD WRAPPER%'   -- idempotence marker
  LOOP
    inner_name := r.proname || '__i';
    guard := CASE WHEN r.proname = ANY (strict_set)
                  THEN 'ops.fn_assert_staff_or_service()'
                  ELSE 'ops.fn_assert_internal()' END;

    -- Recovery path: a stale inner from a previous wrap whose wrapper was
    -- later CREATE-OR-REPLACEd away. Drop it so the rename can land.
    EXECUTE format('DROP FUNCTION IF EXISTS ops.%I(%s)', inner_name, r.idargs);

    EXECUTE format('ALTER FUNCTION ops.%I(%s) RENAME TO %I',
                   r.proname, r.idargs, inner_name);

    SELECT COALESCE(string_agg('$' || i, ', '), '')
      INTO args_pass FROM generate_series(1, r.pronargs) i;

    IF r.proretset THEN
      body := format('BEGIN PERFORM %s; RETURN QUERY SELECT * FROM ops.%I(%s); END',
                     guard, inner_name, args_pass);
    ELSIF r.res = 'void' THEN
      body := format('BEGIN PERFORM %s; PERFORM ops.%I(%s); END',
                     guard, inner_name, args_pass);
    ELSE
      body := format('BEGIN PERFORM %s; RETURN ops.%I(%s); END',
                     guard, inner_name, args_pass);
    END IF;

    EXECUTE format(
      'CREATE FUNCTION ops.%I(%s) RETURNS %s LANGUAGE plpgsql SECURITY DEFINER '
      || 'SET search_path = ops, pg_temp AS %L',
      r.proname, r.defargs, r.res,
      '-- GENERATED GUARD WRAPPER (20260820b) — the real body lives in ops.'
      || inner_name || '. Edit THAT, or CREATE OR REPLACE this name and re-run '
      || 'the 20260820b generator to re-guard. ' || chr(10) || body);

    -- Wrapper callable by app roles; inner callable by nobody but owner chains.
    EXECUTE format('REVOKE ALL ON FUNCTION ops.%I(%s) FROM PUBLIC', r.proname, r.idargs);
    EXECUTE format('GRANT EXECUTE ON FUNCTION ops.%I(%s) TO authenticated, service_role', r.proname, r.idargs);
    EXECUTE format('REVOKE ALL ON FUNCTION ops.%I(%s) FROM PUBLIC', inner_name, r.idargs);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION ops.%I(%s) FROM authenticated, anon', inner_name, r.idargs);

    wrapped_ct := wrapped_ct + 1;
  END LOOP;
  RAISE NOTICE 'guard-wrapped % functions', wrapped_ct;
END $$;


-- ── 4. Function grant hygiene: no PUBLIC, no anon (two exceptions) ──────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname,
           pg_get_function_identity_arguments(p.oid) AS idargs,
           pg_get_function_result(p.oid) AS res
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops'
      -- anon inherits PUBLIC, so this single test also catches the
      -- default-PUBLIC-EXECUTE case (proacl IS NULL).
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    -- Preserve app access explicitly before dropping the PUBLIC default
    -- (trigger functions get no role grants — nothing calls them directly).
    IF r.res <> 'trigger' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION ops.%I(%s) TO authenticated, service_role', r.proname, r.idargs);
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION ops.%I(%s) FROM PUBLIC', r.proname, r.idargs);
    IF r.proname NOT IN ('fn_is_staff','fn_is_distributor') THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION ops.%I(%s) FROM anon', r.proname, r.idargs);
    END IF;
  END LOOP;
END $$;


-- ── 5. Deny-list restrictive policies: SELECT-only → ALL commands ───────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'account_settings','alert_settings','balance_sheet_snapshots',
    'category_segments','channels','cogs_accounts','compliance_postings',
    'copack_order_costs','copack_orders','crm_deals','customer_channels',
    'customer_groups','customer_health_snapshots','customer_lifecycle_actions',
    'customer_tags','dashboard_settings','db_health_snapshots','delivery_stops',
    'digest_log','digest_subscriptions','equipment_assets','equipment_contracts',
    'expense_bucket_types','expense_buckets','expense_settings',
    'expense_requests','expense_request_attachments','expense_request_approvals',
    'expense_approvals','fleet_break_locations','fleet_daily',
    'fleet_driver_events','fleet_drivers','fleet_fuel_transactions',
    'fleet_geofences','fleet_latest_snapshots','fleet_maintenance',
    'fleet_stop_visits','fleet_trips','fleet_vehicles','health_alerts_sent',
    'inventory_settings','inventory_velocity_excludes','item_cost_policies',
    'item_product_families','item_product_types','item_segments',
    'item_segments_legacy','item_set_items','item_sets','job_notes',
    'kpi_daily','kpi_exclusions','pl_snapshots','product_bom',
    'product_bom_lines','product_families','product_formula_ingredients',
    'product_formula_revisions','product_formulas','product_types',
    'purchase_order_lines','purchase_orders','qbo_employees_cache',
    'qbo_expense_lines','qbo_inventory_adjustment_lines',
    'qbo_inventory_adjustments','qbo_items','qbo_pto_cache',
    'qbo_purchase_order_lines','qbo_purchase_orders','qbo_vendors',
    'qbo_writeback_log','reman_jobs','remittance_matches','remittances',
    'rental_contracts','resq_sf_links','revenue_account_map',
    'revenue_categories','role_types','sales_plan_lines','sales_plans',
    'segments','service_jobs','site_settings','staff','staff_roles',
    'sync_customers','sync_events','sync_log','team_members',
    'third_party_crews','vehicle_assignments','work_order_costs',
    'work_order_events','work_order_materials','work_orders'
  ]
  LOOP
    IF to_regclass('ops.' || t) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON ops.%I', t || '_no_distributor', t);
      EXECUTE format(
        'CREATE POLICY %I ON ops.%I AS RESTRICTIVE FOR ALL TO authenticated '
        || 'USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor()) '
        || 'WITH CHECK (ops.fn_is_staff() OR NOT ops.fn_is_distributor())',
        t || '_no_distributor', t);
    END IF;
  END LOOP;
END $$;


-- ── 6. Close the anon invoice mirror ─────────────────────────────────────────
DROP POLICY IF EXISTS "anon read qbo_invoices"      ON ops.qbo_invoices;
DROP POLICY IF EXISTS "anon read qbo_invoice_lines" ON ops.qbo_invoice_lines;
REVOKE SELECT ON ops.qbo_invoices      FROM anon;
REVOKE SELECT ON ops.qbo_invoice_lines FROM anon;
