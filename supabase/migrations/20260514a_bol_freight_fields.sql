-- ============================================================================
-- Freight-ready BOL: per-item dimensions + per-transfer freight + signatures
--
-- 1. Per-item freight metadata on ops.inventory_settings
--      weight_per_unit_lbs  — weight of one stocking unit
--      units_per_pallet     — typical pallet quantity
--      freight_class        — LTL NMFC class (free text; UI offers std values)
--
-- 2. Per-transfer freight header on ops.inventory_transfers
--      pro_number              — carrier's PRO (separate from tracking #)
--      freight_terms           — 'prepaid' | 'collect' | 'third_party'
--      total_weight_lbs        — operator-confirmed; UI auto-suggests from lines
--      total_pallets           — operator-confirmed; UI auto-suggests from lines
--      declared_value_usd      — auto-suggest sum(qty * unit_cost), editable
--      special_instructions    — handling notes
--      shipper_signature_name  — typed name, captured at Mark Shipped
--      shipper_signature_at    — timestamp captured at Mark Shipped
--      receiver_signature_name — typed name, captured at Mark Received
--      receiver_signature_at   — timestamp captured at Mark Received
--
-- 3. Per-line freight overrides on ops.inventory_transfer_lines
--      line_weight_lbs   — optional override; null = compute from item default
--      line_pallets      — optional override
--
-- 4. RPC updates
--      fn_set_inventory_settings — 14 args (add weight/pallet/class)
--      fn_items_master           — return weight/pallet/class + on_hand at each
--      fn_create_transfer        — accept freight header
--      fn_update_transfer_freight — header edits before ship
--      fn_ship_transfer          — accept shipper signature name
--      fn_receive_transfer       — accept receiver signature name
-- ============================================================================

-- ── 1. inventory_settings columns ──────────────────────────────────────────
ALTER TABLE ops.inventory_settings
  ADD COLUMN IF NOT EXISTS weight_per_unit_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS units_per_pallet    NUMERIC,
  ADD COLUMN IF NOT EXISTS freight_class       TEXT;

-- ── 2. inventory_transfers freight columns ─────────────────────────────────
ALTER TABLE ops.inventory_transfers
  ADD COLUMN IF NOT EXISTS pro_number              TEXT,
  ADD COLUMN IF NOT EXISTS freight_terms           TEXT
    CHECK (freight_terms IS NULL OR freight_terms IN ('prepaid','collect','third_party')),
  ADD COLUMN IF NOT EXISTS total_weight_lbs        NUMERIC,
  ADD COLUMN IF NOT EXISTS total_pallets           NUMERIC,
  ADD COLUMN IF NOT EXISTS declared_value_usd      NUMERIC,
  ADD COLUMN IF NOT EXISTS special_instructions    TEXT,
  ADD COLUMN IF NOT EXISTS shipper_signature_name  TEXT,
  ADD COLUMN IF NOT EXISTS shipper_signature_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS receiver_signature_name TEXT,
  ADD COLUMN IF NOT EXISTS receiver_signature_at   TIMESTAMPTZ;

-- ── 3. inventory_transfer_lines overrides ──────────────────────────────────
ALTER TABLE ops.inventory_transfer_lines
  ADD COLUMN IF NOT EXISTS line_weight_lbs NUMERIC,
  ADD COLUMN IF NOT EXISTS line_pallets    NUMERIC;


-- ── 4. fn_set_inventory_settings — canonical 14-arg ────────────────────────
DO $$
DECLARE rec RECORD;
BEGIN
  FOR rec IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ops' AND p.proname = 'fn_set_inventory_settings'
  LOOP
    EXECUTE 'DROP FUNCTION ' || rec.sig::text;
  END LOOP;
END $$;

CREATE FUNCTION ops.fn_set_inventory_settings(
  p_qbo_item_id        TEXT,
  p_is_managed         BOOLEAN DEFAULT NULL,
  p_target_days_supply INTEGER DEFAULT NULL,
  p_lead_time_days     INTEGER DEFAULT NULL,
  p_reorder_point      NUMERIC DEFAULT NULL,
  p_min_order_qty      NUMERIC DEFAULT NULL,
  p_notes              TEXT    DEFAULT NULL,
  p_category_override  TEXT    DEFAULT NULL,
  p_is_planner         BOOLEAN DEFAULT NULL,
  p_track_locations    BOOLEAN DEFAULT NULL,
  p_has_bom            BOOLEAN DEFAULT NULL,
  p_weight_per_unit_lbs NUMERIC DEFAULT NULL,
  p_units_per_pallet    NUMERIC DEFAULT NULL,
  p_freight_class       TEXT    DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ops, public AS $func$
BEGIN
  INSERT INTO ops.inventory_settings (
    qbo_item_id, is_managed, target_days_supply, lead_time_days,
    reorder_point, min_order_qty, notes, category_override, is_planner,
    track_locations, has_bom,
    weight_per_unit_lbs, units_per_pallet, freight_class,
    updated_at
  )
  VALUES (
    p_qbo_item_id,
    COALESCE(p_is_managed, false),
    COALESCE(p_target_days_supply, 30),
    COALESCE(p_lead_time_days, 7),
    p_reorder_point, p_min_order_qty, p_notes, p_category_override,
    COALESCE(p_is_planner, false),
    COALESCE(p_track_locations, false),
    COALESCE(p_has_bom, false),
    p_weight_per_unit_lbs, p_units_per_pallet, p_freight_class,
    NOW()
  )
  ON CONFLICT (qbo_item_id) DO UPDATE SET
    is_managed         = COALESCE(EXCLUDED.is_managed,         ops.inventory_settings.is_managed),
    target_days_supply = COALESCE(EXCLUDED.target_days_supply, ops.inventory_settings.target_days_supply),
    lead_time_days     = COALESCE(EXCLUDED.lead_time_days,     ops.inventory_settings.lead_time_days),
    reorder_point      = COALESCE(EXCLUDED.reorder_point,      ops.inventory_settings.reorder_point),
    min_order_qty      = COALESCE(EXCLUDED.min_order_qty,      ops.inventory_settings.min_order_qty),
    notes              = COALESCE(EXCLUDED.notes,              ops.inventory_settings.notes),
    category_override  = COALESCE(EXCLUDED.category_override,  ops.inventory_settings.category_override),
    is_planner         = COALESCE(EXCLUDED.is_planner,         ops.inventory_settings.is_planner),
    track_locations    = COALESCE(EXCLUDED.track_locations,    ops.inventory_settings.track_locations),
    has_bom            = COALESCE(EXCLUDED.has_bom,            ops.inventory_settings.has_bom),
    weight_per_unit_lbs= COALESCE(EXCLUDED.weight_per_unit_lbs, ops.inventory_settings.weight_per_unit_lbs),
    units_per_pallet   = COALESCE(EXCLUDED.units_per_pallet,    ops.inventory_settings.units_per_pallet),
    freight_class      = COALESCE(EXCLUDED.freight_class,       ops.inventory_settings.freight_class),
    updated_at         = NOW();
END;
$func$;

GRANT EXECUTE ON FUNCTION ops.fn_set_inventory_settings(
  TEXT, BOOLEAN, INTEGER, INTEGER, NUMERIC, NUMERIC, TEXT, TEXT,
  BOOLEAN, BOOLEAN, BOOLEAN, NUMERIC, NUMERIC, TEXT
) TO authenticated;


-- ── 5. fn_items_master — return freight columns ────────────────────────────
DROP FUNCTION IF EXISTS ops.fn_items_master(integer, text, boolean);

CREATE FUNCTION ops.fn_items_master(
  p_lookback_days integer DEFAULT 90,
  p_search        text    DEFAULT NULL,
  p_managed_only  boolean DEFAULT false
)
RETURNS TABLE(
  qbo_item_id text, item_name text, fully_qualified_name text, active boolean,
  category_path text, category_override text, category_resolved text,
  income_account_name text, expense_account_name text,
  on_hand numeric, unit_price numeric, purchase_cost numeric,
  is_managed boolean, is_planner boolean,
  target_days_supply integer, lead_time_days integer,
  reorder_point numeric, min_order_qty numeric, notes text,
  sold_qty numeric, sold_revenue numeric, customers_count integer,
  daily_velocity numeric, days_of_supply numeric, status text,
  product_family_code text, product_family_label text,
  product_type_code   text, product_type_label   text,
  track_locations boolean, has_bom boolean,
  weight_per_unit_lbs numeric, units_per_pallet numeric, freight_class text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $function$
  WITH start_date AS (SELECT (current_date - p_lookback_days)::date AS d),
  excludes AS (SELECT qbo_customer_id FROM ops.inventory_velocity_excludes),
  sold AS (
    SELECT v.item_ref_id AS qbo_item_id,
      sum(v.quantity)::numeric AS qty,
      sum(v.revenue)::numeric AS revenue,
      count(DISTINCT v.customer_ref_id)::int AS customers_count
    FROM ops.v_sales_lines v
    LEFT JOIN excludes e ON e.qbo_customer_id = v.customer_ref_id
    WHERE v.txn_date >= (SELECT d FROM start_date)
      AND e.qbo_customer_id IS NULL
      AND v.item_ref_id IS NOT NULL
      AND v.quantity IS NOT NULL AND v.quantity > 0
    GROUP BY 1
  ),
  adj AS (
    SELECT a.item_ref_id AS qbo_item_id,
      sum(CASE WHEN a.qty_diff < 0 THEN ABS(a.qty_diff) ELSE 0 END)::numeric AS shrink_qty
    FROM ops.qbo_inventory_adjustment_lines a
    WHERE a.item_ref_id IS NOT NULL
      AND a.txn_date >= (SELECT d FROM start_date)
    GROUP BY 1
  )
  SELECT
    it.qbo_item_id,
    COALESCE(it.name, it.fully_qualified_name),
    it.fully_qualified_name,
    COALESCE(it.active, true)::boolean,
    it.category_path,
    s.category_override,
    COALESCE(s.category_override, it.category_path, 'Uncategorized'),
    it.income_account_name,
    it.expense_account_name,
    COALESCE(it.qty_on_hand, 0)::numeric,
    it.unit_price,
    it.purchase_cost,
    COALESCE(s.is_managed, false),
    COALESCE(s.is_planner, false),
    COALESCE(s.target_days_supply, 30),
    COALESCE(s.lead_time_days, 7),
    s.reorder_point,
    s.min_order_qty,
    s.notes,
    COALESCE(sold.qty, 0),
    COALESCE(sold.revenue, 0),
    COALESCE(sold.customers_count, 0),
    ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1))::numeric,
    CASE WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) > 0
         THEN COALESCE(it.qty_on_hand, 0) / ((COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1))
         ELSE NULL END,
    CASE
      WHEN COALESCE(it.active, true) = false THEN 'inactive'
      WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) = 0 AND COALESCE(it.qty_on_hand, 0) > 0 THEN 'idle'
      WHEN (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) = 0 AND COALESCE(it.qty_on_hand, 0) = 0 THEN 'idle'
      WHEN COALESCE(it.qty_on_hand, 0) <= 0 THEN 'critical'
      WHEN COALESCE(it.qty_on_hand, 0) <
           COALESCE(s.lead_time_days, 7) * (COALESCE(sold.qty, 0) + COALESCE(adj.shrink_qty, 0)) / GREATEST(p_lookback_days, 1) THEN 'reorder'
      ELSE 'ok'
    END,
    ipf.family_code, pf.label,
    ipt.type_code,   pt.label,
    COALESCE(s.track_locations, false),
    COALESCE(s.has_bom, false),
    s.weight_per_unit_lbs,
    s.units_per_pallet,
    s.freight_class
  FROM ops.qbo_items it
  LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
  LEFT JOIN sold ON sold.qbo_item_id = it.qbo_item_id
  LEFT JOIN adj  ON adj.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_families pf       ON pf.family_code  = ipf.family_code AND pf.is_active
  LEFT JOIN ops.item_product_types    ipt ON ipt.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.product_types         pt  ON pt.type_code    = ipt.type_code  AND pt.is_active
  WHERE
    COALESCE(it.type, '') <> 'Category'
    AND (NOT p_managed_only OR COALESCE(s.is_managed, false))
    AND (
      p_search IS NULL OR p_search = '' OR
      it.name ILIKE '%' || p_search || '%' OR
      it.fully_qualified_name ILIKE '%' || p_search || '%' OR
      COALESCE(s.category_override, it.category_path) ILIKE '%' || p_search || '%'
    )
  ORDER BY
    COALESCE(it.active, true) DESC,
    COALESCE(s.category_override, it.category_path) NULLS LAST,
    it.name;
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_items_master(integer, text, boolean) TO authenticated;


-- ── 6. fn_create_transfer — accept freight header + per-line overrides ─────
CREATE OR REPLACE FUNCTION ops.fn_create_transfer(
  p_from_location_id    UUID,
  p_to_location_id      UUID,
  p_lines               JSONB,
  p_carrier             TEXT DEFAULT NULL,
  p_tracking_number     TEXT DEFAULT NULL,
  p_notes               TEXT DEFAULT NULL,
  p_pro_number          TEXT DEFAULT NULL,
  p_freight_terms       TEXT DEFAULT NULL,
  p_total_weight_lbs    NUMERIC DEFAULT NULL,
  p_total_pallets       NUMERIC DEFAULT NULL,
  p_declared_value_usd  NUMERIC DEFAULT NULL,
  p_special_instructions TEXT  DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_id        UUID;
  v_bol       TEXT;
  v_from_kind TEXT;
  v_to_kind   TEXT;
  v_actor     UUID := auth.uid();
  v_line      JSONB;
BEGIN
  IF p_from_location_id IS NULL OR p_to_location_id IS NULL THEN
    RAISE EXCEPTION 'from_location_id and to_location_id are required';
  END IF;
  IF p_from_location_id = p_to_location_id THEN
    RAISE EXCEPTION 'from and to locations must differ';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty JSON array';
  END IF;
  IF p_freight_terms IS NOT NULL AND p_freight_terms NOT IN ('prepaid','collect','third_party') THEN
    RAISE EXCEPTION 'freight_terms must be prepaid, collect, or third_party';
  END IF;

  SELECT kind INTO v_from_kind FROM ops.inventory_locations WHERE id = p_from_location_id;
  SELECT kind INTO v_to_kind   FROM ops.inventory_locations WHERE id = p_to_location_id;
  IF v_from_kind IS NULL THEN RAISE EXCEPTION 'from_location_id not found'; END IF;
  IF v_to_kind   IS NULL THEN RAISE EXCEPTION 'to_location_id not found';   END IF;
  IF v_from_kind = 'in_transit' OR v_to_kind = 'in_transit' THEN
    RAISE EXCEPTION 'Cannot transfer directly to/from the TRANSIT virtual location';
  END IF;

  v_bol := ops.fn_next_bol_number();

  INSERT INTO ops.inventory_transfers (
    bol_number, from_location_id, to_location_id, status,
    carrier, tracking_number, notes, created_by,
    pro_number, freight_terms, total_weight_lbs, total_pallets,
    declared_value_usd, special_instructions
  )
  VALUES (
    v_bol, p_from_location_id, p_to_location_id, 'draft',
    p_carrier, p_tracking_number, p_notes, v_actor,
    p_pro_number, p_freight_terms, p_total_weight_lbs, p_total_pallets,
    p_declared_value_usd, p_special_instructions
  )
  RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    IF (v_line ->> 'qbo_item_id') IS NULL OR (v_line ->> 'qty') IS NULL THEN
      RAISE EXCEPTION 'each line requires qbo_item_id and qty';
    END IF;
    IF (v_line ->> 'qty')::numeric <= 0 THEN
      RAISE EXCEPTION 'qty must be > 0';
    END IF;
    INSERT INTO ops.inventory_transfer_lines (
      transfer_id, qbo_item_id, qty, unit_cost, notes,
      line_weight_lbs, line_pallets
    )
    VALUES (
      v_id,
      v_line ->> 'qbo_item_id',
      (v_line ->> 'qty')::numeric,
      NULLIF(v_line ->> 'unit_cost','')::numeric,
      v_line ->> 'notes',
      NULLIF(v_line ->> 'line_weight_lbs','')::numeric,
      NULLIF(v_line ->> 'line_pallets','')::numeric
    );
  END LOOP;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_create_transfer(
  UUID, UUID, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT
) TO authenticated;


-- ── 7. fn_update_transfer_freight — header edits while in draft ────────────
CREATE OR REPLACE FUNCTION ops.fn_update_transfer_freight(
  p_transfer_id          UUID,
  p_carrier              TEXT DEFAULT NULL,
  p_tracking_number      TEXT DEFAULT NULL,
  p_pro_number           TEXT DEFAULT NULL,
  p_freight_terms        TEXT DEFAULT NULL,
  p_total_weight_lbs     NUMERIC DEFAULT NULL,
  p_total_pallets        NUMERIC DEFAULT NULL,
  p_declared_value_usd   NUMERIC DEFAULT NULL,
  p_special_instructions TEXT DEFAULT NULL,
  p_notes                TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM ops.inventory_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'transfer not found'; END IF;
  IF v_status NOT IN ('draft','in_transit') THEN
    RAISE EXCEPTION 'transfer % is %, freight header is only editable while draft or in_transit', p_transfer_id, v_status;
  END IF;
  IF p_freight_terms IS NOT NULL AND p_freight_terms NOT IN ('prepaid','collect','third_party') THEN
    RAISE EXCEPTION 'freight_terms must be prepaid, collect, or third_party';
  END IF;

  UPDATE ops.inventory_transfers SET
    carrier              = COALESCE(p_carrier,              carrier),
    tracking_number      = COALESCE(p_tracking_number,      tracking_number),
    pro_number           = COALESCE(p_pro_number,           pro_number),
    freight_terms        = COALESCE(p_freight_terms,        freight_terms),
    total_weight_lbs     = COALESCE(p_total_weight_lbs,     total_weight_lbs),
    total_pallets        = COALESCE(p_total_pallets,        total_pallets),
    declared_value_usd   = COALESCE(p_declared_value_usd,   declared_value_usd),
    special_instructions = COALESCE(p_special_instructions, special_instructions),
    notes                = COALESCE(p_notes,                notes)
  WHERE id = p_transfer_id;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_update_transfer_freight(
  UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT
) TO authenticated;


-- ── 8. fn_ship_transfer — accept shipper signature ─────────────────────────
CREATE OR REPLACE FUNCTION ops.fn_ship_transfer(
  p_transfer_id            UUID,
  p_ship_date              DATE DEFAULT NULL,
  p_shipper_signature_name TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_status  TEXT;
  v_from    UUID;
  v_transit UUID;
  v_actor   UUID := auth.uid();
BEGIN
  SELECT status, from_location_id INTO v_status, v_from
    FROM ops.inventory_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'transfer not found'; END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'transfer % is %, can only ship from draft', p_transfer_id, v_status;
  END IF;
  SELECT id INTO v_transit FROM ops.inventory_locations WHERE code = 'TRANSIT';
  IF v_transit IS NULL THEN RAISE EXCEPTION 'TRANSIT location missing'; END IF;

  INSERT INTO ops.inventory_movements (
    movement_type, qbo_item_id, qty,
    from_location_id, to_location_id, unit_cost,
    source_doc_type, source_doc_id, source_doc_line_id,
    occurred_at, created_by, notes
  )
  SELECT 'transfer_ship', l.qbo_item_id, l.qty, v_from, v_transit, l.unit_cost,
         'transfer', p_transfer_id, l.id,
         COALESCE(p_ship_date::timestamptz, now()), v_actor, l.notes
  FROM ops.inventory_transfer_lines l WHERE l.transfer_id = p_transfer_id;

  UPDATE ops.inventory_transfers
     SET status                 = 'in_transit',
         ship_date              = COALESCE(p_ship_date, CURRENT_DATE),
         shipped_by             = v_actor,
         shipper_signature_name = COALESCE(p_shipper_signature_name, shipper_signature_name),
         shipper_signature_at   = CASE WHEN p_shipper_signature_name IS NOT NULL THEN now() ELSE shipper_signature_at END
   WHERE id = p_transfer_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_ship_transfer(UUID, DATE, TEXT) TO authenticated;


-- ── 9. fn_receive_transfer — accept receiver signature ─────────────────────
CREATE OR REPLACE FUNCTION ops.fn_receive_transfer(
  p_transfer_id             UUID,
  p_received_date           DATE DEFAULT NULL,
  p_receiver_signature_name TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, pg_temp AS $$
DECLARE
  v_status  TEXT;
  v_to      UUID;
  v_transit UUID;
  v_actor   UUID := auth.uid();
BEGIN
  SELECT status, to_location_id INTO v_status, v_to
    FROM ops.inventory_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'transfer not found'; END IF;
  IF v_status <> 'in_transit' THEN
    RAISE EXCEPTION 'transfer % is %, can only receive from in_transit', p_transfer_id, v_status;
  END IF;
  SELECT id INTO v_transit FROM ops.inventory_locations WHERE code = 'TRANSIT';
  IF v_transit IS NULL THEN RAISE EXCEPTION 'TRANSIT location missing'; END IF;

  INSERT INTO ops.inventory_movements (
    movement_type, qbo_item_id, qty,
    from_location_id, to_location_id, unit_cost,
    source_doc_type, source_doc_id, source_doc_line_id,
    occurred_at, created_by, notes
  )
  SELECT 'transfer_receive', l.qbo_item_id, l.qty, v_transit, v_to, l.unit_cost,
         'transfer', p_transfer_id, l.id,
         COALESCE(p_received_date::timestamptz, now()), v_actor, l.notes
  FROM ops.inventory_transfer_lines l WHERE l.transfer_id = p_transfer_id;

  UPDATE ops.inventory_transfer_lines SET qty_received = qty WHERE transfer_id = p_transfer_id;

  UPDATE ops.inventory_transfers
     SET status                  = 'received',
         received_date           = COALESCE(p_received_date, CURRENT_DATE),
         received_by             = v_actor,
         receiver_signature_name = COALESCE(p_receiver_signature_name, receiver_signature_name),
         receiver_signature_at   = CASE WHEN p_receiver_signature_name IS NOT NULL THEN now() ELSE receiver_signature_at END
   WHERE id = p_transfer_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_receive_transfer(UUID, DATE, TEXT) TO authenticated;
