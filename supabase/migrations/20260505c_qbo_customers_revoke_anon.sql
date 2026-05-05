-- §12 #6 PR B2 — destructive half: revoke direct anon SELECT on ops.qbo_customers.
--
-- The PII gate's additive half landed in 20260505b_customer_directory.sql:
-- ops.v_customer_directory (safe-column view) and ops.fn_customer_directory()
-- (SECURITY DEFINER RPC) are now live and the Margin Minder consumers in
-- public/sales/index.html have been migrated to use the RPC.
--
-- Apbg-ops audit (2026-05-05) reports zero direct reads of ops.qbo_customers
-- from its codebase — apbg-ops gets customer signal from denormalized
-- customer_name columns on qbo_invoices / delivery_stops / service_jobs,
-- and from SECURITY DEFINER RPCs (fn_customer_detail, fn_customer_health,
-- etc.) for full-row reads.
--
-- This migration shuts the PII door on ops.qbo_customers itself. After
-- this lands, the table is unreadable via the anon key. SECURITY DEFINER
-- RPCs continue to work (they bypass RLS by design); authenticated users
-- with a valid bearer token retain SELECT.
--
-- Roles list on the new policy: 'admin', 'superadmin', 'margin-minder-user',
-- 'ops-user'. Adjust to match the gateway's actual role-claim minting once
-- it deploys (joint architecture doc §5 roadmap).

-- Tighten the SELECT policy: was USING (true) for {public}; now requires
-- an authenticated session whose JWT carries an authorized role claim.
DROP POLICY IF EXISTS qbo_customers_read ON ops.qbo_customers;

CREATE POLICY qbo_customers_read ON ops.qbo_customers
  FOR SELECT
  TO authenticated
  USING (
    coalesce(auth.jwt()->>'role', '') IN (
      'admin', 'superadmin', 'margin-minder-user', 'ops-user'
    )
  );

-- Anon role no longer reads the PII master table.
REVOKE SELECT ON ops.qbo_customers FROM anon;

-- Authenticated role keeps SELECT (gated by the policy above).
GRANT SELECT ON ops.qbo_customers TO authenticated;

COMMENT ON POLICY qbo_customers_read ON ops.qbo_customers IS
  'PII gate: SELECT requires a JWT with role claim in the allowed set. Anon callers must use ops.v_customer_directory or ops.fn_customer_directory() for safe-column reads, or the existing SECURITY DEFINER RPCs (fn_customer_detail, fn_customer_health) for elevated reads.';
