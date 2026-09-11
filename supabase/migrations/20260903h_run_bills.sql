-- 20260903h — bills against a production run: the PO bill, the co-packer's
-- deposit, and the final invoice that UPDATES the deposit's QuickBooks bill in
-- place (Sky: "posts a temp bill in qbo that we can make a payment against.
-- once the production order is closed out, the bill gets attached and
-- reupdated and linked to the deposit invoice"; decision: ONE bill, updated).
--
-- Every payable is an ops.expense_requests row in the shape the rebate and
-- sub-distributor settlements already use (approved, as_bill, tag Production):
-- nothing here touches QuickBooks — a human posts from Brixpense, and the new
-- `mode:'update'` in expense-request-link-bill re-posts a changed total onto
-- the SAME QBO Bill (sparse update keeps the deposit BillPayment applied).
-- ops.production_run_bills is the register: which request is which document
-- of which run. QBO / payment state is READ THROUGH the request, never copied.
BEGIN;

CREATE TABLE IF NOT EXISTS ops.production_run_bills (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                  UUID REFERENCES ops.production_runs(id) ON DELETE RESTRICT,
  po_id                   UUID REFERENCES ops.purchase_orders(id) ON DELETE RESTRICT,
  kind                    TEXT NOT NULL CHECK (kind IN ('deposit', 'final', 'po')),
  expense_request_id      UUID NOT NULL UNIQUE REFERENCES ops.expense_requests(id) ON DELETE RESTRICT,
  linked_deposit_bill_id  UUID REFERENCES ops.production_run_bills(id) ON DELETE RESTRICT,
  qbo_vendor_id           TEXT NOT NULL,
  vendor_invoice_number   TEXT,
  invoice_date            DATE,
  amount_gross            NUMERIC NOT NULL CHECK (amount_gross >= 0),
  amount_net              NUMERIC,
  note                    TEXT,
  created_by              UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (run_id IS NOT NULL OR po_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS production_run_bills_run_idx ON ops.production_run_bills (run_id);
CREATE INDEX IF NOT EXISTS production_run_bills_po_idx  ON ops.production_run_bills (po_id);

ALTER TABLE ops.production_run_bills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS production_run_bills_select ON ops.production_run_bills;
CREATE POLICY production_run_bills_select ON ops.production_run_bills FOR SELECT TO authenticated USING (ops.fn_is_staff());
DROP POLICY IF EXISTS production_run_bills_no_distributor ON ops.production_run_bills;
CREATE POLICY production_run_bills_no_distributor ON ops.production_run_bills AS RESTRICTIVE FOR ALL TO authenticated USING (ops.fn_is_staff() OR NOT ops.fn_is_distributor());
GRANT SELECT ON ops.production_run_bills TO authenticated;
GRANT ALL ON ops.production_run_bills TO service_role;
REVOKE ALL ON ops.production_run_bills FROM anon;

-- What was LAST sent to QuickBooks for this request. Set by
-- expense-request-link-bill on create and on update; a posted request whose
-- total_amount differs from it is the one that needs "Update in QuickBooks".
ALTER TABLE ops.expense_requests ADD COLUMN IF NOT EXISTS qbo_posted_amount NUMERIC;
UPDATE ops.expense_requests SET qbo_posted_amount = total_amount
 WHERE status = 'posted' AND qbo_bill_id IS NOT NULL AND qbo_posted_amount IS NULL;

CREATE OR REPLACE VIEW ops.v_production_run_bills WITH (security_invoker = on) AS
SELECT b.*,
       r.run_number, po.po_number,
       v.display_name AS vendor_name,
       er.status AS request_status, er.qbo_bill_id, er.posted_at, er.paid_at, er.qbo_balance,
       er.total_amount AS request_total, er.qbo_posted_amount, er.archived_at, er.bill_number,
       CASE WHEN er.archived_at IS NOT NULL THEN 'archived'
            WHEN er.paid_at IS NOT NULL THEN 'paid'
            WHEN er.status = 'posted' AND er.qbo_posted_amount IS DISTINCT FROM er.total_amount THEN 'needs_update'
            WHEN er.status = 'posted' THEN 'posted'
            ELSE 'to_post' END AS bill_state
  FROM ops.production_run_bills b
  JOIN ops.expense_requests er ON er.id = b.expense_request_id
  LEFT JOIN ops.production_runs r ON r.id = b.run_id
  LEFT JOIN ops.purchase_orders po ON po.id = b.po_id
  LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = b.qbo_vendor_id;
GRANT SELECT ON ops.v_production_run_bills TO authenticated, service_role;

-- ── the one insert shape ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_production_bill_request__i(
  p_vendor_qbo_id text, p_total numeric, p_invoice_number text, p_invoice_date date,
  p_memo text, p_description text, p_lines jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE v_vendor text; v_acct text; v_acct_name text; v_email text; v_id uuid;
BEGIN
  SELECT display_name INTO v_vendor FROM ops.qbo_vendors WHERE qbo_vendor_id = p_vendor_qbo_id;
  IF v_vendor IS NULL THEN RAISE EXCEPTION 'vendor % is not in the QuickBooks vendor mirror', p_vendor_qbo_id; END IF;
  SELECT clearing_account_ref_id, clearing_account_name INTO v_acct, v_acct_name FROM ops.production_settings WHERE id;
  v_email := auth.jwt() ->> 'email';
  INSERT INTO ops.expense_requests (
    request_type, status, vendor_name, vendor_id, total_amount, receipt_date,
    tag, as_bill, auto_approved, memo, description, line_items,
    bill_number, entity, cogs_account_id, cogs_account_label,
    submitted_by, submitter_email, submitter_name, approved_at, approved_by)
  VALUES (
    'expense', 'approved', v_vendor, p_vendor_qbo_id, round(p_total, 2), COALESCE(p_invoice_date, current_date),
    'Production', TRUE, TRUE, p_memo, p_description, p_lines,
    left(NULLIF(btrim(p_invoice_number), ''), 21), 'brix', v_acct, v_acct_name,
    auth.uid(), v_email, COALESCE(v_email, 'Refractor Production'), now(), 'system (production bill)')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION ops.fn_production_bill_request__i(text, numeric, text, date, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ── a closed PO becomes a bill ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_po_create_bill(p_po_id uuid, p_vendor_invoice_number text, p_invoice_date date DEFAULT current_date, p_total_override numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE po ops.purchase_orders%ROWTYPE; v_lines jsonb; v_total numeric; v_er uuid; v_bill uuid; v_run text; v_actor uuid := auth.uid();
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT * INTO po FROM ops.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF po.id IS NULL THEN RAISE EXCEPTION 'purchase order not found'; END IF;
  IF po.status <> 'closed' THEN RAISE EXCEPTION '% is %; a bill is created once the purchase order is closed', po.po_number, po.status; END IF;
  IF EXISTS (SELECT 1 FROM ops.production_run_bills b JOIN ops.expense_requests er ON er.id = b.expense_request_id WHERE b.po_id = p_po_id AND er.archived_at IS NULL) THEN
    RAISE EXCEPTION '% already has a bill — archive it in Brixpense before creating another', po.po_number;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'description', COALESCE(l.description, qi.name, l.qbo_item_id), 'qty', l.qty_ordered, 'unit_price', l.unit_cost,
           'amount', round(l.qty_ordered * l.unit_cost, 2), 'qbo_item_id', l.qbo_item_id) ORDER BY l.sort_order), '[]'::jsonb),
         COALESCE(sum(round(l.qty_ordered * l.unit_cost, 2)), 0)
    INTO v_lines, v_total
    FROM ops.purchase_order_lines l LEFT JOIN ops.qbo_items qi ON qi.qbo_item_id = l.qbo_item_id WHERE l.po_id = p_po_id;
  IF p_total_override IS NOT NULL AND round(p_total_override, 2) <> round(v_total, 2) THEN
    -- the vendor billed a different total: keep the PO lines and carry the difference as its own line, so the variance is visible in the ledger
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('description', 'Invoice variance vs PO ' || po.po_number, 'qty', 1, 'unit_price', round(p_total_override - v_total, 2), 'amount', round(p_total_override - v_total, 2)));
    v_total := p_total_override;
  END IF;
  SELECT run_number INTO v_run FROM ops.production_runs WHERE id = po.production_run_id;
  v_er := ops.fn_production_bill_request__i(po.qbo_vendor_id, v_total, p_vendor_invoice_number, p_invoice_date,
    'Vendor bill for ' || po.po_number || COALESCE(' · run ' || v_run, ''),
    'Purchase order ' || po.po_number || COALESCE(' · ' || v_run, '') || CASE WHEN p_vendor_invoice_number IS NOT NULL THEN ' · vendor invoice ' || p_vendor_invoice_number ELSE '' END,
    v_lines);
  INSERT INTO ops.production_run_bills (run_id, po_id, kind, expense_request_id, qbo_vendor_id, vendor_invoice_number, invoice_date, amount_gross, amount_net, created_by)
  VALUES (po.production_run_id, p_po_id, 'po', v_er, po.qbo_vendor_id, p_vendor_invoice_number, p_invoice_date, round(v_total, 2), round(v_total, 2), v_actor)
  RETURNING id INTO v_bill;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  VALUES ('purchase_order', p_po_id, 'bill', 'Bill created in Brixpense · ' || round(v_total, 2) || COALESCE(' · invoice ' || p_vendor_invoice_number, ''), v_actor);
  RETURN jsonb_build_object('bill_id', v_bill, 'expense_request_id', v_er, 'total', round(v_total, 2), 'lines', jsonb_array_length(v_lines));
END $$;
REVOKE ALL ON FUNCTION ops.fn_po_create_bill(uuid, text, date, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_po_create_bill(uuid, text, date, numeric) TO authenticated, service_role;

-- ── the co-packer's deposit ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_run_record_deposit(p_run_id uuid, p_qbo_vendor_id text, p_amount numeric, p_invoice_number text, p_invoice_date date DEFAULT current_date, p_memo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE r ops.production_runs%ROWTYPE; v_er uuid; v_bill uuid; v_actor uuid := auth.uid();
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT * INTO r FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  IF r.status = 'void' THEN RAISE EXCEPTION '% is void', r.run_number; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'deposit amount must be above zero'; END IF;
  IF EXISTS (SELECT 1 FROM ops.production_run_bills b JOIN ops.expense_requests er ON er.id = b.expense_request_id
              WHERE b.run_id = p_run_id AND b.qbo_vendor_id = p_qbo_vendor_id AND b.kind = 'deposit' AND er.archived_at IS NULL) THEN
    RAISE EXCEPTION 'a deposit from this vendor is already recorded on % — record the final invoice against it instead', r.run_number;
  END IF;
  v_er := ops.fn_production_bill_request__i(p_qbo_vendor_id, p_amount, p_invoice_number, p_invoice_date,
    COALESCE(p_memo, 'Deposit for production order ' || r.run_number) || ' · the final invoice will UPDATE this bill in QuickBooks, not create a second one',
    'Deposit — ' || r.run_number || CASE WHEN p_invoice_number IS NOT NULL THEN ' · invoice ' || p_invoice_number ELSE '' END,
    jsonb_build_array(jsonb_build_object('description', 'Deposit — production order ' || r.run_number || COALESCE(' (invoice ' || p_invoice_number || ')', ''), 'qty', 1, 'unit_price', round(p_amount, 2), 'amount', round(p_amount, 2))));
  INSERT INTO ops.production_run_bills (run_id, kind, expense_request_id, qbo_vendor_id, vendor_invoice_number, invoice_date, amount_gross, amount_net, note, created_by)
  VALUES (p_run_id, 'deposit', v_er, p_qbo_vendor_id, p_invoice_number, p_invoice_date, round(p_amount, 2), round(p_amount, 2), p_memo, v_actor)
  RETURNING id INTO v_bill;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  VALUES ('run', p_run_id, 'bill', 'Deposit recorded · ' || round(p_amount, 2) || COALESCE(' · invoice ' || p_invoice_number, ''), v_actor);
  RETURN jsonb_build_object('bill_id', v_bill, 'expense_request_id', v_er, 'amount', round(p_amount, 2));
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_record_deposit(uuid, text, numeric, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_record_deposit(uuid, text, numeric, text, date, text) TO authenticated, service_role;

-- ── the final invoice: UPDATES the deposit's request in place ────────────────
CREATE OR REPLACE FUNCTION ops.fn_run_record_final_bill(p_run_id uuid, p_qbo_vendor_id text, p_amount_gross numeric, p_invoice_number text,
  p_invoice_date date DEFAULT current_date, p_deposit_bill_id uuid DEFAULT NULL, p_lines jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE r ops.production_runs%ROWTYPE; dep ops.production_run_bills%ROWTYPE; er ops.expense_requests%ROWTYPE;
  v_lines jsonb; v_er uuid; v_bill uuid; v_actor uuid := auth.uid(); v_net numeric;
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT * INTO r FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'run not found'; END IF;
  IF r.status = 'void' THEN RAISE EXCEPTION '% is void', r.run_number; END IF;
  IF p_amount_gross IS NULL OR p_amount_gross <= 0 THEN RAISE EXCEPTION 'the final invoice total must be above zero'; END IF;
  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) <> 'array' THEN RAISE EXCEPTION 'lines must be an array'; END IF;
  v_lines := COALESCE(p_lines, jsonb_build_array(jsonb_build_object(
    'description', 'Final invoice ' || COALESCE(p_invoice_number, '') || ' — production order ' || r.run_number, 'qty', 1,
    'unit_price', round(p_amount_gross, 2), 'amount', round(p_amount_gross, 2))));

  IF p_deposit_bill_id IS NOT NULL THEN
    SELECT * INTO dep FROM ops.production_run_bills WHERE id = p_deposit_bill_id FOR UPDATE;
    IF dep.id IS NULL OR dep.run_id <> p_run_id OR dep.kind <> 'deposit' THEN RAISE EXCEPTION 'that deposit is not on %', r.run_number; END IF;
    IF dep.qbo_vendor_id <> p_qbo_vendor_id THEN RAISE EXCEPTION 'the deposit was from a different vendor'; END IF;
    IF EXISTS (SELECT 1 FROM ops.production_run_bills WHERE linked_deposit_bill_id = dep.id) THEN RAISE EXCEPTION 'a final invoice is already recorded against that deposit'; END IF;
    SELECT * INTO er FROM ops.expense_requests WHERE id = dep.expense_request_id FOR UPDATE;
    IF er.archived_at IS NOT NULL THEN RAISE EXCEPTION 'the deposit''s bill was archived in Brixpense'; END IF;
    IF er.paid_at IS NOT NULL AND round(p_amount_gross, 2) < round(dep.amount_gross, 2) THEN
      RAISE EXCEPTION 'the final total (%) is below the deposit already paid (%)', round(p_amount_gross, 2), round(dep.amount_gross, 2);
    END IF;
    v_net := round(p_amount_gross - dep.amount_gross, 2);
    -- ONE bill. The deposit's request becomes the final: total, number, date and
    -- lines replaced; the deposit stays in the memo as context. A posted request
    -- now differs from qbo_posted_amount, which is what lights "Update in QuickBooks".
    UPDATE ops.expense_requests
       SET total_amount = round(p_amount_gross, 2),
           bill_number = left(NULLIF(btrim(p_invoice_number), ''), 21),
           receipt_date = COALESCE(p_invoice_date, receipt_date),
           line_items = v_lines,
           description = 'Final invoice ' || COALESCE(p_invoice_number, '') || ' — production order ' || r.run_number,
           memo = 'Final invoice for production order ' || r.run_number || ' · replaces deposit invoice ' || COALESCE(dep.vendor_invoice_number, '(no number)')
                  || ' of ' || round(dep.amount_gross, 2) || ' already ' || CASE WHEN er.paid_at IS NOT NULL THEN 'PAID' ELSE 'recorded' END
                  || ' on this same bill · balance due ' || v_net,
           qbo_balance = NULL, qbo_checked_at = NULL, autopost_error = NULL, updated_at = now()
     WHERE id = er.id;
    v_er := er.id;
  ELSE
    v_net := round(p_amount_gross, 2);
    v_er := ops.fn_production_bill_request__i(p_qbo_vendor_id, p_amount_gross, p_invoice_number, p_invoice_date,
      'Final invoice for production order ' || r.run_number,
      'Final invoice ' || COALESCE(p_invoice_number, '') || ' — production order ' || r.run_number, v_lines);
  END IF;
  INSERT INTO ops.production_run_bills (run_id, kind, expense_request_id, linked_deposit_bill_id, qbo_vendor_id, vendor_invoice_number, invoice_date, amount_gross, amount_net, created_by)
  VALUES (p_run_id, 'final', v_er, dep.id, p_qbo_vendor_id, p_invoice_number, p_invoice_date, round(p_amount_gross, 2), v_net, v_actor)
  ON CONFLICT (expense_request_id) DO UPDATE
    SET kind = 'final', linked_deposit_bill_id = EXCLUDED.linked_deposit_bill_id, vendor_invoice_number = EXCLUDED.vendor_invoice_number,
        invoice_date = EXCLUDED.invoice_date, amount_gross = EXCLUDED.amount_gross, amount_net = EXCLUDED.amount_net
  RETURNING id INTO v_bill;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  VALUES ('run', p_run_id, 'bill', 'Final invoice recorded · ' || round(p_amount_gross, 2) || COALESCE(' · invoice ' || p_invoice_number, '')
          || CASE WHEN dep.id IS NOT NULL THEN ' · updates the deposit bill in place, balance ' || v_net ELSE '' END, v_actor);
  RETURN jsonb_build_object('bill_id', v_bill, 'expense_request_id', v_er, 'amount_gross', round(p_amount_gross, 2), 'amount_net', v_net,
    'updates_existing_qbo_bill', (dep.id IS NOT NULL AND er.qbo_bill_id IS NOT NULL), 'qbo_bill_id', er.qbo_bill_id);
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_record_final_bill(uuid, text, numeric, text, date, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_record_final_bill(uuid, text, numeric, text, date, uuid, jsonb) TO authenticated, service_role;

-- ── attach a bill that arrived another way (AP inbox, hand-filed) ────────────
CREATE OR REPLACE FUNCTION ops.fn_run_link_bill(p_run_id uuid, p_kind text, p_expense_request_id uuid, p_po_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp' AS $$
DECLARE er ops.expense_requests%ROWTYPE; v_bill uuid; v_vendor text;
BEGIN
  PERFORM ops.fn_assert_internal();
  IF p_kind NOT IN ('deposit', 'final', 'po') THEN RAISE EXCEPTION 'kind must be deposit, final or po'; END IF;
  IF NOT EXISTS (SELECT 1 FROM ops.production_runs WHERE id = p_run_id) THEN RAISE EXCEPTION 'run not found'; END IF;
  SELECT * INTO er FROM ops.expense_requests WHERE id = p_expense_request_id;
  IF er.id IS NULL THEN RAISE EXCEPTION 'expense request not found'; END IF;
  IF EXISTS (SELECT 1 FROM ops.production_run_bills WHERE expense_request_id = p_expense_request_id) THEN RAISE EXCEPTION 'that bill is already linked to a run'; END IF;
  SELECT qbo_vendor_id INTO v_vendor FROM ops.qbo_vendors WHERE qbo_vendor_id = er.vendor_id OR lower(display_name) = lower(er.vendor_name) LIMIT 1;
  IF v_vendor IS NULL THEN RAISE EXCEPTION 'the bill''s vendor "%" is not in the QuickBooks vendor mirror', er.vendor_name; END IF;
  INSERT INTO ops.production_run_bills (run_id, po_id, kind, expense_request_id, qbo_vendor_id, vendor_invoice_number, invoice_date, amount_gross, amount_net, note, created_by)
  VALUES (p_run_id, p_po_id, p_kind, p_expense_request_id, v_vendor, er.bill_number, er.receipt_date, er.total_amount, er.total_amount, 'linked from Brixpense', auth.uid())
  RETURNING id INTO v_bill;
  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, created_by)
  VALUES ('run', p_run_id, 'bill', p_kind || ' bill linked · ' || er.total_amount, auth.uid());
  RETURN v_bill;
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_link_bill(uuid, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_link_bill(uuid, text, uuid, uuid) TO authenticated, service_role;

COMMIT;
