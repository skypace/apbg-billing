-- §12 #6 (option a′) — PII directory view + RPC for ops.qbo_customers.
--
-- Background: ops.qbo_customers carries structured PII (email, phone,
-- bill_addr_*, ship_addr_*, notes) and is currently anon-readable via
-- the qbo_customers_read SELECT policy with USING (true). The architecture
-- review surfaced this as the highest-value PII leak: anyone with the
-- anon key (which is in every published JS bundle) can SELECT * and pull
-- the entire customer master.
--
-- Per Sky's audit on 2026-05-05, structured PII (email/phone/formal
-- addresses) lives ONLY on this table — side tables (qbo_invoices,
-- delivery_stops, service_jobs, reman_jobs) carry only customer_name,
-- driver/tech names, and route addresses. So locking down qbo_customers
-- itself blocks the high-value leak.
--
-- This migration is the ADDITIVE half of the fix: it creates a safe
-- directory view + SECURITY DEFINER RPC exposing only non-PII columns,
-- and grants those to anon. It does NOT yet revoke direct anon SELECT
-- on ops.qbo_customers — that REVOKE will land in a follow-up migration
-- once apbg-ops has confirmed its consumers have moved off direct
-- table reads (see §12 #6 PR B2 in the architecture review).
--
-- Margin Minder consumers: public/sales/index.html lines 1696, 4230
-- (BulkClassifyModal + inventory-velocity-excludes picker) are migrated
-- to call fn_customer_directory() in the same PR as this migration.

-- ---------------------------------------------------------------------
-- Directory view: safe columns only.
-- Drop in case it already exists from a prior draft.
DROP VIEW IF EXISTS ops.v_customer_directory;

CREATE VIEW ops.v_customer_directory AS
  SELECT qbo_customer_id,
         display_name,
         fully_qualified_name,
         parent_ref_id,
         is_sub_customer,
         active
  FROM ops.qbo_customers
  WHERE active = true;

GRANT SELECT ON ops.v_customer_directory TO anon, authenticated;

COMMENT ON VIEW ops.v_customer_directory IS
  'Anon-readable directory of active customers. Excludes PII columns (email, phone, addresses, notes). Use this view, or the SECURITY DEFINER RPC ops.fn_customer_directory(), instead of querying ops.qbo_customers directly.';

-- ---------------------------------------------------------------------
-- RPC wrapper: same shape as the view, callable as an RPC so consumers
-- have an explicit access pattern rather than a generic table read.
-- SECURITY DEFINER so it works regardless of future tightening on the
-- underlying ops.qbo_customers RLS policy.
DROP FUNCTION IF EXISTS ops.fn_customer_directory();

CREATE OR REPLACE FUNCTION ops.fn_customer_directory()
RETURNS TABLE (
  qbo_customer_id      text,
  display_name         text,
  fully_qualified_name text,
  parent_ref_id        text,
  is_sub_customer      boolean,
  active               boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  SELECT qbo_customer_id,
         display_name,
         fully_qualified_name,
         parent_ref_id,
         is_sub_customer,
         active
  FROM ops.qbo_customers
  WHERE active = true
  ORDER BY display_name
$$;

GRANT EXECUTE ON FUNCTION ops.fn_customer_directory() TO anon, authenticated;

COMMENT ON FUNCTION ops.fn_customer_directory() IS
  'PII-safe customer directory: ID + display_name + parent_ref_id + active. Use this for typeahead pickers, BulkClassify modals, etc. For full customer detail (including PII columns) use the existing fn_customer_detail() RPC, which gates by row.';
