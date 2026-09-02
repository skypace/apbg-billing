-- Correction to 20260902f, applied minutes later in the same session: the
-- ingredient breakdown gets its OWN work-order table instead of riding in
-- ops.work_order_materials.
--
-- Putting it in work_order_materials meant relaxing component_qbo_item_id to
-- NULL and teaching fn_wo_advance to skip those rows in two places — the
-- consume movement and the component cost. That is two chances for a later
-- edit to forget, and the failure modes are an inventory movement for a thing
-- with no item and a batch costed twice. A separate table cannot be forgotten:
-- fn_wo_advance never sees it, and the NOT NULL guard goes back on.

ALTER TABLE ops.work_order_materials
  DROP COLUMN IF EXISTS is_recipe_detail,
  DROP COLUMN IF EXISTS rollup_qbo_item_id;

ALTER TABLE ops.work_order_materials
  ALTER COLUMN component_qbo_item_id SET NOT NULL;

-- ── The ingredient specification for one run ────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.work_order_recipe_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_id              UUID NOT NULL REFERENCES ops.work_orders(id) ON DELETE CASCADE,
  bom_line_id        UUID REFERENCES ops.product_bom_lines(id) ON DELETE SET NULL,
  ingredient_id      UUID REFERENCES ops.raw_ingredients(id) ON DELETE SET NULL,
  item_name          TEXT NOT NULL,
  recipe_qty         NUMERIC NOT NULL CHECK (recipe_qty > 0),  -- what the batch needs
  recipe_uom         TEXT NOT NULL DEFAULT 'lbs',
  order_qty          NUMERIC,      -- converted to the vendor's pack, rounded up
  purchase_uom       TEXT,
  pack_size          NUMERIC,
  rollup_qbo_item_id TEXT,         -- the gallon line this is billed inside
  po_line_id         UUID REFERENCES ops.purchase_order_lines(id) ON DELETE SET NULL,
  sort_order         INTEGER NOT NULL DEFAULT 100,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS work_order_recipe_lines_wo_idx
  ON ops.work_order_recipe_lines (wo_id, sort_order);

COMMENT ON TABLE ops.work_order_recipe_lines IS
  'The ingredient breakdown for a run: what the supplier must buy to compound '
  'the batch. Deliberately NOT in work_order_materials — these rows are '
  'specification, not spend. They never become a purchase order line of their '
  'own, never move inventory and are never counted in the component cost; the '
  'gallon line they roll into carries all three.';

ALTER TABLE ops.work_order_recipe_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wo_recipe_lines_select ON ops.work_order_recipe_lines;
CREATE POLICY wo_recipe_lines_select ON ops.work_order_recipe_lines
  FOR SELECT TO authenticated USING (ops.fn_is_staff());

DROP POLICY IF EXISTS wo_recipe_lines_write ON ops.work_order_recipe_lines;
CREATE POLICY wo_recipe_lines_write ON ops.work_order_recipe_lines
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.work_order_recipe_lines TO authenticated;
REVOKE ALL ON ops.work_order_recipe_lines FROM anon;

-- ── How a material is bought ────────────────────────────────────────────────
-- Explicit, so that creating a QuickBooks item for a material does not by
-- itself change how it is purchased. Otherwise one click on "create the
-- missing items" would silently turn every Calderoni gallon order into
-- seventeen ingredient lines.
ALTER TABLE ops.raw_ingredients
  ADD COLUMN IF NOT EXISTS purchase_mode TEXT NOT NULL DEFAULT 'rollup'
    CHECK (purchase_mode IN ('rollup', 'direct'));

COMMENT ON COLUMN ops.raw_ingredients.purchase_mode IS
  'rollup (default) = billed inside the flavour 1-gallon item; the quantity is '
  'shown to the supplier but never becomes its own purchase order line, and no '
  'QuickBooks item is needed. direct = we buy this material ourselves, so it '
  'gets its own PO line and DOES need an item.';
