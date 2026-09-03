-- Inventory: a sale deducts stock, from the location that served the customer.
--
-- THE GAP THIS CLOSES, measured rather than asserted: on 2026-09-01 we invoiced
-- 174 units of location-tracked stock. The next morning the ledger was 176
-- units adrift. That is the whole defect -- the ledger loses one day of sales
-- every day, because receiving a PO and running a work order write movements
-- and a SALE writes nothing.
--
-- WHY THE CUSTOMER DECIDES THE LOCATION (Sky, 2026-09-02): a sub-distributor is
-- always on consignment. Stock ships from us to their warehouse, they deliver
-- to OUR customers, and those customers are billed out of OUR system. So the
-- invoice is the depletion signal for their warehouse exactly as it is for
-- ours -- the only question an invoice cannot answer by itself is WHICH
-- building the case left, and that is what the customer mapping answers.
--
-- ⚠ NOT by state, and the data is emphatic: 315 of the 324 customers who buy
-- stock are in California, and the state field itself holds 'CA', 'California'
-- and 'San Francisco'. State sorts 97% of customers into one bucket. The
-- mapping is per customer, and it is cheap because only the exceptions are
-- entered -- everything else falls through to the warehouse.

-- ── 1. Where a customer's stock comes from ──────────────────────────────────
-- ops.sub_distributor_accounts already models this: it was built with the
-- sub-distributor program in 2026-08 and has a screen (Refractor →
-- Sub-Distributors → Accounts). Nothing had ever read it.
CREATE OR REPLACE FUNCTION ops.fn_sales_ledger_location(p_qbo_customer_id text)
RETURNS TABLE(location_id uuid, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $fn$
  -- Each branch is parenthesised: ORDER BY/LIMIT inside a UNION arm is a
  -- syntax error without it, and both arms need their own ordering.
  (SELECT l.id, 'distributor:' || sd.code
     FROM ops.sub_distributor_accounts a
     JOIN ops.sub_distributors sd   ON sd.id = a.sub_distributor_id
     JOIN ops.inventory_locations l ON l.id  = sd.inventory_location_id
    WHERE a.qbo_customer_id = p_qbo_customer_id
      AND a.is_active AND l.is_active
    ORDER BY a.created_at DESC
    LIMIT 1)
  UNION ALL
  -- Everything not explicitly assigned to a partner ships from our own dock.
  (SELECT l.id, 'default_warehouse'
     FROM ops.inventory_locations l
    WHERE l.kind = 'warehouse' AND l.is_active
      AND NOT EXISTS (
        SELECT 1 FROM ops.sub_distributor_accounts a
         JOIN ops.sub_distributors sd ON sd.id = a.sub_distributor_id
        WHERE a.qbo_customer_id = p_qbo_customer_id AND a.is_active
          AND sd.inventory_location_id IS NOT NULL)
    ORDER BY (l.code = 'BRIX-WAREHOUSE') DESC, l.name
    LIMIT 1);
$fn$;

REVOKE EXECUTE ON FUNCTION ops.fn_sales_ledger_location(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_sales_ledger_location(text) TO authenticated, service_role;

-- ── 2. What the feed has already done ───────────────────────────────────────
-- Keyed on the invoice LINE, which is what makes a re-sync safe: QuickBooks
-- upserts a line in place when somebody edits an invoice, so the feed has to
-- be able to say "I already took 12 of these" and post only the difference.
CREATE TABLE IF NOT EXISTS ops.sales_ledger_applied (
  invoice_line_id bigint PRIMARY KEY,
  invoice_id      bigint      NOT NULL,
  qbo_item_id     text        NOT NULL,
  location_id     uuid        NOT NULL REFERENCES ops.inventory_locations(id),
  route_reason    text        NOT NULL,
  qty_applied     numeric     NOT NULL,
  movement_id     uuid,
  reversed_at     timestamptz,
  applied_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_ledger_applied_invoice ON ops.sales_ledger_applied(invoice_id);

ALTER TABLE ops.sales_ledger_applied ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_ledger_applied_read ON ops.sales_ledger_applied;
CREATE POLICY sales_ledger_applied_read ON ops.sales_ledger_applied
  FOR SELECT TO authenticated USING (ops.fn_is_staff());
GRANT SELECT ON ops.sales_ledger_applied TO authenticated;

-- ── 3. The switch ───────────────────────────────────────────────────────────
-- ⚠ SHADOW BY DEFAULT, and that is the whole cutover plan. The feed and the
-- reconcile must never both be authoritative: reconcile sets the ledger EQUAL
-- to QuickBooks, so if it runs while the mirror's qty_on_hand is a few hours
-- behind the invoices the feed has already deducted, it adds them straight
-- back. In shadow the feed computes and records nothing, so its numbers can be
-- compared against the drift the strip reports for a day or two before anyone
-- lets it write. Flip to 'live' only once those two agree.
CREATE TABLE IF NOT EXISTS ops.sales_ledger_config (
  only_row   boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  mode       text    NOT NULL DEFAULT 'shadow' CHECK (mode IN ('off','shadow','live')),
  apply_from date    NOT NULL DEFAULT current_date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ops.sales_ledger_config (only_row) VALUES (true) ON CONFLICT DO NOTHING;
GRANT SELECT ON ops.sales_ledger_config TO authenticated;

-- ── 4. What the feed would do next ──────────────────────────────────────────
-- Invoice and SalesReceipt take stock out; CreditMemo and RefundReceipt put it
-- back. All four are mirrored, so all four are handled -- a feed that only knew
-- about invoices would ratchet the ledger down and never let a return up.
CREATE OR REPLACE VIEW ops.v_sales_ledger_pending AS
SELECT l.id                                    AS invoice_line_id,
       l.invoice_id,
       i.txn_type, i.txn_date, i.doc_number,
       i.customer_ref_id, i.customer_name,
       l.item_ref_id                           AS qbo_item_id,
       COALESCE(l.item_name, l.description)    AS item_name,
       CASE WHEN i.txn_type IN ('CreditMemo','RefundReceipt')
            THEN -COALESCE(l.quantity, 0) ELSE COALESCE(l.quantity, 0) END AS qty_out,
       loc.location_id, loc.reason             AS route_reason,
       ap.qty_applied,
       CASE WHEN i.txn_type IN ('CreditMemo','RefundReceipt')
            THEN -COALESCE(l.quantity, 0) ELSE COALESCE(l.quantity, 0) END
         - COALESCE(ap.qty_applied, 0)         AS qty_delta
  FROM ops.qbo_invoice_lines l
  JOIN ops.qbo_invoices i        ON i.id = l.invoice_id
  JOIN ops.inventory_settings s  ON s.qbo_item_id = l.item_ref_id AND s.track_locations
  CROSS JOIN LATERAL ops.fn_sales_ledger_location(i.customer_ref_id) loc
  LEFT JOIN ops.sales_ledger_applied ap ON ap.invoice_line_id = l.id
 WHERE i.txn_date >= (SELECT apply_from FROM ops.sales_ledger_config)
   AND loc.location_id IS NOT NULL
   AND COALESCE(l.quantity, 0) <> 0;

GRANT SELECT ON ops.v_sales_ledger_pending TO authenticated;

-- ── 5. Apply it ─────────────────────────────────────────────────────────────
-- Returns what it did (or, in shadow / preview, what it would do). Three cases
-- it has to get right, and only the first is obvious:
--   NEW    a line nobody has taken stock for yet
--   EDITED QuickBooks upserts a line in place, so the quantity can change under
--          us. Post the DIFFERENCE, never a second full deduction.
--   VOIDED the line has gone from the mirror. Put the stock back, and keep the
--          applied row stamped `reversed_at` rather than deleting it -- the
--          question "why did 12 cases come back on the 4th" needs an answer.
CREATE OR REPLACE FUNCTION ops.fn_apply_sales_to_ledger(p_commit boolean DEFAULT false)
RETURNS TABLE(action text, invoice_line_id bigint, doc_number text, item_name text,
              qty numeric, location_code text, route_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $fn$
DECLARE
  v_mode text;
  v_live boolean;
  r RECORD;
  v_mv uuid;
BEGIN
  SELECT mode INTO v_mode FROM ops.sales_ledger_config;
  -- Writing requires BOTH an explicit commit and the switch out of shadow.
  -- Either one alone leaves this a dry run.
  v_live := p_commit AND v_mode = 'live';

  IF v_mode = 'off' THEN
    RETURN;
  END IF;

  -- NEW and EDITED
  FOR r IN
    SELECT p.*, il.code AS loc_code
      FROM ops.v_sales_ledger_pending p
      JOIN ops.inventory_locations il ON il.id = p.location_id
     WHERE p.qty_delta <> 0
     ORDER BY p.txn_date, p.invoice_line_id
  LOOP
    IF v_live THEN
      INSERT INTO ops.inventory_movements (
        movement_type, qbo_item_id, qty,
        from_location_id, to_location_id,
        source_doc_type, occurred_at, notes
      ) VALUES (
        CASE WHEN r.qty_delta > 0 THEN 'shipment' ELSE 'receipt' END,
        r.qbo_item_id, abs(r.qty_delta),
        CASE WHEN r.qty_delta > 0 THEN r.location_id ELSE NULL END,
        CASE WHEN r.qty_delta > 0 THEN NULL ELSE r.location_id END,
        'qbo_sale', r.txn_date,
        r.txn_type || ' ' || COALESCE(r.doc_number, '?') || ' · ' ||
        COALESCE(r.customer_name, 'customer') || ' · ' || r.route_reason ||
        CASE WHEN r.qty_applied IS NOT NULL THEN ' · adjusted from ' || r.qty_applied ELSE '' END
      ) RETURNING id INTO v_mv;

      INSERT INTO ops.sales_ledger_applied (
        invoice_line_id, invoice_id, qbo_item_id, location_id,
        route_reason, qty_applied, movement_id)
      VALUES (r.invoice_line_id, r.invoice_id, r.qbo_item_id, r.location_id,
              r.route_reason, r.qty_out, v_mv)
      ON CONFLICT (invoice_line_id) DO UPDATE
        SET qty_applied = EXCLUDED.qty_applied, movement_id = EXCLUDED.movement_id,
            location_id = EXCLUDED.location_id, route_reason = EXCLUDED.route_reason,
            reversed_at = NULL, updated_at = now();
    END IF;

    action := CASE WHEN r.qty_applied IS NULL THEN 'new' ELSE 'edited' END;
    invoice_line_id := r.invoice_line_id; doc_number := r.doc_number;
    item_name := r.item_name; qty := r.qty_delta;
    location_code := r.loc_code; route_reason := r.route_reason;
    RETURN NEXT;
  END LOOP;

  -- VOIDED: applied, but the line is no longer in the mirror.
  FOR r IN
    SELECT ap.*, il.code AS loc_code
      FROM ops.sales_ledger_applied ap
      JOIN ops.inventory_locations il ON il.id = ap.location_id
     WHERE ap.reversed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM ops.qbo_invoice_lines l WHERE l.id = ap.invoice_line_id)
  LOOP
    IF v_live THEN
      INSERT INTO ops.inventory_movements (
        movement_type, qbo_item_id, qty, from_location_id, to_location_id,
        source_doc_type, occurred_at, notes
      ) VALUES (
        CASE WHEN r.qty_applied > 0 THEN 'receipt' ELSE 'shipment' END,
        r.qbo_item_id, abs(r.qty_applied),
        CASE WHEN r.qty_applied > 0 THEN NULL ELSE r.location_id END,
        CASE WHEN r.qty_applied > 0 THEN r.location_id ELSE NULL END,
        'qbo_sale_void', now(),
        'Sale reversed - the invoice line is no longer in QuickBooks'
      );
      UPDATE ops.sales_ledger_applied
         SET reversed_at = now(), updated_at = now()
       WHERE invoice_line_id = r.invoice_line_id;
    END IF;

    action := 'voided'; invoice_line_id := r.invoice_line_id; doc_number := NULL;
    item_name := r.qbo_item_id; qty := -r.qty_applied;
    location_code := r.loc_code; route_reason := r.route_reason;
    RETURN NEXT;
  END LOOP;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION ops.fn_apply_sales_to_ledger(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_apply_sales_to_ledger(boolean) TO authenticated, service_role;

-- ── 6. One mechanism for stock, not two ─────────────────────────────────────
-- ⚠ ops.fn_distributor_record_depletion posted its OWN shipment movement out of
-- the partner's location. With this feed live that is the same case deducted
-- twice: once when the customer is invoiced and once when the delivery is keyed
-- in. Zero depletions exist today so there is nothing to unwind, but the code
-- path is live, so the movement is REMOVED here rather than left as a trap.
--
-- The depletion record itself stays and keeps earning its place: it is the
-- DELIVERY and the per-case fee we owe the partner -- what the delivery PO and
-- the "their invoice matches ours" check will be built on. It is simply no
-- longer the thing that moves stock. `movement_id` stays on the table (older
-- rows may point at one) and is left NULL from here.
CREATE OR REPLACE FUNCTION ops.fn_distributor_record_depletion(
  p_sub_distributor_id uuid, p_account_id uuid, p_delivered_date date,
  p_lines jsonb, p_reference text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $fn$
DECLARE
  v_sub   ops.sub_distributors%ROWTYPE;
  v_acct  ops.sub_distributor_accounts%ROWTYPE;
  v_batch UUID := gen_random_uuid();
  v_line  JSONB;
  v_fee   NUMERIC;
  v_cases NUMERIC;
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

    -- No inventory movement here, deliberately. See the note above.
    INSERT INTO ops.sub_distributor_depletions (
      batch_id, sub_distributor_id, account_id, qbo_item_id, cases,
      delivered_date, reference, movement_id, fee_per_case, fee_amount,
      recorded_by, recorded_by_email
    ) VALUES (
      v_batch, p_sub_distributor_id, p_account_id, v_line->>'qbo_item_id', v_cases,
      p_delivered_date, p_reference, NULL, v_fee,
      CASE WHEN v_fee IS NOT NULL THEN round(v_fee * v_cases, 2) END,
      auth.uid(), auth.jwt()->>'email'
    );
  END LOOP;

  RETURN v_batch;
END;
$fn$;

COMMENT ON FUNCTION ops.fn_distributor_record_depletion(uuid, uuid, date, jsonb, text) IS
  'Records a partner delivery and the per-case fee owed. Does NOT move stock: the QuickBooks sales feed (ops.fn_apply_sales_to_ledger) owns depletion, because our system bills the end customer. Two writers would deduct every consigned case twice.';

-- ── 7. What the feed is doing, in one row per destination ───────────────────
CREATE OR REPLACE VIEW ops.v_sales_ledger_summary AS
SELECT c.mode, c.apply_from,
       l.code                        AS location_code,
       l.name                        AS location_name,
       p.route_reason,
       count(*)                      AS lines_pending,
       sum(p.qty_delta)              AS units_pending
  FROM ops.sales_ledger_config c
  CROSS JOIN ops.v_sales_ledger_pending p
  JOIN ops.inventory_locations l ON l.id = p.location_id
 WHERE p.qty_delta <> 0
 GROUP BY c.mode, c.apply_from, l.code, l.name, p.route_reason;

GRANT SELECT ON ops.v_sales_ledger_summary TO authenticated;

-- Staff flip the switch; nobody else. Kept as an RPC rather than a table grant
-- so 'live' cannot be set by a stray PATCH from a browser.
CREATE OR REPLACE FUNCTION ops.fn_sales_ledger_set_mode(p_mode text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $fn$
BEGIN
  IF NOT ops.fn_is_staff() THEN RAISE EXCEPTION 'staff only'; END IF;
  IF p_mode NOT IN ('off','shadow','live') THEN
    RAISE EXCEPTION 'mode must be off, shadow or live';
  END IF;
  UPDATE ops.sales_ledger_config SET mode = p_mode, updated_at = now();
  RETURN p_mode;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION ops.fn_sales_ledger_set_mode(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_sales_ledger_set_mode(text) TO authenticated, service_role;
