-- Inventory: the sales feed's first LIVE run failed, and the reason is one
-- shadow mode could never have shown.
--
-- ops.fn_apply_sales_to_ledger RETURNS TABLE(... invoice_line_id bigint ...)
-- and, when live, runs
--     INSERT INTO ops.sales_ledger_applied (...) ... ON CONFLICT (invoice_line_id) DO UPDATE ...
-- plpgsql sees two things called invoice_line_id — the OUT parameter and the
-- table column — and refuses: "column reference invoice_line_id is ambiguous".
-- In shadow the write never executes, so a day of "the preview numbers look
-- right" proved nothing about the write path. The very first commit tripped it,
-- 20260903a's runner recorded the error instead of dying, and the sales_feed
-- health check went red on the spot — which is the pipeline working as
-- designed, on its first minute of life.
--
-- Fix: `#variable_conflict use_column` — inside SQL statements a bare name that
-- matches BOTH a variable and a column now means the column. Every place this
-- body reads a variable in SQL is already qualified (r.*, p.*, il.*, ap.*), and
-- assignments to the OUT columns are plain assignments, so nothing else moves.
--
-- Also: EXECUTE on fn_apply_sales_to_ledger was granted to `authenticated`, so
-- ANY login on the shared project could have driven a live commit directly.
-- The runner (fn_sales_ledger_run, staff-or-service guarded) is the entry
-- point; the inner function is reached from it as the owner and needs no grant.

CREATE OR REPLACE FUNCTION ops.fn_apply_sales_to_ledger(p_commit boolean DEFAULT false)
 RETURNS TABLE(action text, invoice_line_id bigint, doc_number text, item_name text, qty numeric, location_code text, route_reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_mode text;
  v_live boolean;
  r RECORD;
  v_mv uuid;
BEGIN
  SELECT mode INTO v_mode FROM ops.sales_ledger_config;
  v_live := p_commit AND v_mode = 'live';
  IF v_mode = 'off' THEN RETURN; END IF;

  FOR r IN
    SELECT p.*, il.code AS loc_code
      FROM ops.v_sales_ledger_pending p
      JOIN ops.inventory_locations il ON il.id = p.location_id
     WHERE p.qty_delta <> 0
     ORDER BY p.txn_date, p.invoice_line_id
  LOOP
    IF v_live THEN
      INSERT INTO ops.inventory_movements (
        movement_type, qbo_item_id, qty, from_location_id, to_location_id,
        source_doc_type, occurred_at, notes
      ) VALUES (
        CASE WHEN r.qty_delta > 0 THEN 'shipment' ELSE 'receipt' END,
        r.qbo_item_id, abs(r.qty_delta),
        CASE WHEN r.qty_delta > 0 THEN r.location_id ELSE NULL END,
        CASE WHEN r.qty_delta > 0 THEN NULL ELSE r.location_id END,
        'qbo_sale', r.txn_date,
        r.txn_type || ' ' || COALESCE(r.doc_number, '?') || ' - ' ||
        COALESCE(r.customer_name, 'customer') || ' - ' || r.route_reason ||
        CASE WHEN r.qty_applied IS NOT NULL THEN ' - adjusted from ' || r.qty_applied ELSE '' END
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
$function$;

REVOKE ALL ON FUNCTION ops.fn_apply_sales_to_ledger(boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION ops.fn_apply_sales_to_ledger(boolean) TO service_role;
