-- 20260903i — three corrections to 20260903h found by the live rolled-back proof.
--
-- 1. A final invoice recorded against a PAID deposit must read "Update QB",
--    not "Paid": the deposit payment stays applied, but the bill now carries a
--    balance again. The view tested paid_at before the changed-total test, so
--    the row that most needs a human's click would have read as finished.
-- 2. The same final must clear paid_at on the request: bill-paid-sync's pool is
--    `qbo_bill_id not null AND paid_at null`, so a stamped paid_at would have
--    kept the sync from ever re-reading the balance after the update — the
--    bill would stay "Paid & closed" in Brixpense with money still owed.
-- 3. fn_production_bill_request__i inserted submitted_by = auth.uid(), which
--    is NULL for a service-role or SQL caller and violates the NOT NULL — the
--    error named a column, not the cause. A bill is a human's record; refuse
--    with a sentence rather than invent an actor.
BEGIN;

CREATE OR REPLACE VIEW ops.v_production_run_bills WITH (security_invoker = on) AS
SELECT b.*,
       r.run_number, po.po_number,
       v.display_name AS vendor_name,
       er.status AS request_status, er.qbo_bill_id, er.posted_at, er.paid_at, er.qbo_balance,
       er.total_amount AS request_total, er.qbo_posted_amount, er.archived_at, er.bill_number,
       CASE WHEN er.archived_at IS NOT NULL THEN 'archived'
            WHEN er.status = 'posted' AND er.qbo_posted_amount IS DISTINCT FROM er.total_amount THEN 'needs_update'
            WHEN er.paid_at IS NOT NULL THEN 'paid'
            WHEN er.status = 'posted' THEN 'posted'
            ELSE 'to_post' END AS bill_state
  FROM ops.production_run_bills b
  JOIN ops.expense_requests er ON er.id = b.expense_request_id
  LEFT JOIN ops.production_runs r ON r.id = b.run_id
  LEFT JOIN ops.purchase_orders po ON po.id = b.po_id
  LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = b.qbo_vendor_id;
GRANT SELECT ON ops.v_production_run_bills TO authenticated, service_role;

-- (3) name the cause
DO $$
DECLARE v_src text; v_a text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p WHERE p.pronamespace='ops'::regnamespace AND p.proname='fn_production_bill_request__i';
  IF v_src LIKE '%20260903i%' THEN RAISE NOTICE 'already applied'; RETURN; END IF;
  v_a := E'  v_email := auth.jwt() ->> ''email'';\n';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (bill-req) found % times', v_n; END IF;
  v_src := replace(v_src, v_a, v_a
    || E'  IF auth.uid() IS NULL THEN   -- 20260903i\n'
    || E'    RAISE EXCEPTION ''a bill is recorded by a signed-in user — no session on this call'';\n'
    || E'  END IF;\n');
  EXECUTE v_src;
END $$;
REVOKE ALL ON FUNCTION ops.fn_production_bill_request__i(text, numeric, text, date, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- (2) the final un-pays the deposit's request
DO $$
DECLARE v_src text; v_a text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p WHERE p.pronamespace='ops'::regnamespace AND p.proname='fn_run_record_final_bill';
  IF v_src LIKE '%20260903i%' THEN RAISE NOTICE 'already applied'; RETURN; END IF;
  v_a := 'qbo_balance = NULL, qbo_checked_at = NULL, autopost_error = NULL, updated_at = now()';
  v_n := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor (final-unpay) found % times', v_n; END IF;
  v_src := replace(v_src, v_a,
    'qbo_balance = NULL, qbo_checked_at = NULL, autopost_error = NULL, paid_at = NULL /* 20260903i: a balance is owed again; bill-paid-sync re-reads it */, updated_at = now()');
  EXECUTE v_src;
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_record_final_bill(uuid, text, numeric, text, date, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_record_final_bill(uuid, text, numeric, text, date, uuid, jsonb) TO authenticated, service_role;

COMMIT;
