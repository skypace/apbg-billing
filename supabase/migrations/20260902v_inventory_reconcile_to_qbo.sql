-- Inventory: the ledger says what QuickBooks says, and drift stops being silent.
--
-- WHAT WAS FOUND (2026-09-02)
-- The Refractor stock ledger had 49 movements, every one of them an
-- `adjustment`, every one dated 2026-05-14 -- a one-time opening seed. Zero
-- movements since, zero transfers ever, everything in BRIX-WAREHOUSE offset by
-- the adjustment counter. Meanwhile QuickBooks kept moving, so 31 of the 34
-- location-tracked items had drifted, 3,345 units in absolute terms:
-- Oaktown Root Beer cases read 1,198 here against 249 in QuickBooks.
--
-- Nothing fed it. The only writers are the production RPCs (never run for
-- real), the manual adjustment screen, and receiving a PO. It was seeded once
-- and left, and no screen said so.
--
-- ⚠ THE MACHINERY TO FIX IT ALREADY EXISTED AND WAS NEVER USED.
-- `ops.v_inventory_drift` and `ops.fn_reconcile_inventory_to_qbo` are live on
-- the database with NO migration file and NO caller anywhere in the repo --
-- they do not appear in app/src, netlify/ or supabase/. This migration writes
-- them down as they stand so the repo matches live and the next reader can
-- find them, then adds the bulk entry point the UI needs.
--
-- THE RULE, one sentence: QuickBooks owns HOW MANY we hold; this ledger owns
-- WHERE it is. So a reconcile brings the warehouse total back to QuickBooks and
-- leaves the split across locations alone.
--
-- ⚠ A reconcile CORRECTS, it never rewrites. Every fix is a new movement dated
-- today with its reason on it; the May seed stays in history. A ledger you can
-- edit is not a ledger.

-- ── 1. The drift view, as it stands live ────────────────────────────────────
-- Captured verbatim rather than improved. Two things about it are worth
-- knowing before anyone leans on it:
--   * `brix_qty` sums every location of kind 'warehouse', which today includes
--     CRAFT-COFFEE-SVCS, DESERT-BEVERAGE and ORIGINS-CRAFT-SODA -- third-party
--     sites, all empty. Consignment stock we still own arguably belongs in the
--     total, but note that DESERT-BEVERAGE/ORIGINS-CRAFT-SODA (kind
--     'warehouse') and DESERTBEV/ORIGINS (kind 'distributor') are the same two
--     partners entered twice under different kinds. Which pair is live is a
--     data question for an operator, not something to guess at here.
--   * co-packer and in-transit stock is deliberately NOT in `brix_qty`; it is
--     reported separately. That is what makes the guard in section 3 necessary.
CREATE OR REPLACE VIEW ops.v_inventory_drift AS
WITH brix AS (
  SELECT v.qbo_item_id,
         sum(CASE WHEN l.kind = 'warehouse'  THEN v.on_hand ELSE 0::numeric END) AS brix_warehouse_total,
         sum(CASE WHEN l.kind = 'in_transit' THEN v.on_hand ELSE 0::numeric END) AS brix_in_transit,
         sum(CASE WHEN l.kind = 'adjustment' THEN v.on_hand ELSE 0::numeric END) AS brix_adjustment_offset,
         sum(v.on_hand) AS brix_all_locations
    FROM ops.v_inventory_on_hand v
    JOIN ops.inventory_locations l ON l.id = v.location_id
   GROUP BY v.qbo_item_id
)
SELECT it.qbo_item_id,
       COALESCE(it.name, it.fully_qualified_name)                                   AS item_name,
       it.type                                                                      AS item_type,
       COALESCE(it.active, true)                                                    AS active,
       COALESCE(it.qty_on_hand, 0::numeric)                                         AS qbo_qty,
       COALESCE(b.brix_warehouse_total, 0::numeric)                                 AS brix_qty,
       COALESCE(b.brix_in_transit, 0::numeric)                                      AS brix_in_transit,
       COALESCE(b.brix_adjustment_offset, 0::numeric)                               AS brix_adjustment_offset,
       COALESCE(it.qty_on_hand, 0::numeric)
         - COALESCE(b.brix_warehouse_total, 0::numeric)                             AS drift,
       COALESCE(s.track_locations, false)                                           AS track_locations,
       COALESCE(s.is_managed, false)                                                AS is_managed,
       COALESCE(s.category_override, it.category_path, 'Uncategorized')             AS category_resolved
  FROM ops.qbo_items it
  LEFT JOIN brix b                    ON b.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.inventory_settings s  ON s.qbo_item_id = it.qbo_item_id
 WHERE COALESCE(it.active, true)
   AND COALESCE(it.type, '') <> ALL (ARRAY['Category', 'Group']);

GRANT SELECT ON ops.v_inventory_drift TO authenticated;

-- ── 2. When the ledger last actually moved ──────────────────────────────────
-- The defect was not the drift; it was that the drift was invisible. A number
-- with no date beside it cannot be judged, so the screen gets to say "last
-- movement 111 days ago" instead of implying it is current.
CREATE OR REPLACE VIEW ops.v_inventory_ledger_status AS
SELECT (SELECT count(*) FROM ops.inventory_movements)                                       AS movement_count,
       (SELECT max(occurred_at) FROM ops.inventory_movements)                               AS last_movement_at,
       (SELECT count(*) FROM ops.v_inventory_drift
         WHERE track_locations AND drift <> 0)                                              AS items_drifting,
       (SELECT COALESCE(sum(abs(drift)), 0) FROM ops.v_inventory_drift
         WHERE track_locations)                                                             AS abs_drift,
       (SELECT COALESCE(sum(v.on_hand), 0) FROM ops.v_inventory_on_hand v
          JOIN ops.inventory_locations l ON l.id = v.location_id
         WHERE l.kind IN ('co_packer', 'in_transit'))                                       AS qty_away_from_warehouse;

GRANT SELECT ON ops.v_inventory_ledger_status TO authenticated;

-- ── 3. Reconcile one item, as it stands live ────────────────────────────────
-- ⚠ 20260820b guard-wrapper rule: ops.fn_reconcile_inventory_to_qbo is a
-- WRAPPER that asserts ops.fn_assert_internal() and delegates here. Editing
-- this function is correct; CREATE OR REPLACE on the wrapper NAME would
-- overwrite the guard with the body and strand this inner. The wrapper is
-- minted below only if it does not already exist.
CREATE OR REPLACE FUNCTION ops.fn_reconcile_inventory_to_qbo__i(
  p_qbo_item_id       text,
  p_target_location_id uuid DEFAULT NULL,
  p_reason            text DEFAULT NULL
) RETURNS TABLE(qbo_item_id text, drift_resolved numeric, movement_id uuid, message text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $fn$
DECLARE
  v_drift  NUMERIC;
  v_target UUID := p_target_location_id;
  v_adj    UUID;
  v_actor  UUID := auth.uid();
  v_mv_id  UUID;
BEGIN
  IF p_qbo_item_id IS NULL OR p_qbo_item_id = '' THEN
    RAISE EXCEPTION 'qbo_item_id is required';
  END IF;

  SELECT drift INTO v_drift FROM ops.v_inventory_drift
   WHERE v_inventory_drift.qbo_item_id = p_qbo_item_id;
  IF v_drift IS NULL THEN
    RAISE EXCEPTION 'item not found in v_inventory_drift';
  END IF;
  IF v_drift = 0 THEN
    RETURN QUERY SELECT p_qbo_item_id, 0::numeric, NULL::uuid, 'no drift to reconcile';
    RETURN;
  END IF;

  SELECT id INTO v_adj FROM ops.inventory_locations WHERE kind = 'adjustment' AND is_active LIMIT 1;
  IF v_adj IS NULL THEN
    RAISE EXCEPTION 'no active adjustment location configured';
  END IF;

  IF v_target IS NULL THEN
    SELECT id INTO v_target FROM ops.inventory_locations
      WHERE kind = 'warehouse' AND is_active
      ORDER BY (code = 'BRIX-WAREHOUSE') DESC, name ASC LIMIT 1;
    IF v_target IS NULL THEN
      RAISE EXCEPTION 'no active warehouse to receive reconcile adjustment';
    END IF;
  END IF;

  IF v_drift > 0 THEN
    INSERT INTO ops.inventory_movements (
      movement_type, qbo_item_id, qty, from_location_id, to_location_id,
      unit_cost, source_doc_type, source_doc_id, occurred_at, created_by, notes
    ) VALUES (
      'adjustment', p_qbo_item_id, v_drift, v_adj, v_target,
      NULL, 'reconcile_qbo', NULL, now(), v_actor,
      COALESCE(p_reason, 'Reconcile to QBO · BRIX was short ' || v_drift)
    ) RETURNING id INTO v_mv_id;
  ELSE
    INSERT INTO ops.inventory_movements (
      movement_type, qbo_item_id, qty, from_location_id, to_location_id,
      unit_cost, source_doc_type, source_doc_id, occurred_at, created_by, notes
    ) VALUES (
      'adjustment', p_qbo_item_id, abs(v_drift), v_target, v_adj,
      NULL, 'reconcile_qbo', NULL, now(), v_actor,
      COALESCE(p_reason, 'Reconcile to QBO · BRIX was over by ' || abs(v_drift))
    ) RETURNING id INTO v_mv_id;
  END IF;

  RETURN QUERY SELECT p_qbo_item_id, v_drift, v_mv_id, 'reconciled';
END;
$fn$;

REVOKE EXECUTE ON FUNCTION ops.fn_reconcile_inventory_to_qbo__i(text, uuid, text) FROM PUBLIC, anon, authenticated;

DO $mint$
BEGIN
  IF to_regprocedure('ops.fn_reconcile_inventory_to_qbo(text, uuid, text)') IS NULL THEN
    EXECUTE $ddl$
      CREATE FUNCTION ops.fn_reconcile_inventory_to_qbo(
        p_qbo_item_id text, p_target_location_id uuid DEFAULT NULL, p_reason text DEFAULT NULL
      ) RETURNS TABLE(qbo_item_id text, drift_resolved numeric, movement_id uuid, message text)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
      AS $w$-- GENERATED GUARD WRAPPER (20260820b) — the real body lives in ops.fn_reconcile_inventory_to_qbo__i. Edit THAT.
      BEGIN PERFORM ops.fn_assert_internal(); RETURN QUERY SELECT * FROM ops.fn_reconcile_inventory_to_qbo__i($1, $2, $3); END$w$;
    $ddl$;
    EXECUTE 'GRANT EXECUTE ON FUNCTION ops.fn_reconcile_inventory_to_qbo(text, uuid, text) TO authenticated, service_role';
  END IF;
END
$mint$;

-- ── 4. Reconcile the whole ledger in one call ───────────────────────────────
-- The per-item function is the right unit for fixing one row from a grid; a
-- re-seed is 49 items and wants one round trip and one atomic write.
--
-- Population: everything marked track_locations, PLUS anything carrying a
-- ledger balance today even if it is no longer tracked. One rule -- the
-- warehouse total equals QuickBooks -- rather than a second special case for
-- "zero out the untracked ones", which is the kind of rule nobody remembers.
--
-- ⚠ IT REFUSES WHILE STOCK IS AWAY FROM THE WAREHOUSE, and this is the whole
-- reason the function is not a one-liner. The drift view measures QuickBooks
-- against WAREHOUSE-kind locations only; goods sitting at the co-packer or in
-- transit are counted separately and deliberately. So mid-run -- exactly when
-- a production batch is at Quantum or on a truck -- every one of those cases
-- reads as warehouse drift, and a reconcile would post adjustments inventing
-- stock we have not received yet, then the receipt would post it a second
-- time. A hard stop, not a warning: an amber notice on a screen that is about
-- to double-count a batch is one somebody clicks past.
CREATE OR REPLACE FUNCTION ops.fn_reconcile_inventory_bulk__i(
  p_reason text    DEFAULT NULL,
  p_commit boolean DEFAULT false
) RETURNS TABLE(qbo_item_id text, item_name text, qbo_qty numeric, brix_qty numeric, drift numeric, applied boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $fn$
DECLARE
  v_away   NUMERIC;
  v_reason TEXT := COALESCE(NULLIF(btrim(p_reason), ''), 'Re-seeded from QuickBooks');
  r        RECORD;
BEGIN
  SELECT COALESCE(sum(v.on_hand), 0) INTO v_away
    FROM ops.v_inventory_on_hand v
    JOIN ops.inventory_locations l ON l.id = v.location_id
   WHERE l.kind IN ('co_packer', 'in_transit');

  IF v_away <> 0 THEN
    RAISE EXCEPTION
      'refusing to reconcile: % unit(s) are at a co-packer or in transit. Receive or return them first — reconciling now would post warehouse stock for goods we have not received, and the receipt would post it again.',
      v_away;
  END IF;

  FOR r IN
    SELECT d.qbo_item_id, d.item_name, d.qbo_qty, d.brix_qty, d.drift
      FROM ops.v_inventory_drift d
     WHERE (d.track_locations OR d.brix_qty <> 0)
       AND d.drift <> 0
     ORDER BY d.item_name
  LOOP
    IF p_commit THEN
      PERFORM ops.fn_reconcile_inventory_to_qbo__i(
        r.qbo_item_id, NULL,
        v_reason || ' · was ' || r.brix_qty || ', QuickBooks says ' || r.qbo_qty
      );
    END IF;
    qbo_item_id := r.qbo_item_id; item_name := r.item_name;
    qbo_qty := r.qbo_qty; brix_qty := r.brix_qty; drift := r.drift; applied := p_commit;
    RETURN NEXT;
  END LOOP;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION ops.fn_reconcile_inventory_bulk__i(text, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_reconcile_inventory_bulk(
  p_reason text DEFAULT NULL, p_commit boolean DEFAULT false
) RETURNS TABLE(qbo_item_id text, item_name text, qbo_qty numeric, brix_qty numeric, drift numeric, applied boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'ops', 'pg_temp'
AS $w$-- GENERATED GUARD WRAPPER (20260820b) — the real body lives in ops.fn_reconcile_inventory_bulk__i. Edit THAT.
BEGIN PERFORM ops.fn_assert_internal(); RETURN QUERY SELECT * FROM ops.fn_reconcile_inventory_bulk__i($1, $2); END$w$;

REVOKE EXECUTE ON FUNCTION ops.fn_reconcile_inventory_bulk(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_reconcile_inventory_bulk(text, boolean) TO authenticated, service_role;
