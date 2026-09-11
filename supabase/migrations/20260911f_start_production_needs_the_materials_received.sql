-- ⚠ CORRECTED BY 20260911g: the refusal's item join below spells the item column
-- `i.item_name`; ops.qbo_items has `name`, so as applied every start_production
-- failed 42703 until 20260911g replaced the reference. This file is left as the
-- record of what was applied; do not re-apply it.
-- 20260911f — start production refuses while raw materials are still unreceived.
--
-- Found on WO-2026-00023 (2026-09-11): item 525 (the syrup) read −583 at QUANTUM-
-- CANNING because `start_production` consumed the gallon BEFORE the Calderoni PO
-- was received. The ledger was right about the sequence and wrong about the world:
-- stock that has not arrived cannot be consumed, and a negative balance at the
-- co-packer is a number an operator cannot act on.
--
-- Rule: an `on_receipt` PO on this work order (or on its production order) with a
-- receivable line still short blocks `start_production`, and the refusal NAMES the
-- PO, the vendor and the outstanding lines — the action is to receive that PO
-- (Purchase Orders → Receive), which also moves the flavours to at_copacker by
-- itself (20260903d/g). `on_run_yield` lines are untouched: the co-packer's own
-- cans land at start, once, exactly as before.
--
-- Anchored read-modify-write of the LIVE `fn_wo_advance__i` (the 20260820b rule:
-- edit the inner, never CREATE OR REPLACE the guarded name; and the live text
-- carries 20260903d/e/f/g + 20260911a edits main never held as a file). Each
-- anchor is asserted to match exactly once, or nothing changes.

DO $do$
DECLARE
  t        text;
  a_decl   text := E'  v_royalty_cost     NUMERIC := 0;\nBEGIN';
  a_start  text := E'      RAISE EXCEPTION ''work order is %, expected ordered/at_copacker'', v_wo.status;\n    END IF;\n';
  s_decl   text := E'  v_royalty_cost     NUMERIC := 0;\n  v_unreceived       TEXT;                  -- 20260911f\nBEGIN';
  s_guard  text := $snip$
    -- 20260911f: raw material that has not been received is not at the co-packer, so it
    -- cannot be consumed. Any on_receipt PO on this work order (or its production order)
    -- with a receivable line still short blocks the start and names what is missing —
    -- item 525 read -583 at Quantum on WO-2026-00023 because start ran ahead of receipt.
    SELECT string_agg(x.msg, '; ') INTO v_unreceived
      FROM (SELECT po.po_number || ' (' || COALESCE(vn.display_name, po.qbo_vendor_id) || '): '
                   || string_agg(COALESCE(i.item_name, pl.qbo_item_id) || ' ' || trim(to_char(pl.qty_ordered - COALESCE(pl.qty_received, 0), 'FM999999990.###')), ', ') AS msg
              FROM ops.purchase_order_lines pl
              JOIN ops.purchase_orders po ON po.id = pl.po_id
              LEFT JOIN ops.qbo_vendors vn ON vn.qbo_vendor_id = po.qbo_vendor_id
              LEFT JOIN ops.qbo_items i ON i.qbo_item_id = pl.qbo_item_id
             WHERE (po.work_order_id = p_wo_id OR (v_wo.run_id IS NOT NULL AND po.production_run_id = v_wo.run_id))
               AND po.close_rule = 'on_receipt' AND po.status <> 'void'
               AND COALESCE(pl.receivable, true)
               AND pl.qty_ordered - COALESCE(pl.qty_received, 0) > 0.000001
             GROUP BY po.po_number, vn.display_name, po.qbo_vendor_id) x;
    IF v_unreceived IS NOT NULL THEN
      RAISE EXCEPTION '% cannot start production: raw materials are still to be received on % — receive that purchase order first (Purchase Orders → Receive); starting now would consume stock that has not arrived at the co-packer', v_wo.batch_code, v_unreceived;
    END IF;
$snip$;
BEGIN
  t := pg_get_functiondef('ops.fn_wo_advance__i'::regproc);
  ASSERT (length(t) - length(replace(t, a_decl, ''))) / length(a_decl) = 1, 'declare anchor must match exactly once';
  ASSERT (length(t) - length(replace(t, a_start, ''))) / length(a_start) = 1, 'start_production anchor must match exactly once';
  ASSERT position('20260911f' in t) = 0, 'already applied';
  t := replace(t, a_decl, s_decl);
  t := replace(t, a_start, a_start || s_guard);
  EXECUTE t;
  -- the guarded wrapper is untouched and still carries its guard
  ASSERT position('fn_assert_internal' in pg_get_functiondef('ops.fn_wo_advance'::regproc)) > 0, 'wrapper lost its guard';
  ASSERT position('20260911f' in pg_get_functiondef('ops.fn_wo_advance__i'::regproc)) > 0, 'guard did not land';
END $do$;
