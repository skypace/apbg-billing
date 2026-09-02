-- The gallon line is AC CALDERONI's, not ALAMEDA SODA COMPANY PRODUCTION's.
--
-- Every 1GNS/3G/5G line ever billed on this book came from AC CALDERONI —
-- "1GNS6121 HANGAR 25 COLA, 6 @ 38.00" in May 2025, and 3-gallon BIB syrup at
-- $28-29 a unit every month since ("0040-130 Cola Syrup - 5XB0"). Not one came
-- from ALAMEDA SODA COMPANY PRODUCTION, which the seven BOM gallon lines were
-- pointing at. Left alone, a work order would have raised the ingredient
-- purchase order against the wrong company.
--
-- ALAMEDA SODA COMPANY PRODUCTION is still the right vendor for the OTHER end
-- of the run — the finished cases coming back, which fn_wo_create_production_po
-- raises against ops.production_settings.production_vendor_qbo_id. The two were
-- conflated because, before today, the gallon WAS the whole bill of materials.

UPDATE ops.product_bom_lines l
   SET preferred_qbo_vendor_id = '1099'
  FROM ops.product_bom b, ops.product_formulas f
 WHERE l.bom_id = b.id
   AND f.id = b.formula_id
   AND l.line_type = 'component'
   AND l.component_qbo_item_id = f.gallon_qbo_item_id
   AND l.preferred_qbo_vendor_id IS DISTINCT FROM '1099';

-- Rebuild every BOM's recipe from its formula, now that the ingredients no
-- longer need QuickBooks items to become lines. Idempotent: it replaces
-- source='formula' rows and never touches the cans, tray or co-packer charges.
DO $$
DECLARE v_bom UUID;
BEGIN
  FOR v_bom IN
    SELECT id FROM ops.product_bom WHERE formula_id IS NOT NULL AND is_active
  LOOP
    PERFORM ops.fn_bom_sync_from_formula(v_bom);
  END LOOP;
END $$;
