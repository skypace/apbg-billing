-- ============================================================================
-- Production: raw materials become real items, and the case BOM carries them
--
-- Ask (Sky, 2026-09-02): "each one of those formulas is basically everything
-- that goes into a can of soda and each one of those needs to be built into a
-- bill of materials ... a BOM for a Hangar 25 Cola 24 pack would have the raw
-- ingredients phosphoric acid sugar all that stuff and then it would have 24
-- single cans then a sleek tray then a tolling charge per case and a fill
-- charge per case ... somehow you have to do the math on the formula to figure
-- out how much of each item is actually in a case."
--
-- WHAT WAS ACTUALLY THERE, and why it could not do that:
--
--   * Every case BOM had FOUR lines and none of them was an ingredient:
--       1 gal   1GNS#### <flavor>        ← the whole liquid, as ONE purchased
--                                          thing, bought from ALAMEDA SODA
--                                          COMPANY PRODUCTION
--       24 ea   12OZ CAN FILL LABOR
--       24 ea   12OZ PACK OFF
--       1  ea   C-TRAY 24 PK SLEEK
--     So the ingredients were invisible below the gallon, and no purchase
--     order for AC Calderoni could ever fall out of a work order.
--
--   * NOT ONE formula ingredient was linked to an item
--     (component_qbo_item_id is null on all 34 rows), and no ingredient item
--     exists in the QuickBooks mirror at all — no sugar, no citric acid, no
--     phosphoric acid, no flavor. That is the "items still need to be created"
--     gap, and it is why the link column was empty rather than unused.
--
--   * SIX OF SEVEN BOMs have no can line. The empty-can items 685/686/688/689/
--     690/691 are INACTIVE in QuickBooks (QBO appends "(deleted)" to the name),
--     so only Old Fountain (687, still active) carries its can. Five flavours
--     would have been canned with no can on the bill of materials.
--
-- WHAT THIS MIGRATION ADDS:
--
--   ops.raw_ingredients        the ingredient master — ONE row per physical
--                              material, shared by every formula that uses it,
--                              carrying how it is BOUGHT (pack size, cost,
--                              vendor) as distinct from how it is BATCHED
--                              (percent by weight, in lbs).
--
--   formula → per-case math    ops.fn_formula_case_requirements(bom_id):
--                              gal/case = cans × oz / 128
--                              lbs/case = gal/case × density lbs/gal
--                              ingredient lbs/case = lbs/case × pct_by_weight
--
--   ops.fn_bom_sync_from_formula(bom_id)
--                              writes those ingredient rows INTO the case BOM
--                              as ordinary component lines and leaves every
--                              hand-entered line (cans, tray, fill, pack off)
--                              alone. Formula-derived lines are marked
--                              source='formula' so a rebuild replaces exactly
--                              those and nothing else.
--
--   ops.fn_batch_plan(bom_id, cases)
--                              the tank / MOQ answer: gallons needed, and per
--                              tank size how many cases that tank yields and
--                              how many MORE cases fill it.
--
-- TWO RULES THAT ARE LOAD-BEARING, stated here because a later edit will want
-- to undo them:
--
--   1. WATER IS NOT PURCHASED. Filtered water is 87-99% of every formula by
--      weight and it comes out of the wall at the co-packer. It stays on the
--      batching sheet (it is what makes the percentages add to 100) and is
--      excluded from the BOM and every purchase order by is_purchased=false.
--      Putting it on a Calderoni PO would order 2 tons of water per run.
--
--   2. RECIPE UNITS AND PURCHASE UNITS ARE DIFFERENT UNITS. The formula says
--      lbs; the vendor sells 50-lb bags. required_qty on a work order is what
--      goes ON THE PURCHASE ORDER (packs, rounded up to a whole pack because
--      you cannot buy 0.4 of a bag), and recipe_qty is the theoretical need.
--      Collapsing the two is how a PO ends up ordering 11.7 bags of sugar.
-- ============================================================================


-- ── 1. raw_ingredients — the ingredient master ──────────────────────────────
CREATE TABLE IF NOT EXISTS ops.raw_ingredients (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,                       -- canonical: "Cane Sugar"
  slug              TEXT NOT NULL UNIQUE,                -- "cane-sugar", the match key
  category          TEXT NOT NULL DEFAULT 'ingredient'
                      CHECK (category IN ('ingredient','packaging','service','other')),

  -- how it is BATCHED
  recipe_uom        TEXT NOT NULL DEFAULT 'lbs',

  -- how it is BOUGHT
  is_purchased      BOOLEAN NOT NULL DEFAULT TRUE,
  purchase_uom      TEXT,                                -- "50 lb bag", "lbs", "gal"
  pack_size         NUMERIC CHECK (pack_size IS NULL OR pack_size > 0),
                                                         -- recipe units in one purchase unit
  order_multiple    NUMERIC NOT NULL DEFAULT 1 CHECK (order_multiple > 0),
  purchase_cost     NUMERIC CHECK (purchase_cost IS NULL OR purchase_cost >= 0),
                                                         -- per PURCHASE unit
  qbo_item_id       TEXT,                                -- null until the item exists
  qbo_vendor_id     TEXT,
  vendor_part_no    TEXT,

  notes             TEXT,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops.raw_ingredients IS
  'One row per physical raw material, shared across formulas. Separates how a '
  'material is BATCHED (recipe_uom, percent by weight on the formula) from how '
  'it is BOUGHT (purchase_uom, pack_size, purchase_cost, vendor). '
  'is_purchased=false means it is real in the batch but never on a PO — water.';
COMMENT ON COLUMN ops.raw_ingredients.pack_size IS
  'Recipe units contained in ONE purchase unit. 50 for a 50-lb bag of sugar. '
  'NULL means bought in the recipe unit itself (1:1).';
COMMENT ON COLUMN ops.raw_ingredients.qbo_item_id IS
  'NULL is a real, visible state: the material exists in a formula but has no '
  'QuickBooks item yet, so it cannot be put on a purchase order. The Raw '
  'materials panel reports these rather than silently dropping them.';

CREATE INDEX IF NOT EXISTS raw_ingredients_item_idx
  ON ops.raw_ingredients (qbo_item_id) WHERE qbo_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ops.tg_raw_ingredients_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS raw_ingredients_touch ON ops.raw_ingredients;
CREATE TRIGGER raw_ingredients_touch
  BEFORE UPDATE ON ops.raw_ingredients
  FOR EACH ROW EXECUTE FUNCTION ops.tg_raw_ingredients_touch();


-- ── 2. formula ingredients point at the master ──────────────────────────────
-- ingredient_name stays: it is what the batching sheet literally says
-- ("Citric Acid (See batching notes before adding)"), and that text is part of
-- the document. ingredient_id is what the system resolves against.
ALTER TABLE ops.product_formula_ingredients
  ADD COLUMN IF NOT EXISTS ingredient_id UUID REFERENCES ops.raw_ingredients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS product_formula_ingredients_ingredient_idx
  ON ops.product_formula_ingredients (ingredient_id) WHERE ingredient_id IS NOT NULL;


-- ── 3. formulas: tank sizes and yield, per flavour ──────────────────────────
ALTER TABLE ops.product_formulas
  ADD COLUMN IF NOT EXISTS tank_sizes_gal NUMERIC[] NOT NULL DEFAULT '{1500,2000,2500}',
  ADD COLUMN IF NOT EXISTS yield_pct      NUMERIC NOT NULL DEFAULT 1.0
    CHECK (yield_pct > 0 AND yield_pct <= 1);

COMMENT ON COLUMN ops.product_formulas.tank_sizes_gal IS
  'Tank sizes this flavour can be batched in, ascending gallons. Per-formula '
  'because not every flavour runs in every tank. The work order uses these to '
  'answer "how many more cases fill the tank".';
COMMENT ON COLUMN ops.product_formulas.yield_pct IS
  'Finished sellable volume / volume batched. 0.97 = 3% lost to the run. '
  'Drives BOTH how much liquid must be batched for N cases AND the scrap on '
  'the formula-derived BOM lines. 1.0 = no loss assumed (the honest default '
  'until a real run measures one).';


-- ── 4. BOM lines: where a line came from ────────────────────────────────────
-- Without this a rebuild cannot tell a formula-derived sugar line from a
-- hand-entered can line, so it would either wipe the operator's work or
-- duplicate the ingredients on every rebuild.
ALTER TABLE ops.product_bom_lines
  ADD COLUMN IF NOT EXISTS source        TEXT NOT NULL DEFAULT 'manual'
                            CHECK (source IN ('manual','formula')),
  ADD COLUMN IF NOT EXISTS ingredient_id UUID REFERENCES ops.raw_ingredients(id) ON DELETE SET NULL;

COMMENT ON COLUMN ops.product_bom_lines.source IS
  '''formula'' = written by fn_bom_sync_from_formula and owned by it; a rebuild '
  'replaces exactly these. ''manual'' = a human put it there (cans, tray, fill '
  'labour, pack off) and a rebuild never touches it.';

CREATE INDEX IF NOT EXISTS product_bom_lines_source_idx
  ON ops.product_bom_lines (bom_id, source);


-- ── 5. work_order_materials: recipe units vs purchase units ─────────────────
ALTER TABLE ops.work_order_materials
  ADD COLUMN IF NOT EXISTS recipe_qty    NUMERIC,
  ADD COLUMN IF NOT EXISTS recipe_uom    TEXT,
  ADD COLUMN IF NOT EXISTS pack_size     NUMERIC,
  ADD COLUMN IF NOT EXISTS ingredient_id UUID REFERENCES ops.raw_ingredients(id) ON DELETE SET NULL;

COMMENT ON COLUMN ops.work_order_materials.required_qty IS
  'Quantity to PURCHASE, in the vendor''s unit, already rounded up to a whole '
  'order multiple. This is what goes on the purchase order line.';
COMMENT ON COLUMN ops.work_order_materials.recipe_qty IS
  'Theoretical need in recipe units (lbs of sugar), before pack rounding. '
  'What the batching sheet asks for; required_qty is what gets bought.';


-- ── 6. work orders: which tank was chosen ───────────────────────────────────
ALTER TABLE ops.work_orders
  ADD COLUMN IF NOT EXISTS tank_size_gal NUMERIC;

COMMENT ON COLUMN ops.work_orders.tank_size_gal IS
  'Tank the run is planned into. Informational on the WO; the batch plan panel '
  'is what computes the gallons and the cases-to-fill.';

-- ── 10. production settings — who we buy the finished cases from ────────────
-- The finished case is bought from ourselves: ALAMEDA SODA COMPANY PRODUCTION
-- is a real QuickBooks vendor (1603) and the gallon items already expense to
-- "Can Raw Materials" (account 294). That account is the clearing account:
-- the Calderoni bill and the Quantum bill both land in it, and the production
-- PO for finished cases relieves it, so the account nets to zero per run and
-- anything left over is a real variance rather than a rounding rumour.
CREATE TABLE IF NOT EXISTS ops.production_settings (
  id                          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  production_vendor_qbo_id    TEXT,
  clearing_account_ref_id     TEXT,
  clearing_account_name       TEXT,
  default_tank_sizes_gal      NUMERIC[] NOT NULL DEFAULT '{1500,2000,2500}',
  raw_material_vendor_qbo_id  TEXT,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ops.production_settings (
  id, production_vendor_qbo_id, clearing_account_ref_id, clearing_account_name,
  raw_material_vendor_qbo_id
) VALUES (TRUE, '1603', '294', 'Can Raw Materials', '1099')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE ops.production_settings IS
  'Single row. production_vendor_qbo_id = the vendor the finished cases are '
  'purchased from (ALAMEDA SODA COMPANY PRODUCTION). clearing_account_* = the '
  'account every production cost is offset through.';


-- ── 11. purchase_orders: materials PO vs the production PO ──────────────────
ALTER TABLE ops.purchase_orders
  ADD COLUMN IF NOT EXISTS po_kind TEXT NOT NULL DEFAULT 'materials'
    CHECK (po_kind IN ('materials','production','other'));

COMMENT ON COLUMN ops.purchase_orders.po_kind IS
  '''materials'' = raw materials / packaging / tolling out to a real vendor. '
  '''production'' = the finished goods coming back in from ALAMEDA SODA COMPANY '
  'PRODUCTION at the merged per-case cost. They are opposite ends of one run '
  'and must never be summed together as spend.';


-- ── 15. RLS + grants, written together ──────────────────────────────────────
-- Postgres checks table GRANTs BEFORE RLS, so a policy with no grant behind it
-- is a dead button (the 20260825a lesson). Both are here in one place.
ALTER TABLE ops.raw_ingredients     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.production_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS raw_ingredients_select ON ops.raw_ingredients;
CREATE POLICY raw_ingredients_select ON ops.raw_ingredients
  FOR SELECT TO authenticated USING (ops.fn_is_staff());

DROP POLICY IF EXISTS raw_ingredients_write ON ops.raw_ingredients;
CREATE POLICY raw_ingredients_write ON ops.raw_ingredients
  FOR ALL TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());

DROP POLICY IF EXISTS production_settings_select ON ops.production_settings;
CREATE POLICY production_settings_select ON ops.production_settings
  FOR SELECT TO authenticated USING (ops.fn_is_staff());

DROP POLICY IF EXISTS production_settings_write ON ops.production_settings;
CREATE POLICY production_settings_write ON ops.production_settings
  FOR UPDATE TO authenticated USING (ops.fn_is_staff()) WITH CHECK (ops.fn_is_staff());

GRANT SELECT, INSERT, UPDATE, DELETE ON ops.raw_ingredients     TO authenticated;
GRANT SELECT, UPDATE                 ON ops.production_settings TO authenticated;
REVOKE ALL ON ops.raw_ingredients     FROM anon;
REVOKE ALL ON ops.production_settings FROM anon;
