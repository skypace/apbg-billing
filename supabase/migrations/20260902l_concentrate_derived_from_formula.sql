-- The gallons of concentrate are DERIVED, not typed.
--
-- Correction (Sky, 2026-09-02): "each case of soda will be roughly 5 to one —
-- one part concentrate and five parts water, or 1/6 of the soda. That math
-- should correlate and tie to that number … if all of that flavor, sugar,
-- sodium phosphate and everything is being entered, it should tell you how
-- many gallons that actually is."
--
-- The BOM said 1 gal per case, which was neither defensible reading and was a
-- typed placeholder nobody could check. The right number falls out of two
-- things the system already holds:
--
--   finished volume per case = cans x oz / 128        = 2.25 gal
--   concentrate per case     = finished / (1 + throw) = 2.25 / 6 = 0.375 gal
--
-- and the ingredient weights are the INDEPENDENT CHECK on it, which is the part
-- worth having. Every non-water material on the sheet ends up inside that
-- concentrate, so dividing their weight by its volume gives the syrup's solids
-- loading — a number anyone who knows fountain syrup reads instantly. Six of
-- the seven flavours land at 5.6-6.5 lb/gal, which is textbook for 5:1, and
-- they agree with each other. Set the throw ratio wrong and the number goes
-- somewhere obviously silly, which is the whole point of computing it.
--
-- ⚠ Hangar 25 DIET Cola reads 0.25 lb/gal, and that is CORRECT, not a fault:
-- it is monk-fruit sweetened and carries no bulk sugar, so its syrup really is
-- almost all water. fn_formula_batch_basis detects that (no material above 2%
-- of the finished weight) and says the solids check does not apply, rather than
-- printing a warning that can never be cleared on one of seven products.
--
-- ops.product_bom.dilution_ratio already existed with exactly this meaning and
-- is already read by fn_bom_scale_runs — it was simply 0 on all seven BOMs. The
-- FORMULA now owns the value and fn_bom_sync_from_formula writes it down to the
-- BOM, so there is one place to change it and the legacy scaler keeps working.
--
-- ⚠ The concentrate volume is what the ingredient purchase order now orders:
-- 500 cases = 187.5 gal of syrup, not 500. Verified end to end on a live run.

ALTER TABLE ops.product_formulas
  ADD COLUMN IF NOT EXISTS dilution_ratio NUMERIC NOT NULL DEFAULT 0
    CHECK (dilution_ratio >= 0);

COMMENT ON COLUMN ops.product_formulas.dilution_ratio IS
  'Throw ratio: parts water per one part concentrate. 5 = a 5:1 syrup, so the '
  'concentrate is 1/6 of the finished volume. 0 = the formula IS the finished '
  'liquid and nothing is diluted downstream. Source of truth; '
  'fn_bom_sync_from_formula writes it down to product_bom.dilution_ratio, which '
  'fn_bom_scale_runs reads.';

-- Every Alameda Soda flavour is a 5:1 fountain syrup — Calderoni's own product
-- codes say so on the bills ("Cola Syrup - 5XB0", "Root Beer 5XW0").
UPDATE ops.product_formulas SET dilution_ratio = 5 WHERE dilution_ratio = 0;
UPDATE ops.product_bom b SET dilution_ratio = f.dilution_ratio
  FROM ops.product_formulas f
 WHERE f.id = b.formula_id AND b.dilution_ratio IS DISTINCT FROM f.dilution_ratio;

-- ── fn_formula_batch_basis — the derived geometry of one case, plus the check ─
CREATE OR REPLACE FUNCTION ops.fn_formula_batch_basis(p_bom_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = ops, pg_temp AS $$
DECLARE
  v_cans        INTEGER;
  v_oz          NUMERIC;
  v_density     NUMERIC;
  v_throw       NUMERIC;
  v_yield       NUMERIC;
  v_gal         NUMERIC;
  v_conc        NUMERIC;
  v_liquid_lbs  NUMERIC;
  v_solids_lbs  NUMERIC;
  v_top_pct     NUMERIC;
  v_loading     NUMERIC;
  v_bulk        BOOLEAN;
  v_verdict     TEXT;
BEGIN
  SELECT b.cans_per_case, b.oz_per_can,
         COALESCE(f.density_lbs_per_gal, f.water_lbs_per_gal, 8.345),
         COALESCE(f.dilution_ratio, 0), COALESCE(f.yield_pct, 1)
    INTO v_cans, v_oz, v_density, v_throw, v_yield
    FROM ops.product_bom b
    LEFT JOIN ops.product_formulas f ON f.id = b.formula_id
   WHERE b.id = p_bom_id;
  IF v_cans IS NULL THEN RAISE EXCEPTION 'bom % not found', p_bom_id; END IF;

  v_gal  := (v_cans::numeric * v_oz) / 128.0;
  v_conc := v_gal / (1 + v_throw);
  v_liquid_lbs := v_gal * v_density;

  SELECT COALESCE(sum(r.qty_per_case), 0), COALESCE(max(r.pct_by_weight), 0)
    INTO v_solids_lbs, v_top_pct
    FROM ops.fn_formula_case_requirements(p_bom_id) r
   WHERE r.is_purchased;

  v_loading := CASE WHEN v_conc > 0 THEN v_solids_lbs / v_conc END;

  -- A bulk-sweetened formula carries one material at percent scale (cane sugar
  -- is 11-12% of every full-sugar flavour here). A diet formula's heaviest
  -- material is a tenth of a percent, and its syrup is legitimately almost all
  -- water — so the solids band simply does not apply to it.
  v_bulk := v_top_pct >= 0.02;

  v_verdict := CASE
    WHEN v_loading IS NULL             THEN 'no concentrate volume to check against'
    WHEN v_throw = 0                   THEN 'not diluted — the formula is the finished liquid'
    WHEN NOT v_bulk                    THEN 'diet / low-solids formula — no bulk sweetener, so the '
                                            || 'solids check does not apply'
    WHEN v_loading BETWEEN 4.5 AND 8.5 THEN 'consistent with a ' || v_throw || ':1 syrup'
    WHEN v_loading < 4.5               THEN 'thin for a sweetened syrup — the throw ratio may be too low'
    ELSE                                    'heavy for a syrup — the throw ratio may be too high'
  END;

  RETURN jsonb_build_object(
    'cans_per_case',        v_cans,
    'oz_per_can',           v_oz,
    'gal_per_case',         ROUND(v_gal, 6),
    'density_lbs_per_gal',  v_density,
    'liquid_lbs_per_case',  ROUND(v_liquid_lbs, 4),
    'dilution_ratio',       v_throw,
    'concentrate_gal_per_case', ROUND(v_conc, 6),
    'solids_lbs_per_case',  ROUND(v_solids_lbs, 5),
    'solids_lbs_per_concentrate_gal', ROUND(v_loading, 3),
    'bulk_sweetened',       v_bulk,
    'yield_pct',            v_yield,
    'verdict',              v_verdict
  );
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_formula_batch_basis(UUID) TO authenticated;

-- ── fn_batch_plan also reports the concentrate ──────────────────────────────
-- The TANK is finished product — the co-packer dilutes and carbonates — so the
-- tank arithmetic is unchanged. What is added is the gallons of syrup that must
-- arrive for the run, which is what the ingredient PO orders.
CREATE OR REPLACE FUNCTION ops.fn_batch_plan(p_bom_id UUID, p_cases NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = ops, pg_temp AS $$
DECLARE
  v_gal_per_case NUMERIC;
  v_yield        NUMERIC;
  v_throw        NUMERIC;
  v_tanks        NUMERIC[];
  v_needed       NUMERIC;
  v_batch        NUMERIC;
  v_tank         NUMERIC;
  v_tank_cases   NUMERIC;
  v_options      JSONB := '[]'::jsonb;
  v_recommended  NUMERIC := NULL;
BEGIN
  SELECT (b.cans_per_case::numeric * b.oz_per_can) / 128.0,
         COALESCE(f.yield_pct, 1),
         COALESCE(f.dilution_ratio, 0),
         COALESCE(f.tank_sizes_gal, '{1500,2000,2500}')
    INTO v_gal_per_case, v_yield, v_throw, v_tanks
    FROM ops.product_bom b
    LEFT JOIN ops.product_formulas f ON f.id = b.formula_id
   WHERE b.id = p_bom_id;
  IF v_gal_per_case IS NULL THEN RAISE EXCEPTION 'bom % not found', p_bom_id; END IF;
  IF p_cases IS NULL OR p_cases <= 0 THEN RAISE EXCEPTION 'cases must be > 0'; END IF;

  v_needed := p_cases * v_gal_per_case;
  v_batch  := v_needed / v_yield;

  SELECT array_agg(t ORDER BY t) INTO v_tanks FROM unnest(v_tanks) AS t;

  FOREACH v_tank IN ARRAY v_tanks LOOP
    v_tank_cases := floor((v_tank * v_yield) / v_gal_per_case);
    v_options := v_options || jsonb_build_object(
      'tank_gal',        v_tank,
      'cases_from_tank', v_tank_cases,
      'extra_cases',     GREATEST(v_tank_cases - p_cases, 0),
      'fits',            v_batch <= v_tank,
      'unused_gal',      ROUND(GREATEST(v_tank - v_batch, 0), 2),
      'over_by_gal',     ROUND(GREATEST(v_batch - v_tank, 0), 2),
      'concentrate_gal', ROUND(v_tank / (1 + v_throw), 2)
    );
    IF v_recommended IS NULL AND v_batch <= v_tank THEN
      v_recommended := v_tank;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'cases_requested',  p_cases,
    'gal_per_case',     ROUND(v_gal_per_case, 6),
    'yield_pct',        v_yield,
    'dilution_ratio',   v_throw,
    'finished_gal',     ROUND(v_needed, 2),
    'gal_to_batch',     ROUND(v_batch, 2),
    'concentrate_gal',  ROUND(v_batch / (1 + v_throw), 3),
    'recommended_tank', v_recommended,
    'tanks',            v_options
  );
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_batch_plan(UUID, NUMERIC) TO authenticated;
