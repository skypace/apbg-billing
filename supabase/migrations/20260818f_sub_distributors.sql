-- ============================================================================
-- Sub-Distributors — distribution partners (Origins Soda Co., Desert Beverage)
-- who hold Brix/Alameda product in THEIR warehouse and deliver it to chain
-- accounts (The Melt, Starbird) in territories our trucks don't cover.
--
-- Model per agreement:
--   'consignment' — Brix owns the inventory at the distributor until depletion.
--                   The distributor charges Brix per_case_delivery_fee for
--                   every case delivered (snapshotted on each depletion row).
--   'sell_in'     — the distributor buys the product (QBO invoice at their
--                   contract pricing); inventory tracking is visibility only.
--
-- Inventory + BOLs reuse the existing Stock machinery unchanged: each
-- distributor gets an ops.inventory_locations row (new kind 'distributor');
-- shipments to them are ordinary ops.inventory_transfers with real BOL
-- numbers; on-hand derives from ops.inventory_movements. What this migration
-- adds is the entity/agreement layer, the portal-facing RPCs, and the RLS
-- scoping that makes an EXTERNAL distributor login safe on this shared
-- Supabase project.
--
-- Tables:
--   ops.sub_distributors            — the partner registry
--   ops.sub_distributor_users       — login ↔ distributor membership (RLS key)
--   ops.sub_distributor_agreements  — versioned agreements + in-portal e-sign
--   ops.sub_distributor_accounts    — which chain stores each partner services
--   ops.sub_distributor_orders      — restock orders placed in the portal
--   ops.sub_distributor_order_lines
--   ops.sub_distributor_depletions  — cases delivered to serviced accounts
--                                     (posts 'shipment' movements out of the
--                                     distributor's location + fee snapshot)
--
-- RPCs (SECURITY DEFINER):
--   ops.fn_is_distributor / fn_my_distributor_ids /
--     fn_my_distributor_location_ids / fn_my_distributor_qbo_customer_ids /
--     fn_is_distributor_member — membership helpers for RLS + portal
--   ops.fn_distributor_create_order    — portal restock order (submitted)
--   ops.fn_distributor_cancel_order    — portal cancel while submitted
--   ops.fn_fulfill_distributor_order   — STAFF: order → draft BOL transfer
--   ops.fn_distributor_receive_transfer— portal receive w/ per-line counts +
--                                        discrepancy handling (shortfall stays
--                                        in TRANSIT for staff to resolve)
--   ops.fn_distributor_sign_agreement  — portal e-sign of a 'sent' agreement
--   ops.fn_distributor_record_depletion— portal depletion recording
--
-- RLS strategy (THE POINT OF THIS FILE — read before touching):
--   This Supabase project's auth is shared (gateway staff, Brixpense,
--   brix-order customers, vendors). ~100 ops.* tables carry permissive
--   SELECT USING (true) policies for authenticated. Inviting an OUTSIDE
--   distributor login without scoping would expose every BOL, cost, formula
--   and invoice. We therefore add AS RESTRICTIVE policies (ANDed with the
--   permissive ones — they can only narrow, never widen) of the shape:
--       USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor() OR <scope>)
--   i.e. staff and every existing internal/other login keep EXACTLY the
--   access they have today (zero regression); only logins listed in
--   ops.sub_distributor_users are narrowed — to their own slice (transfers/
--   movements touching their location, their own QBO invoices) or to nothing
--   (formulas, work orders, POs, fleet, HR, expenses, ...).
--   Views v_inventory_on_hand / v_sales_lines / v_work_orders /
--   v_purchase_orders are flipped to security_invoker so they inherit the
--   same scoping (their base tables are all authenticated-readable, so
--   internal users see no change).
--   ⚠ KNOWN LIMIT (documented, deliberate): SECURITY DEFINER RPCs granted to
--   authenticated (e.g. fn_items_master, which returns purchase costs) are
--   still callable by any authenticated login — a PRE-EXISTING exposure that
--   also applies to brix-order customers today. A dedicated RPC-guard pass
--   is the follow-up before onboarding distributor logins we don't trust.
--
-- Idempotent: re-running is safe.
-- ============================================================================


-- ── 0. New inventory location kind: 'distributor' ───────────────────────────
ALTER TABLE ops.inventory_locations DROP CONSTRAINT IF EXISTS inventory_locations_kind_check;
ALTER TABLE ops.inventory_locations ADD CONSTRAINT inventory_locations_kind_check
  CHECK (kind IN ('warehouse','van','co_packer','customer_consigned','distributor','in_transit','adjustment'));

-- Receive-with-discrepancy support on transfers (used by the distributor
-- receive RPC; internal fn_receive_transfer is untouched).
ALTER TABLE ops.inventory_transfers
  ADD COLUMN IF NOT EXISTS receiver_notes  TEXT,
  ADD COLUMN IF NOT EXISTS has_discrepancy BOOLEAN NOT NULL DEFAULT FALSE;


-- ── 1. sub_distributors ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.sub_distributors (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','active','inactive')),
  model                 TEXT NOT NULL DEFAULT 'consignment'
                          CHECK (model IN ('consignment','sell_in')),
  per_case_delivery_fee NUMERIC,          -- consignment: what THEY charge US per case delivered
  qbo_customer_id       TEXT,             -- their QBO customer (sell-in invoicing + portal billing view)
  sf_customer_id        BIGINT,
  inventory_location_id UUID REFERENCES ops.inventory_locations(id),
  territory             TEXT,
  contact_name          TEXT,
  contact_email         TEXT,
  contact_phone         TEXT,
  notes                 TEXT,
  created_by            UUID REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ops.tg_sub_distributors_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS sub_distributors_touch ON ops.sub_distributors;
CREATE TRIGGER sub_distributors_touch BEFORE UPDATE ON ops.sub_distributors
  FOR EACH ROW EXECUTE FUNCTION ops.tg_sub_distributors_touch();


-- ── 2. sub_distributor_users — the RLS membership key ───────────────────────
-- Matched by user_id (hard link) OR case-insensitive email from the JWT, the
-- same external-counterparty pattern Brixpense uses for manager_email. Staff
-- add a row here AFTER provisioning the login via the gateway admin console.
CREATE TABLE IF NOT EXISTS ops.sub_distributor_users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_distributor_id UUID NOT NULL REFERENCES ops.sub_distributors(id) ON DELETE CASCADE,
  email              TEXT NOT NULL,
  user_id            UUID REFERENCES auth.users(id),
  role               TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by         UUID REFERENCES auth.users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sub_distributor_users_email_uniq
  ON ops.sub_distributor_users (sub_distributor_id, lower(email));
CREATE INDEX IF NOT EXISTS sub_distributor_users_user_idx
  ON ops.sub_distributor_users (user_id) WHERE user_id IS NOT NULL;


-- ── 3. sub_distributor_agreements — versioned + e-sign ──────────────────────
CREATE TABLE IF NOT EXISTS ops.sub_distributor_agreements (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_distributor_id    UUID NOT NULL REFERENCES ops.sub_distributors(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL DEFAULT 1,
  title                 TEXT,
  model                 TEXT NOT NULL CHECK (model IN ('consignment','sell_in')),
  per_case_delivery_fee NUMERIC,          -- consignment fee in force under THIS agreement
  effective_date        DATE,
  expiry_date           DATE,
  terms                 TEXT,             -- agreement body / summary shown in the portal
  file_path             TEXT,             -- distributor-docs bucket object (the PDF)
  file_name             TEXT,
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','sent','signed','expired','void')),
  sent_at               TIMESTAMPTZ,
  sent_to               TEXT,
  signed_at             TIMESTAMPTZ,
  signer_name           TEXT,
  signer_email          TEXT,
  signer_user_id        UUID REFERENCES auth.users(id),
  signature_data        TEXT,             -- PNG data-URL (same pattern as safety_handbook_acks)
  created_by            UUID REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sub_distributor_id, version)
);

DROP TRIGGER IF EXISTS sub_distributor_agreements_touch ON ops.sub_distributor_agreements;
CREATE TRIGGER sub_distributor_agreements_touch BEFORE UPDATE ON ops.sub_distributor_agreements
  FOR EACH ROW EXECUTE FUNCTION ops.tg_sub_distributors_touch();


-- ── 4. sub_distributor_accounts — serviced chain stores ─────────────────────
CREATE TABLE IF NOT EXISTS ops.sub_distributor_accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_distributor_id UUID NOT NULL REFERENCES ops.sub_distributors(id) ON DELETE CASCADE,
  qbo_customer_id    TEXT NOT NULL,      -- the Melt/Starbird store's QBO customer id
  account_name       TEXT,
  chain              TEXT,               -- e.g. 'The Melt', 'Starbird'
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sub_distributor_id, qbo_customer_id)
);


-- ── 5. sub_distributor_orders — portal restock orders ───────────────────────
CREATE SEQUENCE IF NOT EXISTS ops.sub_distributor_order_seq;

CREATE OR REPLACE FUNCTION ops.fn_next_sdo_number()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
BEGIN
  RETURN 'SDO-' || to_char(now(),'YYYY') || '-' ||
         lpad(nextval('ops.sub_distributor_order_seq')::text, 4, '0');
END; $$;

CREATE TABLE IF NOT EXISTS ops.sub_distributor_orders (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_distributor_id UUID NOT NULL REFERENCES ops.sub_distributors(id) ON DELETE CASCADE,
  order_number       TEXT NOT NULL UNIQUE,
  status             TEXT NOT NULL DEFAULT 'submitted'
                       CHECK (status IN ('submitted','fulfilled','cancelled')),
  requested_date     DATE,
  notes              TEXT,
  submitted_by       UUID REFERENCES auth.users(id),
  submitted_by_email TEXT,
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by         UUID REFERENCES auth.users(id),
  decided_at         TIMESTAMPTZ,
  decision_notes     TEXT,
  transfer_id        UUID REFERENCES ops.inventory_transfers(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS sub_distributor_orders_touch ON ops.sub_distributor_orders;
CREATE TRIGGER sub_distributor_orders_touch BEFORE UPDATE ON ops.sub_distributor_orders
  FOR EACH ROW EXECUTE FUNCTION ops.tg_sub_distributors_touch();

CREATE TABLE IF NOT EXISTS ops.sub_distributor_order_lines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES ops.sub_distributor_orders(id) ON DELETE CASCADE,
  qbo_item_id TEXT NOT NULL,
  qty         NUMERIC NOT NULL CHECK (qty > 0),
  unit_price  NUMERIC,                   -- sell-in: resolved contract price snapshot; consignment: null
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sub_distributor_order_lines_order_idx
  ON ops.sub_distributor_order_lines (order_id);


-- ── 6. sub_distributor_depletions ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.sub_distributor_depletions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           UUID NOT NULL,      -- groups one recording session
  sub_distributor_id UUID NOT NULL REFERENCES ops.sub_distributors(id) ON DELETE CASCADE,
  account_id         UUID REFERENCES ops.sub_distributor_accounts(id),
  qbo_item_id        TEXT NOT NULL,
  cases              NUMERIC NOT NULL CHECK (cases > 0),
  delivered_date     DATE NOT NULL,
  reference          TEXT,               -- the distributor's delivery/invoice ref
  movement_id        UUID REFERENCES ops.inventory_movements(id),
  fee_per_case       NUMERIC,            -- consignment fee snapshot at recording time
  fee_amount         NUMERIC,
  recorded_by        UUID REFERENCES auth.users(id),
  recorded_by_email  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sub_distributor_depletions_dist_idx
  ON ops.sub_distributor_depletions (sub_distributor_id, delivered_date DESC);


-- ── 7. Membership helpers ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_is_distributor()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM ops.sub_distributor_users u
    WHERE u.is_active
      AND (u.user_id = auth.uid()
           OR lower(u.email) = lower(coalesce(auth.jwt()->>'email','')))
  );
$$;

CREATE OR REPLACE FUNCTION ops.fn_my_distributor_ids()
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, pg_temp AS $$
  SELECT u.sub_distributor_id FROM ops.sub_distributor_users u
  WHERE u.is_active
    AND (u.user_id = auth.uid()
         OR lower(u.email) = lower(coalesce(auth.jwt()->>'email','')));
$$;

CREATE OR REPLACE FUNCTION ops.fn_my_distributor_location_ids()
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, pg_temp AS $$
  SELECT sd.inventory_location_id FROM ops.sub_distributors sd
  WHERE sd.inventory_location_id IS NOT NULL
    AND sd.id IN (SELECT ops.fn_my_distributor_ids());
$$;

CREATE OR REPLACE FUNCTION ops.fn_my_distributor_qbo_customer_ids()
RETURNS SETOF TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, pg_temp AS $$
  SELECT sd.qbo_customer_id FROM ops.sub_distributors sd
  WHERE sd.qbo_customer_id IS NOT NULL
    AND sd.id IN (SELECT ops.fn_my_distributor_ids());
$$;

CREATE OR REPLACE FUNCTION ops.fn_is_distributor_member(p_sub_distributor_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, pg_temp AS $$
  SELECT p_sub_distributor_id IN (SELECT ops.fn_my_distributor_ids());
$$;

GRANT EXECUTE ON FUNCTION ops.fn_is_distributor() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION ops.fn_my_distributor_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_my_distributor_location_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_my_distributor_qbo_customer_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_is_distributor_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_next_sdo_number() TO authenticated;


-- ── 8. RLS on the new tables ─────────────────────────────────────────────────
ALTER TABLE ops.sub_distributors            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.sub_distributor_users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.sub_distributor_agreements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.sub_distributor_accounts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.sub_distributor_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.sub_distributor_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.sub_distributor_depletions  ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.sub_distributors,
  ops.sub_distributor_users, ops.sub_distributor_agreements,
  ops.sub_distributor_accounts, ops.sub_distributor_orders,
  ops.sub_distributor_order_lines, ops.sub_distributor_depletions
  TO authenticated;
GRANT ALL ON ops.sub_distributors, ops.sub_distributor_users,
  ops.sub_distributor_agreements, ops.sub_distributor_accounts,
  ops.sub_distributor_orders, ops.sub_distributor_order_lines,
  ops.sub_distributor_depletions TO service_role;

-- Staff: full CRUD (Refractor manages everything). Members: scoped SELECT.
-- Member WRITES happen only through the SECURITY DEFINER RPCs below.
DROP POLICY IF EXISTS sub_distributors_staff ON ops.sub_distributors;
CREATE POLICY sub_distributors_staff ON ops.sub_distributors
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());
DROP POLICY IF EXISTS sub_distributors_member_select ON ops.sub_distributors;
CREATE POLICY sub_distributors_member_select ON ops.sub_distributors
  FOR SELECT TO authenticated USING (id IN (SELECT ops.fn_my_distributor_ids()));

DROP POLICY IF EXISTS sub_distributor_users_staff ON ops.sub_distributor_users;
CREATE POLICY sub_distributor_users_staff ON ops.sub_distributor_users
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());
DROP POLICY IF EXISTS sub_distributor_users_member_select ON ops.sub_distributor_users;
CREATE POLICY sub_distributor_users_member_select ON ops.sub_distributor_users
  FOR SELECT TO authenticated USING (sub_distributor_id IN (SELECT ops.fn_my_distributor_ids()));

DROP POLICY IF EXISTS sub_distributor_agreements_staff ON ops.sub_distributor_agreements;
CREATE POLICY sub_distributor_agreements_staff ON ops.sub_distributor_agreements
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());
-- Members see everything except internal drafts.
DROP POLICY IF EXISTS sub_distributor_agreements_member_select ON ops.sub_distributor_agreements;
CREATE POLICY sub_distributor_agreements_member_select ON ops.sub_distributor_agreements
  FOR SELECT TO authenticated
  USING (status <> 'draft' AND sub_distributor_id IN (SELECT ops.fn_my_distributor_ids()));

DROP POLICY IF EXISTS sub_distributor_accounts_staff ON ops.sub_distributor_accounts;
CREATE POLICY sub_distributor_accounts_staff ON ops.sub_distributor_accounts
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());
DROP POLICY IF EXISTS sub_distributor_accounts_member_select ON ops.sub_distributor_accounts;
CREATE POLICY sub_distributor_accounts_member_select ON ops.sub_distributor_accounts
  FOR SELECT TO authenticated USING (sub_distributor_id IN (SELECT ops.fn_my_distributor_ids()));

DROP POLICY IF EXISTS sub_distributor_orders_staff ON ops.sub_distributor_orders;
CREATE POLICY sub_distributor_orders_staff ON ops.sub_distributor_orders
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());
DROP POLICY IF EXISTS sub_distributor_orders_member_select ON ops.sub_distributor_orders;
CREATE POLICY sub_distributor_orders_member_select ON ops.sub_distributor_orders
  FOR SELECT TO authenticated USING (sub_distributor_id IN (SELECT ops.fn_my_distributor_ids()));

DROP POLICY IF EXISTS sub_distributor_order_lines_staff ON ops.sub_distributor_order_lines;
CREATE POLICY sub_distributor_order_lines_staff ON ops.sub_distributor_order_lines
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());
DROP POLICY IF EXISTS sub_distributor_order_lines_member_select ON ops.sub_distributor_order_lines;
CREATE POLICY sub_distributor_order_lines_member_select ON ops.sub_distributor_order_lines
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM ops.sub_distributor_orders o
                 WHERE o.id = order_id
                   AND o.sub_distributor_id IN (SELECT ops.fn_my_distributor_ids())));

DROP POLICY IF EXISTS sub_distributor_depletions_staff ON ops.sub_distributor_depletions;
CREATE POLICY sub_distributor_depletions_staff ON ops.sub_distributor_depletions
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());
DROP POLICY IF EXISTS sub_distributor_depletions_member_select ON ops.sub_distributor_depletions;
CREATE POLICY sub_distributor_depletions_member_select ON ops.sub_distributor_depletions
  FOR SELECT TO authenticated USING (sub_distributor_id IN (SELECT ops.fn_my_distributor_ids()));


-- ── 9. Scoping RESTRICTIVE policies on EXISTING tables ──────────────────────
-- Shape: staff and non-distributor logins pass untouched; distributor logins
-- are narrowed to their slice. Restrictive policies AND with the permissive
-- ones, so these can only narrow access — zero regression by construction.

-- 9a. Inventory: transfers/lines/movements scoped to the distributor's location.
DROP POLICY IF EXISTS inv_transfers_distributor_scope ON ops.inventory_transfers;
CREATE POLICY inv_transfers_distributor_scope ON ops.inventory_transfers
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor()
         OR from_location_id IN (SELECT ops.fn_my_distributor_location_ids())
         OR to_location_id   IN (SELECT ops.fn_my_distributor_location_ids()));

DROP POLICY IF EXISTS inv_transfer_lines_distributor_scope ON ops.inventory_transfer_lines;
CREATE POLICY inv_transfer_lines_distributor_scope ON ops.inventory_transfer_lines
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor()
         OR EXISTS (SELECT 1 FROM ops.inventory_transfers t
                    WHERE t.id = transfer_id
                      AND (t.from_location_id IN (SELECT ops.fn_my_distributor_location_ids())
                        OR t.to_location_id   IN (SELECT ops.fn_my_distributor_location_ids()))));

DROP POLICY IF EXISTS inv_movements_distributor_scope ON ops.inventory_movements;
CREATE POLICY inv_movements_distributor_scope ON ops.inventory_movements
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor()
         OR from_location_id IN (SELECT ops.fn_my_distributor_location_ids())
         OR to_location_id   IN (SELECT ops.fn_my_distributor_location_ids()));

-- Locations: distributors see their own + our warehouses (the ship-from
-- address on their BOLs) — and can never write locations (the permissive
-- policies from 20260513a are WITH CHECK (TRUE) for everyone).
DROP POLICY IF EXISTS inv_locations_distributor_scope ON ops.inventory_locations;
CREATE POLICY inv_locations_distributor_scope ON ops.inventory_locations
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor()
         OR id IN (SELECT ops.fn_my_distributor_location_ids())
         OR kind = 'warehouse');
DROP POLICY IF EXISTS inv_locations_distributor_no_insert ON ops.inventory_locations;
CREATE POLICY inv_locations_distributor_no_insert ON ops.inventory_locations
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (ops.fn_is_staff() OR NOT ops.fn_is_distributor());
DROP POLICY IF EXISTS inv_locations_distributor_no_update ON ops.inventory_locations;
CREATE POLICY inv_locations_distributor_no_update ON ops.inventory_locations
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor())
  WITH CHECK (ops.fn_is_staff() OR NOT ops.fn_is_distributor());

-- 9b. QBO mirror: distributors see only THEIR customer's invoices/lines and
-- only the customer rows for themselves + the stores they service.
DROP POLICY IF EXISTS qbo_invoices_distributor_scope ON ops.qbo_invoices;
CREATE POLICY qbo_invoices_distributor_scope ON ops.qbo_invoices
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor()
         OR customer_ref_id IN (SELECT ops.fn_my_distributor_qbo_customer_ids()));

DROP POLICY IF EXISTS qbo_invoice_lines_distributor_scope ON ops.qbo_invoice_lines;
CREATE POLICY qbo_invoice_lines_distributor_scope ON ops.qbo_invoice_lines
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor()
         OR EXISTS (SELECT 1 FROM ops.qbo_invoices i
                    WHERE i.id = invoice_id
                      AND i.customer_ref_id IN (SELECT ops.fn_my_distributor_qbo_customer_ids())));

DROP POLICY IF EXISTS qbo_customers_distributor_scope ON ops.qbo_customers;
CREATE POLICY qbo_customers_distributor_scope ON ops.qbo_customers
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor()
         OR qbo_customer_id IN (SELECT ops.fn_my_distributor_qbo_customer_ids())
         OR qbo_customer_id IN (SELECT a.qbo_customer_id FROM ops.sub_distributor_accounts a
                                WHERE a.sub_distributor_id IN (SELECT ops.fn_my_distributor_ids())));

-- 9c. Everything else that is open-read today: DENIED to distributor logins.
-- (List captured from live pg_policies 2026-08-18: every ops table with a
-- permissive SELECT USING (true) for authenticated/public, minus the scoped
-- tables above. qbo_items is denied here and replaced by v_distributor_catalog
-- below, which exposes names but not costs.)
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
        'CREATE POLICY %I ON ops.%I AS RESTRICTIVE FOR SELECT TO authenticated '
        || 'USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor())',
        t || '_no_distributor', t);
    END IF;
  END LOOP;
END $$;

-- 9d. Views inherit the scoping. All four have authenticated-readable base
-- tables, so internal users see no change; distributor logins get their slice.
ALTER VIEW ops.v_inventory_on_hand SET (security_invoker = on);
ALTER VIEW ops.v_sales_lines       SET (security_invoker = on);
ALTER VIEW ops.v_work_orders       SET (security_invoker = on);
ALTER VIEW ops.v_purchase_orders   SET (security_invoker = on);

-- 9e. Name-only catalog for the portal (qbo_items itself is denied above —
-- it carries purchase_cost). Owner-executed view, deliberately NO cost columns.
CREATE OR REPLACE VIEW ops.v_distributor_catalog AS
SELECT qbo_item_id, name, fully_qualified_name, category_path, active
FROM ops.qbo_items
WHERE COALESCE(active, TRUE);
GRANT SELECT ON ops.v_distributor_catalog TO authenticated;


-- ── 10. Portal RPCs ──────────────────────────────────────────────────────────

-- 10a. Create a restock order (member or staff).
CREATE OR REPLACE FUNCTION ops.fn_distributor_create_order(
  p_sub_distributor_id UUID,
  p_lines              JSONB,
  p_requested_date     DATE DEFAULT NULL,
  p_notes              TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_sub   ops.sub_distributors%ROWTYPE;
  v_id    UUID;
  v_line  JSONB;
  v_price NUMERIC;
BEGIN
  SELECT * INTO v_sub FROM ops.sub_distributors WHERE id = p_sub_distributor_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'sub-distributor not found'; END IF;
  IF NOT (ops.fn_is_staff() OR ops.fn_is_distributor_member(p_sub_distributor_id)) THEN
    RAISE EXCEPTION 'not a member of this distributor';
  END IF;
  IF v_sub.status = 'inactive' THEN
    RAISE EXCEPTION 'distributor is inactive';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty JSON array';
  END IF;

  INSERT INTO ops.sub_distributor_orders (
    sub_distributor_id, order_number, status, requested_date, notes,
    submitted_by, submitted_by_email
  ) VALUES (
    p_sub_distributor_id, ops.fn_next_sdo_number(), 'submitted',
    p_requested_date, p_notes, auth.uid(), auth.jwt()->>'email'
  ) RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF (v_line->>'qbo_item_id') IS NULL OR (v_line->>'qty') IS NULL THEN
      RAISE EXCEPTION 'each line requires qbo_item_id and qty';
    END IF;
    IF (v_line->>'qty')::numeric <= 0 THEN
      RAISE EXCEPTION 'qty must be > 0';
    END IF;
    -- Sell-in orders snapshot the contract price (contract → BX-1 → null).
    v_price := NULL;
    IF v_sub.model = 'sell_in' AND v_sub.qbo_customer_id IS NOT NULL THEN
      BEGIN
        v_price := ops.resolve_price(v_sub.qbo_customer_id, v_line->>'qbo_item_id', CURRENT_DATE);
      EXCEPTION WHEN OTHERS THEN v_price := NULL;
      END;
    END IF;
    INSERT INTO ops.sub_distributor_order_lines (order_id, qbo_item_id, qty, unit_price, notes)
    VALUES (v_id, v_line->>'qbo_item_id', (v_line->>'qty')::numeric, v_price, v_line->>'notes');
  END LOOP;

  RETURN v_id;
END; $$;

GRANT EXECUTE ON FUNCTION ops.fn_distributor_create_order(UUID, JSONB, DATE, TEXT) TO authenticated;

-- 10b. Cancel while still submitted (member or staff).
CREATE OR REPLACE FUNCTION ops.fn_distributor_cancel_order(p_order_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_ord ops.sub_distributor_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_ord FROM ops.sub_distributor_orders WHERE id = p_order_id FOR UPDATE;
  IF v_ord.id IS NULL THEN RAISE EXCEPTION 'order not found'; END IF;
  IF NOT (ops.fn_is_staff() OR ops.fn_is_distributor_member(v_ord.sub_distributor_id)) THEN
    RAISE EXCEPTION 'not a member of this distributor';
  END IF;
  IF v_ord.status <> 'submitted' THEN
    RAISE EXCEPTION 'order % is %, only submitted orders can be cancelled', v_ord.order_number, v_ord.status;
  END IF;
  UPDATE ops.sub_distributor_orders
     SET status = 'cancelled', decided_by = auth.uid(), decided_at = now(),
         decision_notes = COALESCE(p_reason, decision_notes)
   WHERE id = p_order_id;
END; $$;

GRANT EXECUTE ON FUNCTION ops.fn_distributor_cancel_order(UUID, TEXT) TO authenticated;

-- 10c. STAFF: fulfill an order — creates the draft BOL transfer to the
-- distributor's location (ship/receive then run through the normal Stock flow).
CREATE OR REPLACE FUNCTION ops.fn_fulfill_distributor_order(
  p_order_id         UUID,
  p_from_location_id UUID,
  p_notes            TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_ord      ops.sub_distributor_orders%ROWTYPE;
  v_sub      ops.sub_distributors%ROWTYPE;
  v_lines    JSONB;
  v_transfer UUID;
BEGIN
  IF NOT ops.fn_is_staff() THEN RAISE EXCEPTION 'staff only'; END IF;
  SELECT * INTO v_ord FROM ops.sub_distributor_orders WHERE id = p_order_id FOR UPDATE;
  IF v_ord.id IS NULL THEN RAISE EXCEPTION 'order not found'; END IF;
  IF v_ord.status <> 'submitted' THEN
    RAISE EXCEPTION 'order % is %, only submitted orders can be fulfilled', v_ord.order_number, v_ord.status;
  END IF;
  SELECT * INTO v_sub FROM ops.sub_distributors WHERE id = v_ord.sub_distributor_id;
  IF v_sub.inventory_location_id IS NULL THEN
    RAISE EXCEPTION 'distributor % has no inventory location — set one on the Sub-Distributors page first', v_sub.name;
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'qbo_item_id', l.qbo_item_id, 'qty', l.qty,
           'notes', l.notes))
    INTO v_lines
  FROM ops.sub_distributor_order_lines l WHERE l.order_id = p_order_id;
  IF v_lines IS NULL THEN RAISE EXCEPTION 'order has no lines'; END IF;

  -- Explicit 12-arg signature — legacy overloads of fn_create_transfer are
  -- still live (see 20260721a's overload-trap note).
  v_transfer := ops.fn_create_transfer(
    p_from_location_id, v_sub.inventory_location_id, v_lines,
    NULL, NULL,
    COALESCE(p_notes, 'Sub-distributor order ' || v_ord.order_number || ' · ' || v_sub.name),
    NULL, NULL, NULL, NULL, NULL, NULL);

  UPDATE ops.sub_distributor_orders
     SET status = 'fulfilled', decided_by = auth.uid(), decided_at = now(),
         decision_notes = COALESCE(p_notes, decision_notes),
         transfer_id = v_transfer
   WHERE id = p_order_id;

  RETURN v_transfer;
END; $$;

GRANT EXECUTE ON FUNCTION ops.fn_fulfill_distributor_order(UUID, UUID, TEXT) TO authenticated;

-- 10d. Distributor receive — per-line counted quantities. Shortfall stays in
-- TRANSIT (staff resolve it from the Stock tab); the transfer is flagged.
CREATE OR REPLACE FUNCTION ops.fn_distributor_receive_transfer(
  p_transfer_id             UUID,
  p_received_date           DATE DEFAULT NULL,
  p_receiver_signature_name TEXT DEFAULT NULL,
  p_lines                   JSONB DEFAULT NULL,   -- [{line_id, qty_received}]
  p_receiver_notes          TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_tr        ops.inventory_transfers%ROWTYPE;
  v_transit   UUID;
  v_actor     UUID := auth.uid();
  v_line      RECORD;
  v_recv      NUMERIC;
  v_short     BOOLEAN := FALSE;
  v_overrides JSONB := COALESCE(p_lines, '[]'::jsonb);
BEGIN
  SELECT * INTO v_tr FROM ops.inventory_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_tr.id IS NULL THEN RAISE EXCEPTION 'transfer not found'; END IF;
  IF v_tr.status <> 'in_transit' THEN
    RAISE EXCEPTION 'transfer % is %, can only receive from in_transit', v_tr.bol_number, v_tr.status;
  END IF;

  -- The receiver must belong to the distributor that owns the destination.
  IF NOT (ops.fn_is_staff() OR EXISTS (
    SELECT 1 FROM ops.sub_distributors sd
    WHERE sd.inventory_location_id = v_tr.to_location_id
      AND ops.fn_is_distributor_member(sd.id)
  )) THEN
    RAISE EXCEPTION 'not authorized to receive this transfer';
  END IF;

  IF p_receiver_signature_name IS NULL OR btrim(p_receiver_signature_name) = '' THEN
    RAISE EXCEPTION 'receiver signature name is required';
  END IF;

  SELECT id INTO v_transit FROM ops.inventory_locations WHERE code = 'TRANSIT';
  IF v_transit IS NULL THEN RAISE EXCEPTION 'TRANSIT location missing'; END IF;

  FOR v_line IN
    SELECT l.* FROM ops.inventory_transfer_lines l WHERE l.transfer_id = p_transfer_id
  LOOP
    SELECT COALESCE(
      (SELECT (o->>'qty_received')::numeric FROM jsonb_array_elements(v_overrides) o
        WHERE (o->>'line_id')::uuid = v_line.id LIMIT 1),
      v_line.qty
    ) INTO v_recv;
    IF v_recv IS NULL OR v_recv < 0 OR v_recv > v_line.qty THEN
      RAISE EXCEPTION 'qty_received for line % must be between 0 and %', v_line.id, v_line.qty;
    END IF;
    IF v_recv <> v_line.qty THEN v_short := TRUE; END IF;

    IF v_recv > 0 THEN
      INSERT INTO ops.inventory_movements (
        movement_type, qbo_item_id, qty, from_location_id, to_location_id,
        unit_cost, source_doc_type, source_doc_id, source_doc_line_id,
        occurred_at, created_by, notes
      ) VALUES (
        'transfer_receive', v_line.qbo_item_id, v_recv, v_transit, v_tr.to_location_id,
        v_line.unit_cost, 'transfer', p_transfer_id, v_line.id,
        COALESCE(p_received_date::timestamptz, now()), v_actor,
        CASE WHEN v_recv <> v_line.qty
             THEN 'Received ' || v_recv || ' of ' || v_line.qty || ' (discrepancy)'
             ELSE v_line.notes END
      );
    END IF;

    UPDATE ops.inventory_transfer_lines SET qty_received = v_recv WHERE id = v_line.id;
  END LOOP;

  UPDATE ops.inventory_transfers
     SET status                  = 'received',
         received_date           = COALESCE(p_received_date, CURRENT_DATE),
         received_by             = v_actor,
         receiver_signature_name = p_receiver_signature_name,
         receiver_signature_at   = now(),
         receiver_notes          = COALESCE(p_receiver_notes, receiver_notes),
         has_discrepancy         = v_short
   WHERE id = p_transfer_id;
END; $$;

GRANT EXECUTE ON FUNCTION ops.fn_distributor_receive_transfer(UUID, DATE, TEXT, JSONB, TEXT) TO authenticated;

-- 10e. E-sign a sent agreement (member only — staff send, partners sign).
CREATE OR REPLACE FUNCTION ops.fn_distributor_sign_agreement(
  p_agreement_id   UUID,
  p_signer_name    TEXT,
  p_signature_data TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_ag ops.sub_distributor_agreements%ROWTYPE;
BEGIN
  SELECT * INTO v_ag FROM ops.sub_distributor_agreements WHERE id = p_agreement_id FOR UPDATE;
  IF v_ag.id IS NULL THEN RAISE EXCEPTION 'agreement not found'; END IF;
  IF NOT ops.fn_is_distributor_member(v_ag.sub_distributor_id) THEN
    RAISE EXCEPTION 'not a member of this distributor';
  END IF;
  IF v_ag.status <> 'sent' THEN
    RAISE EXCEPTION 'agreement is %, only sent agreements can be signed', v_ag.status;
  END IF;
  IF p_signer_name IS NULL OR btrim(p_signer_name) = '' THEN
    RAISE EXCEPTION 'signer name is required';
  END IF;

  UPDATE ops.sub_distributor_agreements
     SET status = 'signed', signed_at = now(),
         signer_name = p_signer_name,
         signer_email = auth.jwt()->>'email',
         signer_user_id = auth.uid(),
         signature_data = p_signature_data
   WHERE id = p_agreement_id;
END; $$;

GRANT EXECUTE ON FUNCTION ops.fn_distributor_sign_agreement(UUID, TEXT, TEXT) TO authenticated;

-- 10f. Record depletions — cases delivered to a serviced account. Posts one
-- 'shipment' movement per item out of the distributor's location and
-- snapshots the consignment fee (agreement fee, else the registry default).
CREATE OR REPLACE FUNCTION ops.fn_distributor_record_depletion(
  p_sub_distributor_id UUID,
  p_account_id         UUID,
  p_delivered_date     DATE,
  p_lines              JSONB,          -- [{qbo_item_id, cases}]
  p_reference          TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_sub    ops.sub_distributors%ROWTYPE;
  v_acct   ops.sub_distributor_accounts%ROWTYPE;
  v_batch  UUID := gen_random_uuid();
  v_line   JSONB;
  v_fee    NUMERIC;
  v_mv     UUID;
  v_cases  NUMERIC;
BEGIN
  SELECT * INTO v_sub FROM ops.sub_distributors WHERE id = p_sub_distributor_id;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'sub-distributor not found'; END IF;
  IF NOT (ops.fn_is_staff() OR ops.fn_is_distributor_member(p_sub_distributor_id)) THEN
    RAISE EXCEPTION 'not a member of this distributor';
  END IF;
  IF v_sub.inventory_location_id IS NULL THEN
    RAISE EXCEPTION 'distributor has no inventory location';
  END IF;
  IF p_account_id IS NOT NULL THEN
    SELECT * INTO v_acct FROM ops.sub_distributor_accounts WHERE id = p_account_id;
    IF v_acct.id IS NULL OR v_acct.sub_distributor_id <> p_sub_distributor_id THEN
      RAISE EXCEPTION 'account does not belong to this distributor';
    END IF;
  END IF;
  IF p_delivered_date IS NULL THEN RAISE EXCEPTION 'delivered_date is required'; END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty JSON array';
  END IF;

  -- Consignment fee snapshot: latest signed consignment agreement wins,
  -- else the registry default. Sell-in depletions carry no fee.
  IF v_sub.model = 'consignment' THEN
    SELECT COALESCE(
      (SELECT a.per_case_delivery_fee FROM ops.sub_distributor_agreements a
        WHERE a.sub_distributor_id = p_sub_distributor_id
          AND a.status = 'signed' AND a.model = 'consignment'
          AND a.per_case_delivery_fee IS NOT NULL
        ORDER BY a.version DESC LIMIT 1),
      v_sub.per_case_delivery_fee
    ) INTO v_fee;
  ELSE
    v_fee := NULL;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF (v_line->>'qbo_item_id') IS NULL OR (v_line->>'cases') IS NULL THEN
      RAISE EXCEPTION 'each line requires qbo_item_id and cases';
    END IF;
    v_cases := (v_line->>'cases')::numeric;
    IF v_cases <= 0 THEN RAISE EXCEPTION 'cases must be > 0'; END IF;

    INSERT INTO ops.inventory_movements (
      movement_type, qbo_item_id, qty, from_location_id, to_location_id,
      source_doc_type, source_doc_id, occurred_at, created_by, notes
    ) VALUES (
      'shipment', v_line->>'qbo_item_id', v_cases, v_sub.inventory_location_id, NULL,
      'sub_distributor_depletion', v_batch,
      p_delivered_date::timestamptz, auth.uid(),
      'Depletion · ' || v_sub.name
        || COALESCE(' → ' || v_acct.account_name, '')
        || COALESCE(' · ref ' || NULLIF(btrim(p_reference), ''), '')
    ) RETURNING id INTO v_mv;

    INSERT INTO ops.sub_distributor_depletions (
      batch_id, sub_distributor_id, account_id, qbo_item_id, cases,
      delivered_date, reference, movement_id, fee_per_case, fee_amount,
      recorded_by, recorded_by_email
    ) VALUES (
      v_batch, p_sub_distributor_id, p_account_id, v_line->>'qbo_item_id', v_cases,
      p_delivered_date, p_reference, v_mv, v_fee,
      CASE WHEN v_fee IS NOT NULL THEN round(v_fee * v_cases, 2) END,
      auth.uid(), auth.jwt()->>'email'
    );
  END LOOP;

  RETURN v_batch;
END; $$;

GRANT EXECUTE ON FUNCTION ops.fn_distributor_record_depletion(UUID, UUID, DATE, JSONB, TEXT) TO authenticated;


-- ── 11. Storage: distributor-docs bucket (agreement PDFs) ────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('distributor-docs', 'distributor-docs', FALSE)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "distributor docs staff all" ON storage.objects;
CREATE POLICY "distributor docs staff all" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'distributor-docs' AND ops.fn_is_staff())
  WITH CHECK (bucket_id = 'distributor-docs' AND ops.fn_is_staff());

-- Members read only their own prefix: <sub_distributor_id>/...
DROP POLICY IF EXISTS "distributor docs member read" ON storage.objects;
CREATE POLICY "distributor docs member read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'distributor-docs'
         AND split_part(name, '/', 1) IN
             (SELECT x::text FROM ops.fn_my_distributor_ids() x));


-- ── 12. Seeds — the two live partners (details filled in by staff) ──────────
INSERT INTO ops.inventory_locations (code, name, kind, entity, is_active, notes)
VALUES
  ('ORIGINS',   'Origins Soda Co. (sub-distributor)', 'distributor', 'shared', TRUE,
   'Sub-distributor warehouse. Created by 20260818f; address to be filled in by staff.'),
  ('DESERTBEV', 'Desert Beverage (sub-distributor)',  'distributor', 'shared', TRUE,
   'Sub-distributor warehouse. Created by 20260818f; address to be filled in by staff.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO ops.sub_distributors (code, name, status, model, inventory_location_id, notes)
SELECT v.code, v.name, 'pending', 'consignment', l.id,
       'Seeded by 20260818f — link QBO/SF customer, set the per-case delivery fee, and file the agreement from Refractor → Sub-Distributors.'
FROM (VALUES
  ('ORIGINS',   'Origins Soda Co.'),
  ('DESERTBEV', 'Desert Beverage')
) AS v(code, name)
JOIN ops.inventory_locations l ON l.code = v.code
ON CONFLICT (code) DO NOTHING;
