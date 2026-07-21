-- ============================================================================
-- Seed the formula library from the five Alameda Soda co-packer spec sheets
-- (Quantum Canning batching data workbooks, uploaded 2026-07-21):
--   Alameda_Cola_V3_Updated_6.11.26.xlsx
--   Alameda_Diet_Cola_V5_Updated_6.11.26.xlsx
--   Alameda_Cream_Soda_V2.xlsx
--   Alameda_Ginger_Beer_V2.xlsx
--   Alameda_Lemon_Lime_V2.xlsx
-- Idempotent: each formula inserts only when its name is absent.
-- ============================================================================


-- ── Hangar 25 Diet Cola ──
DO $seed$
DECLARE v_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM ops.product_formulas WHERE name = 'Hangar 25 Diet Cola') THEN
    RAISE NOTICE 'formula % already seeded', 'Hangar 25 Diet Cola';
    RETURN;
  END IF;

  INSERT INTO ops.product_formulas (
    name, code, title, doc_rev, effective_date, status,
    default_batch_size_gal, can_size_oz, density_lbs_per_gal, water_lbs_per_gal,
    qc_specs, batching_instructions, source_file_name
  ) VALUES (
    'Hangar 25 Diet Cola', 'Q0XXX', 'Quantum Canning Batching Data', '1.7',
    '2025-04-04'::date, 'active',
    2000.0, 12.0,
    8.461, 8.345,
    '{"pH": "<4.1", "Brix": "0.4+/-0.2", "Carb": "4+/-0.2", "Pastuerizer Temp": "TBD", "Velcorin": "Yes"}'::jsonb,
    '["Using warm or hot water, put half of water into batching tank", "Blend in sweetener using high shear mixer", "Add remaining ingredint(s) in order they are listed", "Add rest of water and keep mixing", "Check product specs", "Flash pasteurize", "Chill and carbonate to spec", "Velcorin dose and cold fill into packaging"]'::jsonb,
    'Alameda_Diet_Cola_V5_Updated_6.11.26.xlsx'
  ) RETURNING id INTO v_id;

  INSERT INTO ops.product_formula_ingredients (formula_id, ingredient_name, pct_by_weight, uom, sort_order) VALUES
    (v_id, 'FILTERED WATER', 0.9951617, 'lbs', 100),
    (v_id, 'Boggini Cola Flavor 1-70', 0.0031, 'lbs', 110),
    (v_id, 'Caramel Color', 0.0004784, 'lbs', 120),
    (v_id, 'Phosphoric Acid 75%', 2.28e-05, 'lbs', 130),
    (v_id, 'Monk Sweet Powder - 100% Strength', 0.000842, 'lbs', 140),
    (v_id, 'Modernist Pantry Gum Arabic', 0.0003536, 'lbs', 150),
    (v_id, 'Dayton 10% Silicon DEF Anti Foam', 4.15e-05, 'lbs', 160);

  INSERT INTO ops.product_formula_revisions (formula_id, rev, note, rev_date) VALUES
    (v_id, '1', 'Initial Release', '2023-07-05'::date),
    (v_id, '1.1', 'Added if statement to convert between grams and lbs', '2023-07-10'::date),
    (v_id, '1.2', 'Color cells yellow where the operator needs to record batch info item', '2023-08-29'::date),
    (v_id, '1.3', '1. Add cell protection so formulas or critical cells are not overwritten accidentally, 2. Added usage tab to make data transfer to inventory sheet easier', '2024-05-02'::date),
    (v_id, '1.4', 'minor cell formatting cleanup', '2024-12-10'::date),
    (v_id, '1.5', 'Add Lot code column,', '2025-02-03'::date),
    (v_id, '1.6', ' past temp, velcorin', '2023-03-14'::date),
    (v_id, '1.7', 'added scale check', '2025-04-04'::date);
END;
$seed$;

-- ── Cable Car Lemon-Lime ──
DO $seed$
DECLARE v_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM ops.product_formulas WHERE name = 'Cable Car Lemon-Lime') THEN
    RAISE NOTICE 'formula % already seeded', 'Cable Car Lemon-Lime';
    RETURN;
  END IF;

  INSERT INTO ops.product_formulas (
    name, code, title, doc_rev, effective_date, status,
    default_batch_size_gal, can_size_oz, density_lbs_per_gal, water_lbs_per_gal,
    qc_specs, batching_instructions, source_file_name
  ) VALUES (
    'Cable Car Lemon-Lime', 'Q0XXX', 'Quantum Canning Batching Data', '1.7',
    '2025-04-04'::date, 'active',
    1000.0, 12.0,
    8.4, 8.345,
    '{"pH": "2.9+/-0.2", "Brix": "10.9+/-0.2", "Carb": "4.0+/-0.2", "Pastuerizer Temp": "25sec 180 F", "Velcorin": "Yes"}'::jsonb,
    '["Using warm or hot water, put half of water into batching tank", "Blend in sugar using high shear mixer", "Add remaining ingredint(s) in order they are listed", "Add rest of water and keep mixing", "Check product specs. If pH is too high, add citric until in spec", "Flash pasteurize", "Chill and carbonate to spec", "Velcorin dose and cold fill into packaging"]'::jsonb,
    'Alameda_Lemon_Lime_V2.xlsx'
  ) RETURNING id INTO v_id;

  INSERT INTO ops.product_formula_ingredients (formula_id, ingredient_name, pct_by_weight, uom, sort_order) VALUES
    (v_id, 'Filtered Water', 0.8868173, 'lbs', 100),
    (v_id, 'Cane Sugar', 0.109303, 'lbs', 110),
    (v_id, 'Citric Acid', 0.0014487, 'lbs', 120),
    (v_id, 'Sodium Citrate', 0.0002975, 'lbs', 130),
    (v_id, 'Lemon Lime Flavor', 0.0021335, 'lbs', 140);

  INSERT INTO ops.product_formula_revisions (formula_id, rev, note, rev_date) VALUES
    (v_id, '1', 'Initial Release', '2023-07-05'::date),
    (v_id, '1.1', 'Added if statement to convert between grams and lbs', '2023-07-10'::date),
    (v_id, '1.2', 'Color cells yellow where the operator needs to record batch info item', '2023-08-29'::date),
    (v_id, '1.3', '1. Add cell protection so formulas or critical cells are not overwritten accidentally, 2. Added usage tab to make data transfer to inventory sheet easier', '2024-05-02'::date),
    (v_id, '1.4', 'minor cell formatting cleanup', '2024-12-10'::date),
    (v_id, '1.5', 'Add Lot code column,', '2025-02-03'::date),
    (v_id, '1.6', ' past temp, velcorin', '2023-03-14'::date),
    (v_id, '1.7', 'added scale check', '2025-04-04'::date);
END;
$seed$;

-- ── Lost Island Ginger Beer ──
DO $seed$
DECLARE v_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM ops.product_formulas WHERE name = 'Lost Island Ginger Beer') THEN
    RAISE NOTICE 'formula % already seeded', 'Lost Island Ginger Beer';
    RETURN;
  END IF;

  INSERT INTO ops.product_formulas (
    name, code, title, doc_rev, effective_date, status,
    default_batch_size_gal, can_size_oz, density_lbs_per_gal, water_lbs_per_gal,
    qc_specs, batching_instructions, source_file_name
  ) VALUES (
    'Lost Island Ginger Beer', 'Q0XXX', 'Quantum Canning Batching Data', '1.7',
    '2025-04-04'::date, 'active',
    1000.0, 12.0,
    8.4, 8.345,
    '{"pH": "2.6 +/-0.2", "Brix": "12.4+/-0.2", "Carb": "4.0+/-0.2", "Pastuerizer Temp": "TBD", "Velcorin": "Yes"}'::jsonb,
    '["Using warm or hot water, put half of water into batching tank", "Blend in sugar using high shear mixer", "Add remaining ingredint(s) in order they are listed", "Add rest of water and keep mixing", "Check product specs. If pH is too high, add citric until in spec", "Chill and carbonate to spec", "Velcorin dose and cold fill into packaging"]'::jsonb,
    'Alameda_Ginger_Beer_V2.xlsx'
  ) RETURNING id INTO v_id;

  INSERT INTO ops.product_formula_ingredients (formula_id, ingredient_name, pct_by_weight, uom, sort_order) VALUES
    (v_id, 'Filtered Water', 0.8708517, 'lbs', 100),
    (v_id, 'Cane Sugar', 0.123538, 'lbs', 110),
    (v_id, 'Citric Acid', 0.001375, 'lbs', 120),
    (v_id, 'Ginger Flavor', 0.0025883, 'lbs', 130),
    (v_id, 'Hot Pepper Flavor', 0.001538, 'lbs', 140),
    (v_id, 'Caramel Color', 0.000109, 'lbs', 150);

  INSERT INTO ops.product_formula_revisions (formula_id, rev, note, rev_date) VALUES
    (v_id, '1', 'Initial Release', '2023-07-05'::date),
    (v_id, '1.1', 'Added if statement to convert between grams and lbs', '2023-07-10'::date),
    (v_id, '1.2', 'Color cells yellow where the operator needs to record batch info item', '2023-08-29'::date),
    (v_id, '1.3', '1. Add cell protection so formulas or critical cells are not overwritten accidentally, 2. Added usage tab to make data transfer to inventory sheet easier', '2024-05-02'::date),
    (v_id, '1.4', 'minor cell formatting cleanup', '2024-12-10'::date),
    (v_id, '1.5', 'Add Lot code column,', '2025-02-03'::date),
    (v_id, '1.6', ' past temp, velcorin', '2023-03-14'::date),
    (v_id, '1.7', 'added scale check', '2025-04-04'::date);
END;
$seed$;

-- ── Hangar 25 Cola ──
DO $seed$
DECLARE v_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM ops.product_formulas WHERE name = 'Hangar 25 Cola') THEN
    RAISE NOTICE 'formula % already seeded', 'Hangar 25 Cola';
    RETURN;
  END IF;

  INSERT INTO ops.product_formulas (
    name, code, title, doc_rev, effective_date, status,
    default_batch_size_gal, can_size_oz, density_lbs_per_gal, water_lbs_per_gal,
    qc_specs, batching_instructions, source_file_name
  ) VALUES (
    'Hangar 25 Cola', 'Q0XXX', 'Quantum Canning Batching Data', '1.7',
    '2025-04-04'::date, 'active',
    1500.0, 12.0,
    8.4, 8.345,
    '{"pH": "2.50-2.60", "Brix": "11.8+/-0.2", "Carb": "3.8+/-0.2", "Pastuerizer Temp": "25sec 180 F", "Velcorin": "Yes"}'::jsonb,
    '["Using warm or hot water, put half of water into batching tank", "Blend in sugar using high shear mixer, withholding 10%.", "Add cola flavor, check pH.", "Add sodium gluconate, witholding 20%. Blend.", "Add rest of water and keep mixing.", "Check product specs.", "For pH, goal pH 2.50-2.60, preference to 2.5. If under 2.5 add sodium gluconate until at or above 2.5.", "For brix, adjust as neccesary to bring in range.", "Flash pasteurize.", "Chill and carbonate to spec.", "Velcorin dose and cold fill into packaging."]'::jsonb,
    'Alameda_Cola_V3_Updated_6.11.26.xlsx'
  ) RETURNING id INTO v_id;

  INSERT INTO ops.product_formula_ingredients (formula_id, ingredient_name, pct_by_weight, uom, sort_order) VALUES
    (v_id, 'FIltered Water', 0.878819, 'lbs', 100),
    (v_id, 'Cane Sugar', 0.1167, 'lbs', 110),
    (v_id, 'Cola Flavor', 0.004381, 'lbs', 120),
    (v_id, 'Sodium Gluconate', 0.0001, 'lbs', 130);

  INSERT INTO ops.product_formula_revisions (formula_id, rev, note, rev_date) VALUES
    (v_id, '1.0', 'Initial Release', '2023-07-05'::date),
    (v_id, '1.1', 'Added if statement to convert between grams and lbs', '2023-07-10'::date),
    (v_id, '1.2', 'Color cells yellow where the operator needs to record batch info item', '2023-08-29'::date),
    (v_id, '1.3', '1. Add cell protection so formulas or critical cells are not overwritten accidentally, 2. Added usage tab to make data transfer to inventory sheet easier', '2024-05-02'::date),
    (v_id, '1.4', 'minor cell formatting cleanup', '2024-12-10'::date),
    (v_id, '1.5', 'Add Lot code column,', '2025-02-03'::date),
    (v_id, '1.6', ' past temp, velcorin', '2023-03-14'::date),
    (v_id, '1.7', 'added scale check', '2025-04-04'::date);
END;
$seed$;

-- ── Old Fountain Cream Soda ──
DO $seed$
DECLARE v_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM ops.product_formulas WHERE name = 'Old Fountain Cream Soda') THEN
    RAISE NOTICE 'formula % already seeded', 'Old Fountain Cream Soda';
    RETURN;
  END IF;

  INSERT INTO ops.product_formulas (
    name, code, title, doc_rev, effective_date, status,
    default_batch_size_gal, can_size_oz, density_lbs_per_gal, water_lbs_per_gal,
    qc_specs, batching_instructions, source_file_name
  ) VALUES (
    'Old Fountain Cream Soda', 'Q0XXX', 'Quantum Canning Batching Data', '1.7',
    '2025-04-04'::date, 'active',
    5000.0, 12.0,
    8.4, 8.345,
    '{"pH": "3.4+/-0.2", "Brix": "10.9+/-0.2", "Carb": "3.5+/-0.2", "Pastuerizer Temp": "TBD", "Velcorin": "Yes"}'::jsonb,
    '["Using warm or hot water, if available, (filtered tap water adequate with sheer mixer) put 40%of water into batching tank", "Blend in all sugar using high shear mixer", "Add 90 % of Citric Acid", "Add all of Cream Soda flavor", "Add rest of water and mix for a minimum of 15 minutes", "Check product specs. Add citric until pH is in spec at 3.4+/-0.2 mix for 10 minutes after any additional citric addition", "Flash pasteurize", "Chill and carbonate to 3.5+/-0.2", "Velcorin dose and cold fill into packaging"]'::jsonb,
    'Alameda_Cream_Soda_V2.xlsx'
  ) RETURNING id INTO v_id;

  INSERT INTO ops.product_formula_ingredients (formula_id, ingredient_name, pct_by_weight, uom, sort_order) VALUES
    (v_id, 'Filtered Water', 0.8877902, 'lbs', 100),
    (v_id, 'Cane Sugar', 0.109303, 'lbs', 110),
    (v_id, 'Citric Acid (See batching notes before adding)', 0.0003968, 'lbs', 120),
    (v_id, 'Cream Soda Flavor', 0.00251, 'lbs', 130);

  INSERT INTO ops.product_formula_revisions (formula_id, rev, note, rev_date) VALUES
    (v_id, '1', 'Initial Release', '2023-07-05'::date),
    (v_id, '1.1', 'Added if statement to convert between grams and lbs', '2023-07-10'::date),
    (v_id, '1.2', 'Color cells yellow where the operator needs to record batch info item', '2023-08-29'::date),
    (v_id, '1.3', '1. Add cell protection so formulas or critical cells are not overwritten accidentally, 2. Added usage tab to make data transfer to inventory sheet easier', '2024-05-02'::date),
    (v_id, '1.4', 'minor cell formatting cleanup', '2024-12-10'::date),
    (v_id, '1.5', 'Add Lot code column,', '2025-02-03'::date),
    (v_id, '1.6', ' past temp, velcorin', '2023-03-14'::date),
    (v_id, '1.7', 'added scale check', '2025-04-04'::date);
END;
$seed$;
