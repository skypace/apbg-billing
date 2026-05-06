-- §12 #6 follow-up — relax the qbo_customers_read policy from a custom
-- JWT-role gate to a simple "must be authenticated" gate.
--
-- Background: PR #26 (20260505c) shipped a policy that required
-- `auth.jwt()->>'role' IN ('admin', 'superadmin', 'margin-minder-user',
-- 'ops-user')`. That assumed the apbg-gateway was minting JWTs with one
-- of those custom role claims. In practice the gateway mints the
-- Supabase Auth default `role='authenticated'`, so the policy denies
-- every signed-in user too — only SECURITY DEFINER RPCs (which bypass
-- RLS) work. Apps that read qbo_customers via RPC keep working; any
-- direct table read fails for everyone.
--
-- That's strict but accidental. The intent of the gate was "anon
-- blocked, signed-in users allowed" — keep PII off public bundles
-- without breaking authenticated dashboard reads. This migration
-- aligns the policy with the intent: TO authenticated USING (true).
-- Anon stays blocked (the GRANT was already revoked from anon in
-- 20260505c and that REVOKE remains).
--
-- When the gateway eventually mints custom role claims, the policy can
-- be tightened back. Until then, "signed in" is the gate.

DROP POLICY IF EXISTS qbo_customers_read ON ops.qbo_customers;

CREATE POLICY qbo_customers_read ON ops.qbo_customers
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON POLICY qbo_customers_read ON ops.qbo_customers IS
  'PII gate: any authenticated session can SELECT (must have a valid bearer token). Anon role has no SELECT grant on the table — direct anon queries fail at the privilege check before this policy runs. PII-safe access for anon goes through ops.v_customer_directory or ops.fn_customer_directory().';
