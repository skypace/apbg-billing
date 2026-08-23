-- ============================================================================
-- Seed two more Alameda Soda formulas from the co-packer spec sheets
-- (uploaded 2026-07-21): Alameda_Orange_V2.xlsx (Golden Gate Orange) and
-- Alameda_Root_Beer_V2.xlsx (Oaktown Root Beer).
-- Idempotent: each formula inserts only when its name is absent.
-- ============================================================================


-- ── Golden Gate Orange ──
DO $seed$
DECLARE v_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM ops.product_formulas WHERE name = 'Golden Gate Orange') THEN
    RAISE NOTICE 'formula % already seeded', 'Golden Gate Orange';
    RETURN;
  END IF;

  INSERT INTO ops.product_formulas (
    name, code, title, doc_rev, effective_date, status,
    default_batch_size_gal, can_size_oz, density_lbs_per_gal, water_lbs_per_gal,
    qc_specs, batching_instructions, source_file_name
  ) VALUES (
    'Golden Gate Orange', 'Q0XXX', 'Quantum Canning Batching Data', '1.7',
    '2025-04-04'::date, 'active',
    1000.0, 12.0,
    8.4, 8.345,
    '{"pH": "2.6+/-0.2", "Brix": "12.1+/-0.2", "Carb": "3.5+/-0.2", "Pastuerizer Temp": "25sec 180 F", "Velcorin": "Yes"}'::jsonb,
    '["Using warm or hot water, if available, (filtered tap water adequate with sheer mixer) put 40%of water into batching tank", "Blend in all sugar using high shear mixer", "Add citric", "Add all of orange flavor", "Add rest of water and mix for a minimum of 30 minutes", "Check product specs. Add citric until pH is in spec at 2.6+/-0.2 mix for 10 minutes after any additional citric addition", "Add sugar until sugar is in spec at 12.1+/-0.2", "Flash pasteurize", "Chill and carbonate to 3.5+/-0.2", "Velcorin dose and cold fill into packaging"]'::jsonb,
    'Alameda_Orange_V2.xlsx'
  ) RETURNING id INTO v_id;

  INSERT INTO ops.product_formula_ingredients (formula_id, ingredient_name, pct_by_weight, uom, sort_order) VALUES
    (v_id, 'FILTERED WATER', 0.8745434, 'lbs', 100),
    (v_id, 'CANE SUGAR', 0.121, 'lbs', 110),
    (v_id, 'Citric Acid', 0.0017066, 'lbs', 120),
    (v_id, 'Orange Flavor', 0.00275, 'lbs', 130);

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

-- ── Oaktown Root Beer ──
DO $seed$
DECLARE v_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM ops.product_formulas WHERE name = 'Oaktown Root Beer') THEN
    RAISE NOTICE 'formula % already seeded', 'Oaktown Root Beer';
    RETURN;
  END IF;

  INSERT INTO ops.product_formulas (
    name, code, title, doc_rev, effective_date, status,
    default_batch_size_gal, can_size_oz, density_lbs_per_gal, water_lbs_per_gal,
    qc_specs, batching_instructions, source_file_name
  ) VALUES (
    'Oaktown Root Beer', 'Q', 'Quantum Canning Batching Data', '1.7',
    '2025-04-04'::date, 'active',
    1000.0, 12.0,
    8.4, 8.345,
    '{"pH": "3.6+/-0.2", "Brix": "10.9+/-0.2", "Carb": "3.5+/-0.2", "Pastuerizer Temp": "180", "Velcorin": "Yes"}'::jsonb,
    '["Using warm or hot water, if available, (filtered tap water adequate with sheer mixer) put 40%of water into batching tank", "Blend in all sugar using high shear mixer", "Add 75% of Citric Acid", "Add all of root beer flavor", "Add rest of water and mix for a minimum of 15 minutes", "Check product specs. Add citric until pH is in spec at 3.6+/-0.2 mix for 10 minutes after any additional citric addition", "Flash pasteurize", "Chill and carbonate to 3.5+/-0.2", "Velcorin dose and cold fill into packaging"]'::jsonb,
    'Alameda_Root_Beer_V2.xlsx'
  ) RETURNING id INTO v_id;

  INSERT INTO ops.product_formula_ingredients (formula_id, ingredient_name, pct_by_weight, uom, sort_order) VALUES
    (v_id, 'Filtered Water', 0.8882682, 'lbs', 100),
    (v_id, 'Cane Sugar', 0.109303, 'lbs', 110),
    (v_id, 'Citric Acid', 0.0001588, 'lbs', 120),
    (v_id, 'Root Beer Flavor', 0.00227, 'lbs', 130);

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
