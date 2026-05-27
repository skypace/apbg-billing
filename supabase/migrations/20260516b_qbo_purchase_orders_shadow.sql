-- Shadow tables for QBO-direct purchase orders. The existing ops.purchase_orders
-- table is for BRIX-native POs (operator creates in BRIX, pushes to QBO). These
-- shadow tables mirror QBO POs created directly in QBO so they can count toward
-- the inventory On Order calculation in fn_items_master.
--
-- Read-only mirror — operator imports via the "Pull POs from QBO" picker on
-- the Production page. Source of truth stays in QBO; re-pull to refresh.
--
-- Already applied to the live DB on 2026-05-16 via Supabase MCP.

CREATE TABLE IF NOT EXISTS ops.qbo_purchase_orders (
  qbo_id text PRIMARY KEY,
  doc_number text,
  qbo_vendor_id text,
  vendor_name text,
  txn_date date,
  po_status text,
  total_amt numeric,
  memo text,
  sync_token text,
  raw jsonb,
  imported_at timestamptz DEFAULT now(),
  imported_by uuid,
  last_synced_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ops.qbo_purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qbo_po_id text NOT NULL REFERENCES ops.qbo_purchase_orders(qbo_id) ON DELETE CASCADE,
  line_num integer,
  qbo_item_id text,
  description text,
  qty numeric,
  unit_cost numeric,
  amount numeric
);

CREATE INDEX IF NOT EXISTS qbo_po_lines_item_idx ON ops.qbo_purchase_order_lines (qbo_item_id);
CREATE INDEX IF NOT EXISTS qbo_pos_status_idx ON ops.qbo_purchase_orders (po_status);
CREATE INDEX IF NOT EXISTS qbo_pos_vendor_idx ON ops.qbo_purchase_orders (qbo_vendor_id);

ALTER TABLE ops.qbo_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.qbo_purchase_order_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS qbo_pos_read ON ops.qbo_purchase_orders;
CREATE POLICY qbo_pos_read ON ops.qbo_purchase_orders FOR SELECT USING (true);

DROP POLICY IF EXISTS qbo_po_lines_read ON ops.qbo_purchase_order_lines;
CREATE POLICY qbo_po_lines_read ON ops.qbo_purchase_order_lines FOR SELECT USING (true);

COMMENT ON TABLE ops.qbo_purchase_orders IS 'Shadow mirror of QBO-direct PurchaseOrders. Read-only; populated via the import picker on the Production page.';
COMMENT ON TABLE ops.qbo_purchase_order_lines IS 'Line items of imported QBO POs. Feeds the on_order CTE in fn_items_master alongside BRIX-native ops.purchase_order_lines.';
