-- Seed the ingredient master from the seven live batching sheets and link
-- every formula row to it.
--
-- The 34 formula ingredient rows resolve to 18 distinct physical materials.
-- Names are mapped EXPLICITLY rather than by a normalising regex: the sheets
-- spell water three different ways ("Filtered Water", "FILTERED WATER",
-- "FIltered Water") and Old Fountain's citric acid carries an instruction
-- inside its name ("Citric Acid (See batching notes before adding)"). A regex
-- that handled those would also silently merge two materials that only look
-- alike, which is the expensive direction to be wrong in.
--
-- The sheet's own wording is KEPT on product_formula_ingredients.ingredient_name
-- — it is what the document says, and the batching instruction in that citric
-- acid line is real information. ingredient_id is what the system resolves.
--
-- Vendor defaults to AC CALDERONI (1099) on every purchased material, per the
-- "master PO for all of the ingredients" rule. Two names mention other
-- suppliers (Boggini, Modernist Pantry) — those are brand names on the sheet,
-- not necessarily who we buy from; the vendor is per-material and editable.
--
-- Costs and pack sizes are deliberately left NULL. There is no Calderoni price
-- list in the system, and a made-up cost would flow straight through to a
-- per-case cost and a QuickBooks bill. NULL renders as a visible gap.

INSERT INTO ops.raw_ingredients (slug, name, recipe_uom, is_purchased, qbo_vendor_id, notes)
VALUES
  ('filtered-water',           'Filtered Water',                     'lbs', FALSE, NULL,   'Sourced at the co-packer. On the batching sheet because it is what makes the percentages total 100; never on a purchase order.'),
  ('cane-sugar',               'Cane Sugar',                         'lbs', TRUE,  '1099', NULL),
  ('citric-acid',              'Citric Acid',                        'lbs', TRUE,  '1099', NULL),
  ('sodium-citrate',           'Sodium Citrate',                     'lbs', TRUE,  '1099', NULL),
  ('sodium-gluconate',         'Sodium Gluconate',                   'lbs', TRUE,  '1099', NULL),
  ('caramel-color',            'Caramel Color',                      'lbs', TRUE,  '1099', NULL),
  ('phosphoric-acid-75',       'Phosphoric Acid 75%',                'lbs', TRUE,  '1099', NULL),
  ('monk-sweet-powder',        'Monk Sweet Powder 100% Strength',    'lbs', TRUE,  '1099', NULL),
  ('gum-arabic',               'Gum Arabic',                         'lbs', TRUE,  '1099', 'Sheet says "Modernist Pantry Gum Arabic".'),
  ('anti-foam',                'Anti-Foam 10% Silicone',             'lbs', TRUE,  '1099', 'Sheet says "Dayton 10% Silicon DEF Anti Foam".'),
  ('flavor-cola',              'Cola Flavor',                        'lbs', TRUE,  '1099', NULL),
  ('flavor-cola-boggini-1-70', 'Cola Flavor - Boggini 1-70',         'lbs', TRUE,  '1099', 'Diet Cola only. Distinct from the regular cola flavor.'),
  ('flavor-lemon-lime',        'Lemon Lime Flavor',                  'lbs', TRUE,  '1099', NULL),
  ('flavor-orange',            'Orange Flavor',                      'lbs', TRUE,  '1099', NULL),
  ('flavor-ginger',            'Ginger Flavor',                      'lbs', TRUE,  '1099', NULL),
  ('flavor-hot-pepper',        'Hot Pepper Flavor',                  'lbs', TRUE,  '1099', NULL),
  ('flavor-root-beer',         'Root Beer Flavor',                   'lbs', TRUE,  '1099', NULL),
  ('flavor-cream-soda',        'Cream Soda Flavor',                  'lbs', TRUE,  '1099', NULL)
ON CONFLICT (slug) DO NOTHING;

-- Link the 34 formula rows. Explicit sheet-name -> slug map.
WITH map(sheet_name, slug) AS (VALUES
  ('Filtered Water',                                'filtered-water'),
  ('FILTERED WATER',                                'filtered-water'),
  ('FIltered Water',                                'filtered-water'),
  ('Cane Sugar',                                    'cane-sugar'),
  ('CANE SUGAR',                                    'cane-sugar'),
  ('Citric Acid',                                   'citric-acid'),
  ('Citric Acid (See batching notes before adding)','citric-acid'),
  ('Sodium Citrate',                                'sodium-citrate'),
  ('Sodium Gluconate',                              'sodium-gluconate'),
  ('Caramel Color',                                 'caramel-color'),
  ('Phosphoric Acid 75%',                           'phosphoric-acid-75'),
  ('Monk Sweet Powder - 100% Strength',             'monk-sweet-powder'),
  ('Modernist Pantry Gum Arabic',                   'gum-arabic'),
  ('Dayton 10% Silicon DEF Anti Foam',              'anti-foam'),
  ('Cola Flavor',                                   'flavor-cola'),
  ('Boggini Cola Flavor 1-70',                      'flavor-cola-boggini-1-70'),
  ('Lemon Lime Flavor',                             'flavor-lemon-lime'),
  ('Orange Flavor',                                 'flavor-orange'),
  ('Ginger Flavor',                                 'flavor-ginger'),
  ('Hot Pepper Flavor',                             'flavor-hot-pepper'),
  ('Root Beer Flavor',                              'flavor-root-beer'),
  ('Cream Soda Flavor',                             'flavor-cream-soda')
)
UPDATE ops.product_formula_ingredients fi
   SET ingredient_id = r.id
  FROM map m
  JOIN ops.raw_ingredients r ON r.slug = m.slug
 WHERE fi.ingredient_name = m.sheet_name
   AND fi.ingredient_id IS DISTINCT FROM r.id;

-- Tank sizes: the three real tanks, per flavour so a flavour can opt out later.
UPDATE ops.product_formulas SET tank_sizes_gal = '{1500,2000,2500}';

-- Volume bridge: 1 case = cans x oz / 128 gallons. Diet Cola carried 1000,
-- which is a BATCH size, not gallons per case — so "make 1000 gal" of Diet
-- Cola would have scaled to one case. The other six were simply null.
UPDATE ops.product_bom
   SET finished_vol_per_yield_gal = (cans_per_case::numeric * oz_per_can) / 128.0
 WHERE finished_vol_per_yield_gal IS DISTINCT FROM (cans_per_case::numeric * oz_per_can) / 128.0;
