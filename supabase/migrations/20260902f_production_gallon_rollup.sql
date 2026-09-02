-- The ingredients roll up into the flavour's 1-gallon item.
--
-- Ask (Sky, 2026-09-02): "on each syrup we do have the 1 gallon code … tie
-- those together in the production system, not QuickBooks, so all of those
-- materials roll up into the 1 gallon syrup item. The separate quantities are
-- listed on the PO from our system in Refractor, but when the PO gets pushed
-- into QuickBooks it's just using the one gallon item … the master gallon holds
-- the pricing. That way we don't need to put the individual ingredients into
-- QuickBooks. We just put the gallons into QuickBooks, but we still need to see
-- how much of each one … so they can order how much of each ingredient they
-- need, and so we can see how much they're charging us per item."
--
-- The billing history agrees with him, which is why this is the right model and
-- not just the convenient one: every AC Calderoni bill on file is priced per
-- GALLON of a flavour ("3G6121 HANGAR 25 COLA, 210 @ 28.75, Cola Syrup 5XB0"),
-- never per ingredient. Calderoni compounds the batch; the ingredient list is
-- the specification of what goes in it, not a set of things we buy separately.
--
-- SO: a BOM component line is now one of two things.
--
--   a STOCKED line   carries component_qbo_item_id. Cans, tray, fill labour,
--                    pack off, and the flavour's 1-gallon item. These are what
--                    purchase orders, inventory movements and QuickBooks deal
--                    with. Unchanged in every respect.
--
--   a RECIPE line    carries ingredient_id and usually NO QuickBooks item.
--                    Sugar, citric acid, flavor. It is the specification under
--                    the gallon: it drives what the supplier is told to buy,
--                    and it never reaches QuickBooks.
--
-- The two never both cost the batch. A recipe line's cost is ALLOCATED out of
-- the gallon line's price (rollup_qbo_item_id says which line it feeds), so the
-- detail always adds back to what we are actually billed — "it will all equal
-- the same", as he put it.
--
-- Consequence worth stating: the 17 raw materials do NOT need QuickBooks items
-- after all. ops.raw_ingredients still earns its place — it is where the pack
-- size, the vendor and any directly-purchased price live — but qbo_item_id
-- there is now the exception (an ingredient we buy ourselves), not the rule.

-- ── 1. A component line may be identified by its material instead of an item ─
ALTER TABLE ops.product_bom_lines DROP CONSTRAINT IF EXISTS product_bom_lines_check;
ALTER TABLE ops.product_bom_lines ADD CONSTRAINT product_bom_lines_check CHECK (
  (line_type = 'component'
     AND (component_qbo_item_id IS NOT NULL OR ingredient_id IS NOT NULL)
     AND service_label IS NULL)
  OR
  (line_type = 'service' AND service_label IS NOT NULL AND component_qbo_item_id IS NULL)
);

ALTER TABLE ops.product_bom_lines
  ADD COLUMN IF NOT EXISTS rollup_qbo_item_id TEXT;

COMMENT ON COLUMN ops.product_bom_lines.rollup_qbo_item_id IS
  'For a RECIPE line: the stocked item this material is billed inside — the '
  'flavour 1-gallon item. The line is specification, not spend: it never '
  'becomes a purchase order line of its own and never moves inventory, and its '
  'cost is allocated out of that gallon line so the two cannot double-count.';

-- ── 2. The flavour's 1-gallon item lives on the formula ─────────────────────
ALTER TABLE ops.product_formulas
  ADD COLUMN IF NOT EXISTS gallon_qbo_item_id TEXT;

COMMENT ON COLUMN ops.product_formulas.gallon_qbo_item_id IS
  'The 1GNS#### item AC Calderoni bills this flavour under. Every ingredient on '
  'the sheet rolls up into it for QuickBooks. NULL = the recipe is informational '
  'only; nothing can be rolled up.';

UPDATE ops.product_formulas f SET gallon_qbo_item_id = m.item_id
FROM (VALUES
  ('Hangar 25 Cola',          '524'),
  ('Hangar 25 Diet Cola',     '525'),
  ('Cable Car Lemon-Lime',    '526'),
  ('Oaktown Root Beer',       '527'),
  ('Golden Gate Orange',      '528'),
  ('Lost Island Ginger Beer', '529'),
  ('Old Fountain Cream Soda', '530')
) AS m(name, item_id)
WHERE f.name = m.name AND f.gallon_qbo_item_id IS DISTINCT FROM m.item_id;

-- ── 3. Work-order materials: a recipe row is spec, not spend ────────────────
-- ⚠ SUPERSEDED BY 20260902g, applied minutes later in the same session: the
-- recipe detail moved to its own table and these two columns were dropped and
-- the NOT NULL restored. Kept here because it is what was actually run.
ALTER TABLE ops.work_order_materials
  ALTER COLUMN component_qbo_item_id DROP NOT NULL;

ALTER TABLE ops.work_order_materials
  ADD COLUMN IF NOT EXISTS is_recipe_detail   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rollup_qbo_item_id TEXT;

-- ── 4. purchase_order_line_details — the spec under a billed line ───────────
-- The PO line is the commercial line: N gallons of 1GNS6121 at the gallon
-- price, and that is exactly what goes to QuickBooks with NO CHANGE to the
-- push at all. These rows are what Refractor and the printed PO show
-- underneath it.
CREATE TABLE IF NOT EXISTS ops.purchase_order_line_details (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_line_id     UUID NOT NULL REFERENCES ops.purchase_order_lines(id) ON DELETE CASCADE,
  ingredient_id  UUID REFERENCES ops.raw_ingredients(id) ON DELETE SET NULL,
  item_name      TEXT NOT NULL,
  qty            NUMERIC NOT NULL CHECK (qty > 0),
  uom            TEXT NOT NULL DEFAULT 'lbs',
  allocated_cost NUMERIC,   -- share of the gallon price, by weight. Allocated, never quoted.
  quoted_cost    NUMERIC,   -- a real price, where the material has one on file
  notes          TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 100,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purchase_order_line_details_line_idx
  ON ops.purchase_order_line_details (po_line_id, sort_order);

COMMENT ON TABLE ops.purchase_order_line_details IS
  'The ingredient breakdown printed under a rolled-up purchase order line. '
  'Never sent to QuickBooks — the parent line (N gallons of the flavour item) '
  'is what is billed and what the QBO push sends.';

ALTER TABLE ops.purchase_order_line_details ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS po_line_details_select ON ops.purchase_order_line_details;
CREATE POLICY po_line_details_select ON ops.purchase_order_line_details
  FOR SELECT TO authenticated USING (ops.fn_is_staff());

DROP POLICY IF EXISTS po_line_details_write ON ops.purchase_order_line_details;
CREATE POLICY po_line_details_write ON ops.purchase_order_line_details
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.purchase_order_line_details TO authenticated;
REVOKE ALL ON ops.purchase_order_line_details FROM anon;
