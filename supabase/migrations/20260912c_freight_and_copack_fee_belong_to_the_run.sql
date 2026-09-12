-- 20260912c · freight and the co-pack fee belong to the RUN, shared across its flavours
--
-- From the production team's test notes (Calli, 2026-09-11):
--   "With work orders being by SKU line item instead of by canning run (where
--    2-5 SKUs are listed), it is weird to add Freight in the yield section as it
--    would add it solely for one SKU vs the whole run. If I were to add freight
--    on yield for WO-2026-00022 it'd appear as if the ~$2500 in freight was
--    solely attached to Cola vs also including the diet cola that was on the
--    same truck."
-- Sky (2026-09-12): "then lets work 1-5" — item 5 being exactly this.
--
-- She is right, and the model already says so: a production order is ONE truck
-- (fn_run_ship builds one BOL for every flavour on it), so the freight for that
-- truck and Quantum's run-level fee are costs of the ORDER. Until now the only
-- place to type them was RecordYieldDialog, per flavour, so a two-flavour load
-- charged whichever flavour was yielded first.
--
-- What changes:
--   • production_runs gains freight_cost / copack_fee / other_landed_cost (+ a
--     note and who/when), typed once on the order — at ship time or any time
--     before it closes.
--   • ops.fn_run_landed_shares__i(run) splits each amount across the order's
--     non-void flavours BY PLANNED CASES (qty_to_produce). ⚠ Planned, not
--     produced, deliberately: yields land one flavour at a time over days, and
--     a share that moved every time another flavour's yield came in would make
--     a cost that was already locked on the first flavour wrong again. The
--     LAST flavour (by created_at) absorbs the rounding remainder, so the
--     shares add back to the typed total to the cent.
--   • Each flavour's cost row carries its share as landed_cost detail lines
--     tagged source='run' — beside, never instead of, anything typed on the
--     flavour itself. fn_wo_recost_run_landed__i(wo) REPLACES those lines and
--     re-derives total / unit / per-case / per-can / per-oz / per-gal /
--     yield-loss from the delta, so re-saving the run's costs is idempotent and
--     a flavour's own typed freight (a standalone work order, or a one-off)
--     survives untouched.
--   • record_yield (fn_wo_advance__i) adds the run share at the moment the
--     cost row is first built, so a flavour yielded AFTER the costs were typed
--     is right from its first read — anchored read-modify-write of the LIVE
--     inner, the 20260820b rule.
--   • fn_run_set_landed_costs(run, freight, copack, other, note) is the door:
--     refused on a void order or a negative amount; it re-costs every flavour
--     that already has a cost row and reports the ones that will pick their
--     share up at yield.
--
-- ⚠ Adding or removing a flavour after the costs are typed changes every share.
-- fn_run_add_line / fn_run_remove_line do not re-cost (they run before any
-- yield exists, so there is nothing to re-cost yet); a rescale of a flavour on
-- an order that has landed costs DOES re-share (20260912d). The run detail
-- prints the basis and the shares so the arithmetic is on screen.

-- 1 ── columns -----------------------------------------------------------------
ALTER TABLE ops.production_runs
  ADD COLUMN IF NOT EXISTS freight_cost        numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS copack_fee          numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_landed_cost   numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS landed_costs_note   text,
  ADD COLUMN IF NOT EXISTS landed_costs_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS landed_costs_set_by uuid;

COMMENT ON COLUMN ops.production_runs.freight_cost IS '20260912c: freight for the truck — a cost of the ORDER, shared across its flavours by planned cases (fn_run_landed_shares__i). Set through fn_run_set_landed_costs.';
COMMENT ON COLUMN ops.production_runs.copack_fee   IS '20260912c: the co-packer''s run-level fee, shared across flavours by planned cases.';

-- 2 ── the shares ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.fn_run_landed_shares__i(p_run_id uuid)
RETURNS TABLE(wo_id uuid, batch_code text, cases numeric, share_pct numeric, freight numeric, copack_fee numeric, other numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $$
  WITH r AS (SELECT id, freight_cost, copack_fee, other_landed_cost FROM ops.production_runs WHERE id = p_run_id),
  w AS (
    SELECT w.id, w.batch_code, w.qty_to_produce,
           row_number() OVER (ORDER BY w.created_at DESC, w.id DESC) AS rn_last,
           sum(w.qty_to_produce) OVER () AS total
      FROM ops.work_orders w
     WHERE w.run_id = p_run_id AND w.status <> 'void'
  ),
  s AS (
    SELECT w.id, w.batch_code, w.qty_to_produce, w.rn_last,
           CASE WHEN w.total > 0 THEN w.qty_to_produce / w.total ELSE 0 END AS pct,
           r.freight_cost, r.copack_fee, r.other_landed_cost,
           round(r.freight_cost      * CASE WHEN w.total > 0 THEN w.qty_to_produce / w.total ELSE 0 END, 2) AS f_r,
           round(r.copack_fee        * CASE WHEN w.total > 0 THEN w.qty_to_produce / w.total ELSE 0 END, 2) AS c_r,
           round(r.other_landed_cost * CASE WHEN w.total > 0 THEN w.qty_to_produce / w.total ELSE 0 END, 2) AS o_r
      FROM w CROSS JOIN r
  ),
  t AS (SELECT sum(f_r) AS f_sum, sum(c_r) AS c_sum, sum(o_r) AS o_sum FROM s)
  SELECT s.id, s.batch_code, s.qty_to_produce, round(s.pct * 100, 2),
         CASE WHEN s.rn_last = 1 THEN s.freight_cost      - (t.f_sum - s.f_r) ELSE s.f_r END,
         CASE WHEN s.rn_last = 1 THEN s.copack_fee        - (t.c_sum - s.c_r) ELSE s.c_r END,
         CASE WHEN s.rn_last = 1 THEN s.other_landed_cost - (t.o_sum - s.o_r) ELSE s.o_r END
    FROM s CROSS JOIN t
   ORDER BY s.batch_code;
$$;
REVOKE ALL ON FUNCTION ops.fn_run_landed_shares__i(uuid) FROM PUBLIC, anon, authenticated;

-- 3 ── re-cost one flavour from its share ------------------------------------------
CREATE OR REPLACE FUNCTION ops.fn_wo_recost_run_landed__i(p_wo_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $$
DECLARE
  v_c   ops.work_order_costs%ROWTYPE;
  v_wo  ops.work_orders%ROWTYPE;
  v_bom ops.product_bom%ROWTYPE;
  v_sh  record;
  v_old numeric := 0; v_new numeric := 0;
  v_keep jsonb; v_add jsonb := '[]'::jsonb;
  v_total numeric; v_unit numeric;
BEGIN
  SELECT * INTO v_c FROM ops.work_order_costs WHERE wo_id = p_wo_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('wo_id', p_wo_id, 'recosted', false, 'reason', 'no cost row yet — the share lands at record_yield'); END IF;
  SELECT * INTO v_wo FROM ops.work_orders WHERE id = p_wo_id;
  IF v_wo.run_id IS NULL THEN RETURN jsonb_build_object('wo_id', p_wo_id, 'recosted', false, 'reason', 'not on a production order'); END IF;
  SELECT * INTO v_bom FROM ops.product_bom WHERE id = v_wo.bom_id;

  SELECT COALESCE(sum((d->>'extended_cost')::numeric), 0) INTO v_old
    FROM jsonb_array_elements(COALESCE(v_c.detail, '[]'::jsonb)) d WHERE d->>'source' = 'run';
  SELECT COALESCE(jsonb_agg(d), '[]'::jsonb) INTO v_keep
    FROM jsonb_array_elements(COALESCE(v_c.detail, '[]'::jsonb)) d WHERE COALESCE(d->>'source', '') <> 'run';

  SELECT * INTO v_sh FROM ops.fn_run_landed_shares__i(v_wo.run_id) s WHERE s.wo_id = p_wo_id;
  IF FOUND THEN
    IF COALESCE(v_sh.freight, 0) <> 0 THEN
      v_add := v_add || jsonb_build_object('kind','landed_cost','source','run','label','Freight — share of the run (' || v_sh.share_pct || '% by cases)','qty',1,'unit_cost',v_sh.freight,'extended_cost',v_sh.freight,'notes',NULL);
      v_new := v_new + v_sh.freight;
    END IF;
    IF COALESCE(v_sh.copack_fee, 0) <> 0 THEN
      v_add := v_add || jsonb_build_object('kind','landed_cost','source','run','label','Co-pack fee — share of the run (' || v_sh.share_pct || '% by cases)','qty',1,'unit_cost',v_sh.copack_fee,'extended_cost',v_sh.copack_fee,'notes',NULL);
      v_new := v_new + v_sh.copack_fee;
    END IF;
    IF COALESCE(v_sh.other, 0) <> 0 THEN
      v_add := v_add || jsonb_build_object('kind','landed_cost','source','run','label','Other landed cost — share of the run (' || v_sh.share_pct || '% by cases)','qty',1,'unit_cost',v_sh.other,'extended_cost',v_sh.other,'notes',NULL);
      v_new := v_new + v_sh.other;
    END IF;
  END IF;

  v_total := v_c.total_cost - v_old + v_new;
  v_unit  := CASE WHEN COALESCE(v_c.qty_produced, 0) > 0 THEN v_total / v_c.qty_produced ELSE NULL END;

  UPDATE ops.work_order_costs SET
    services_cost = services_cost - v_old + v_new,     -- the column that has carried services + fees since 20260721a
    total_cost    = v_total,
    unit_cost     = v_unit,
    per_case      = CASE WHEN COALESCE(v_bom.cans_per_case,0) > 0 AND COALESCE(v_bom.oz_per_can,0) > 0 THEN v_unit ELSE per_case END,
    per_can       = CASE WHEN COALESCE(v_bom.cans_per_case,0) > 0 AND COALESCE(v_bom.oz_per_can,0) > 0 THEN v_unit / v_bom.cans_per_case ELSE per_can END,
    per_oz        = CASE WHEN COALESCE(v_bom.cans_per_case,0) > 0 AND COALESCE(v_bom.oz_per_can,0) > 0 THEN v_unit / v_bom.cans_per_case / v_bom.oz_per_can ELSE per_oz END,
    per_gal_finished = CASE WHEN COALESCE(v_bom.cans_per_case,0) > 0 AND COALESCE(v_bom.oz_per_can,0) > 0 AND COALESCE(v_c.qty_produced,0) > 0
                            THEN v_total / (v_c.qty_produced * v_bom.cans_per_case * v_bom.oz_per_can / 128.0) ELSE per_gal_finished END,
    yield_loss_dollars = CASE WHEN COALESCE(v_wo.expected_units,0) > COALESCE(v_c.qty_produced,0) THEN (v_wo.expected_units - v_c.qty_produced) * v_unit ELSE yield_loss_dollars END,
    detail        = v_keep || v_add,
    computed_at   = now()
  WHERE wo_id = p_wo_id;

  RETURN jsonb_build_object('wo_id', p_wo_id, 'batch_code', v_wo.batch_code, 'recosted', true, 'run_share_before', v_old, 'run_share_after', v_new, 'total_cost', v_total);
END $$;
REVOKE ALL ON FUNCTION ops.fn_wo_recost_run_landed__i(uuid) FROM PUBLIC, anon, authenticated;

-- 4 ── every flavour on the run --------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.fn_run_recost_landed__i(p_run_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $$
DECLARE v_out jsonb := '[]'::jsonb; v_w record;
BEGIN
  FOR v_w IN SELECT id FROM ops.work_orders WHERE run_id = p_run_id AND status <> 'void' ORDER BY created_at LOOP
    v_out := v_out || ops.fn_wo_recost_run_landed__i(v_w.id);
  END LOOP;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION ops.fn_run_recost_landed__i(uuid) FROM PUBLIC, anon, authenticated;

-- 5 ── the door -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.fn_run_set_landed_costs(p_run_id uuid, p_freight numeric, p_copack_fee numeric, p_other numeric DEFAULT 0, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $$
DECLARE r ops.production_runs%ROWTYPE; v_actor uuid := auth.uid(); v_recost jsonb; v_shares jsonb; v_pending text;
BEGIN
  PERFORM ops.fn_assert_internal();
  SELECT * INTO r FROM ops.production_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'production order not found'; END IF;
  IF r.status = 'void' THEN RAISE EXCEPTION '% is void — nothing to cost', r.run_number; END IF;
  IF COALESCE(p_freight,0) < 0 OR COALESCE(p_copack_fee,0) < 0 OR COALESCE(p_other,0) < 0 THEN
    RAISE EXCEPTION 'a landed cost cannot be negative';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ops.work_orders WHERE run_id = p_run_id AND status <> 'void') THEN
    RAISE EXCEPTION '% has no flavours to share a cost across', r.run_number;
  END IF;

  UPDATE ops.production_runs
     SET freight_cost = COALESCE(p_freight, 0), copack_fee = COALESCE(p_copack_fee, 0), other_landed_cost = COALESCE(p_other, 0),
         landed_costs_note = NULLIF(trim(p_note), ''), landed_costs_set_at = now(), landed_costs_set_by = v_actor, updated_at = now()
   WHERE id = p_run_id;

  v_recost := ops.fn_run_recost_landed__i(p_run_id);
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.batch_code), '[]'::jsonb) INTO v_shares FROM ops.fn_run_landed_shares__i(p_run_id) s;
  SELECT string_agg(w.batch_code, ', ' ORDER BY w.batch_code) INTO v_pending
    FROM ops.work_orders w WHERE w.run_id = p_run_id AND w.status <> 'void' AND NOT EXISTS (SELECT 1 FROM ops.work_order_costs c WHERE c.wo_id = w.id);

  INSERT INTO ops.production_doc_events (doc_type, doc_id, event_type, note, payload, created_by)
  VALUES ('run', p_run_id, 'landed_costs',
          format('Landed costs set: freight %s · co-pack fee %s · other %s%s', COALESCE(p_freight,0), COALESCE(p_copack_fee,0), COALESCE(p_other,0),
                 CASE WHEN NULLIF(trim(p_note),'') IS NOT NULL THEN ' — ' || p_note ELSE '' END),
          jsonb_build_object('freight', p_freight, 'copack_fee', p_copack_fee, 'other', p_other, 'shares', v_shares), v_actor);

  RETURN jsonb_build_object('run_number', r.run_number, 'shares', v_shares, 'recosted', v_recost,
                            'pending_yield', COALESCE(v_pending, ''),
                            'basis', 'planned cases (qty_to_produce) across every non-void flavour; the last flavour absorbs the rounding remainder');
END $$;
COMMENT ON FUNCTION ops.fn_run_set_landed_costs(uuid, numeric, numeric, numeric, text) IS
  '20260912c: freight / co-pack fee / other on the production ORDER, shared across its flavours by planned cases and written into each flavour''s cost row as source=run landed_cost lines (replaced on every call). Internal-role guard inline.';
REVOKE ALL ON FUNCTION ops.fn_run_set_landed_costs(uuid, numeric, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_run_set_landed_costs(uuid, numeric, numeric, numeric, text) TO authenticated, service_role;

-- 6 ── record_yield picks the share up when the cost row is first built ----------------------
DO $mig$
DECLARE
  v_def TEXT; n INT;
  a_decl TEXT := E'  v_unreceived       TEXT;                  -- 20260911f\nBEGIN';
  s_decl TEXT := E'  v_unreceived       TEXT;                  -- 20260911f\n  v_run_sh           RECORD;                -- 20260912c\nBEGIN';
  a_other TEXT := E'      v_detail := v_detail || jsonb_build_object(''kind'',''landed_cost'',''label'',''Other landed cost'',''qty'',1,''unit_cost'',v_other,''extended_cost'',v_other,''notes'',NULL);\n    END IF;\n';
  s_other TEXT := E'      v_detail := v_detail || jsonb_build_object(''kind'',''landed_cost'',''label'',''Other landed cost'',''qty'',1,''unit_cost'',v_other,''extended_cost'',v_other,''notes'',NULL);\n    END IF;\n'
    || E'    -- 20260912c: the production order''s freight / co-pack fee / other, this flavour''s share by planned cases\n'
    || E'    IF v_wo.run_id IS NOT NULL THEN\n'
    || E'      SELECT * INTO v_run_sh FROM ops.fn_run_landed_shares__i(v_wo.run_id) s WHERE s.wo_id = p_wo_id;\n'
    || E'      IF FOUND THEN\n'
    || E'        IF COALESCE(v_run_sh.freight, 0) <> 0 THEN\n'
    || E'          v_fees_cost := v_fees_cost + v_run_sh.freight;\n'
    || E'          v_detail := v_detail || jsonb_build_object(''kind'',''landed_cost'',''source'',''run'',''label'',''Freight — share of the run ('' || v_run_sh.share_pct || ''% by cases)'',''qty'',1,''unit_cost'',v_run_sh.freight,''extended_cost'',v_run_sh.freight,''notes'',NULL);\n'
    || E'        END IF;\n'
    || E'        IF COALESCE(v_run_sh.copack_fee, 0) <> 0 THEN\n'
    || E'          v_fees_cost := v_fees_cost + v_run_sh.copack_fee;\n'
    || E'          v_detail := v_detail || jsonb_build_object(''kind'',''landed_cost'',''source'',''run'',''label'',''Co-pack fee — share of the run ('' || v_run_sh.share_pct || ''% by cases)'',''qty'',1,''unit_cost'',v_run_sh.copack_fee,''extended_cost'',v_run_sh.copack_fee,''notes'',NULL);\n'
    || E'        END IF;\n'
    || E'        IF COALESCE(v_run_sh.other, 0) <> 0 THEN\n'
    || E'          v_fees_cost := v_fees_cost + v_run_sh.other;\n'
    || E'          v_detail := v_detail || jsonb_build_object(''kind'',''landed_cost'',''source'',''run'',''label'',''Other landed cost — share of the run ('' || v_run_sh.share_pct || ''% by cases)'',''qty'',1,''unit_cost'',v_run_sh.other,''extended_cost'',v_run_sh.other,''notes'',NULL);\n'
    || E'        END IF;\n'
    || E'      END IF;\n'
    || E'    END IF;\n';
BEGIN
  SELECT pg_get_functiondef('ops.fn_wo_advance__i'::regproc) INTO v_def;
  n := (length(v_def) - length(replace(v_def, a_decl, ''))) / length(a_decl);
  IF n <> 1 THEN RAISE EXCEPTION '20260912c: declare anchor found % times in fn_wo_advance__i', n; END IF;
  n := (length(v_def) - length(replace(v_def, a_other, ''))) / length(a_other);
  IF n <> 1 THEN RAISE EXCEPTION '20260912c: other-landed-cost anchor found % times in fn_wo_advance__i', n; END IF;
  IF pg_get_functiondef('ops.fn_wo_advance'::regproc) NOT LIKE '%fn_assert_internal%' THEN
    RAISE EXCEPTION '20260912c: ops.fn_wo_advance wrapper no longer carries fn_assert_internal — stop';
  END IF;
  v_def := replace(v_def, a_decl, s_decl);
  v_def := replace(v_def, a_other, s_other);
  EXECUTE v_def;
  SELECT pg_get_functiondef('ops.fn_wo_advance__i'::regproc) INTO v_def;
  IF v_def NOT LIKE '%fn_run_landed_shares__i(v_wo.run_id)%' THEN RAISE EXCEPTION '20260912c: run-share block not present after apply'; END IF;
  -- reachability: the share block must sit BEFORE the royalty/total lines that consume v_fees_cost
  IF position('fn_run_landed_shares__i(v_wo.run_id)' in v_def) > position('v_total_cost := v_components_cost + v_services_cost + v_fees_cost;' in v_def) THEN
    RAISE EXCEPTION '20260912c: run-share block landed AFTER the total — unreachable for the cost';
  END IF;
END
$mig$;

-- 7 ── the view carries the run's landed costs (appended at the END — CREATE OR REPLACE VIEW cannot insert mid-list) ----
CREATE OR REPLACE VIEW ops.v_production_runs AS
 SELECT r.id, r.run_number, r.status, r.copacker_qbo_vendor_id, r.copacker_location_id, r.destination_location_id,
    r.scheduled_date, r.tank_size_gal, r.net_against_stock, r.notes, r.ordered_at, r.started_at, r.shipped_at, r.closed_at, r.closed_by,
    r.voided_at, r.voided_by, r.void_reason, r.reopened_at, r.reopened_by, r.reopen_reason, r.created_by, r.created_at, r.updated_at,
    v.display_name AS copacker_vendor_name,
    (cl.code || ' · '::text) || cl.name AS copacker_location_label,
    (dl.code || ' · '::text) || dl.name AS destination_location_label,
    ops.fn_status_bucket('run'::text, r.status) AS bucket,
    COALESCE(w.wo_count, 0) AS wo_count, COALESCE(w.wo_live_count, 0) AS wo_live_count,
    COALESCE(w.cases_planned, 0::numeric) AS cases_planned, w.cases_produced, w.flavours, w.stages,
    COALESCE(p.po_count, 0) AS po_count, COALESCE(p.po_open_count, 0) AS po_open_count, COALESCE(p.po_total, 0::numeric) AS po_total,
    w.total_cost, COALESCE(rs.reserved_lines, 0) AS reserved_lines,
    r.freight_cost, r.copack_fee, r.other_landed_cost, r.landed_costs_note, r.landed_costs_set_at
   FROM ops.production_runs r
     LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = r.copacker_qbo_vendor_id
     LEFT JOIN ops.inventory_locations cl ON cl.id = r.copacker_location_id
     LEFT JOIN ops.inventory_locations dl ON dl.id = r.destination_location_id
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS wo_count,
            count(*) FILTER (WHERE w_1.status <> 'void'::text)::integer AS wo_live_count,
            sum(w_1.qty_to_produce) FILTER (WHERE w_1.status <> 'void'::text) AS cases_planned,
            sum(w_1.qty_produced_actual) FILTER (WHERE w_1.status <> 'void'::text) AS cases_produced,
            string_agg(DISTINCT b.name, ', '::text ORDER BY b.name) FILTER (WHERE w_1.status <> 'void'::text) AS flavours,
            string_agg(DISTINCT w_1.status, ', '::text) FILTER (WHERE w_1.status <> 'void'::text) AS stages,
            sum(c.total_cost) AS total_cost
           FROM ops.work_orders w_1
             LEFT JOIN ops.product_bom b ON b.id = w_1.bom_id
             LEFT JOIN ops.work_order_costs c ON c.wo_id = w_1.id
          WHERE w_1.run_id = r.id) w ON true
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS po_count,
            count(*) FILTER (WHERE p_1.status = ANY (ARRAY['open'::text, 'partial'::text]))::integer AS po_open_count,
            sum(p_1.subtotal) FILTER (WHERE p_1.status <> 'void'::text) AS po_total
           FROM ops.purchase_orders p_1
          WHERE p_1.production_run_id = r.id) p ON true
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS reserved_lines
           FROM ops.inventory_reservations x
          WHERE x.run_id = r.id AND x.status = 'active'::text) rs ON true;
