-- Close the EXTERNAL read path on the SECURITY DEFINER ops.v_* views.
--
-- These views run as their owner (postgres, bypasses RLS) and were
-- SELECT-granted to anon — so anyone who extracted the public anon key from
-- the shipped HTML could read financials (AR aging, balance sheet, revenue by
-- month, sales lines), staff PII (drivers, techs, role matrix, cert expiries),
-- and operational data with no account. This was the external half of the
-- advisor's 33 `security_definer_view` ERRORs.
--
-- Consumer audit before the revoke (org-wide GitHub code search + in-repo):
--   * Margin Control (app/) reads v_inventory_on_hand / v_purchase_orders /
--     v_sales_lines via sbq(), which sends the logged-in user's JWT
--     (_sbToken() returns session.access_token; app is auth-gated) → the kept
--     `authenticated` grant covers it.
--   * The 13 orders.v_* views were already authenticated-only — untouched.
--   * Every other ops.v_* view has zero client references anywhere in the
--     skypace org; backends use service_role / postgres (grants irrelevant).
--   * ops.v_qbo_token_status is intentionally NOT revoked: the legacy /sales
--     page reads it with the bare anon key, and it exposes only token
--     metadata (expiry timestamps, refresh count, last error) — no secrets.
--
-- Residual (accepted): the views remain SECURITY DEFINER, so signed-in users
-- can still read past RLS through them — an internal-trust posture per
-- operator decision 2026-07-07 (ARCHITECTURE.md, Things to clean up #33).
--
-- Applied out-of-band via the Supabase MCP; this file keeps the repo
-- authoritative. Verified: anon → permission denied; authenticated → data.

REVOKE SELECT ON ops.v_item_actual_cost       FROM anon;
REVOKE SELECT ON ops.v_customer_directory     FROM anon;
REVOKE SELECT ON ops.v_service_dwell_mismatch FROM anon;
REVOKE SELECT ON ops.v_sales_lines            FROM anon;
REVOKE SELECT ON ops.v_fleet_fuel_cost_monthly FROM anon;
REVOKE SELECT ON ops.v_staff_role_matrix      FROM anon;
REVOKE SELECT ON ops.v_drivers                FROM anon;
REVOKE SELECT ON ops.v_techs                  FROM anon;
REVOKE SELECT ON ops.v_certs_expiring_soon    FROM anon;
REVOKE SELECT ON ops.v_revenue_by_month       FROM anon;
REVOKE SELECT ON ops.v_ar_aging               FROM anon;
REVOKE SELECT ON ops.v_recent_sync_activity   FROM anon;
REVOKE SELECT ON ops.v_inventory_drift        FROM anon;
REVOKE SELECT ON ops.v_active_staff           FROM anon;
REVOKE SELECT ON ops.v_balance_sheet_latest   FROM anon;
REVOKE SELECT ON ops.v_unexplained_stops      FROM anon;
REVOKE SELECT ON ops.v_account_classification FROM anon;
REVOKE SELECT ON ops.v_inventory_on_hand      FROM anon;
REVOKE SELECT ON ops.v_purchase_orders        FROM anon;
