-- v0.9.37 — Enhanced family/type auto-classification pass.
--
-- The first auto-match pass (20260512d) classified items based on
-- income_account_name + category_path. That left ~65 items in
-- Other/N/A and another ~48 unclassified entirely (mostly newly-pulled
-- inactive items + items with generic 'Other Income' account).
--
-- This pass uses item name + description patterns to handle:
--   * QBO type='Category' placeholder items (54 rows that aren't real products)
--   * Equipment items by brand name (Hoshizaki, Manitowoc, Cambro, etc.)
--   * Red Bull cooler accessories
--   * Generic fee/discount/tax items
--   * Gas cylinders
--   * Model-number-style parts (Connector, Valve, Filter, etc.)
--
-- Only touches rows currently set by auto-match — manual edits via the
-- Items master are preserved.
--
-- Result: Other/N/A dropped from 113 → 38; the remaining 38 are mostly
-- legitimate non-product placeholders (sales tax items, discounts,
-- fees, QBO Category pseudo-items).

-- ───────── FAMILY pass 2 ─────────

-- QBO Category placeholder items
UPDATE ops.item_product_families ipf
   SET family_code = 'other',
       set_by = 'auto-match v0.9.37 (category-placeholder)',
       set_at = now()
  FROM ops.qbo_items it
 WHERE it.qbo_item_id = ipf.qbo_item_id
   AND it.type = 'Category'
   AND (ipf.set_by LIKE 'auto-match%' OR ipf.set_by IS NULL);

-- Insert family rows for items that have NO classification yet
INSERT INTO ops.item_product_families (qbo_item_id, family_code, set_by)
SELECT it.qbo_item_id,
       CASE
         WHEN it.name ~* '\m(Hoshizaki|Manitowoc|Cambro|Hatco|John Boos|Carter[- ]Hoffmann|Pitco|Middleby|Garland|Dormont|USR Brands|Glo[- ]?Ray|Crisp N Hold|Lancer)\M' THEN 'bev_equip'
         WHEN it.name ~* '^RB[0-9]'                                                THEN 'bev_equip'
         WHEN it.name ~* '\m(REFRIGERAT|FREEZER|MERCHANDISER|ICE MAC|WALK[- ]?IN|GRILL|FRYER|DISPENSER|SINK|WARMER|HEATER|OVEN)\M' THEN 'bev_equip'
         WHEN it.name ~* '^[A-Z0-9]{2,}[- ]?[A-Z0-9]{3,}'
              AND it.name !~* '\m(COLA|SODA|TEA|JUICE|LEMONADE|ENERGY|BIB|CAN|CO2|NITRO|SERV|PM|REMAN|SCRAP)\M' THEN 'bev_equip'
         WHEN it.type = 'Category'                                                 THEN 'other'
         WHEN it.category_path = 'The Melt Equipment'                              THEN 'melt_equip'
         WHEN it.income_account_name = 'Equipment Sales'                           THEN 'bev_equip'
         WHEN it.income_account_name IN ('BIB Income','3 Gallon','5 Gallon')
              OR it.name ~* '^([1-9]GSF|[1-9]GNS|[1-9]G)[0-9]'                     THEN 'bib'
         WHEN it.income_account_name IN ('Packaged Beverage Income','Shopify Sales','Beverage Fee Income')
              OR it.name ~* '^(24P|12P|6P|12OZ|16OZ|CAN )'                         THEN 'can'
         WHEN it.income_account_name IN ('100% CO2','Mixed Gas and Nitro','Hazmat Del Fees','Gas COGS')
              OR it.name ~* '\m(CYLINDER|CO2|NITROGEN|NITRO )\M'                   THEN 'gas'
         WHEN it.name ~* '\m(PM|PREVENTATIVE *MAINTENANCE)\M'                      THEN 'pm'
         WHEN it.income_account_name IN ('Service Income','PM and Contract Service Income','Freshpet Service Income')
              OR it.type = 'Service'                                               THEN 'service'
         WHEN it.income_account_name IN ('Equipment Rental Income','Tank Rental Income','Sublet Rental Income') THEN 'rental'
         WHEN it.income_account_name = 'Equipment Remanufacturing'                 THEN 'reman'
         WHEN it.income_account_name = 'Scrap Income'                              THEN 'scrap'
         ELSE 'other'
       END,
       'auto-match v0.9.37'
FROM ops.qbo_items it
LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
WHERE it.qbo_item_id IS NOT NULL AND ipf.qbo_item_id IS NULL
ON CONFLICT (qbo_item_id) DO NOTHING;

-- Re-classify items currently family='other' that match equipment patterns
UPDATE ops.item_product_families ipf
   SET family_code = CASE
         WHEN it.name ~* '\m(Hoshizaki|Manitowoc|Cambro|Hatco|John Boos|Carter[- ]Hoffmann|Pitco|Middleby|Garland|Dormont|USR Brands|Glo[- ]?Ray|Crisp N Hold|Lancer)\M' THEN 'bev_equip'
         WHEN it.name ~* '^RB[0-9]'                                                  THEN 'bev_equip'
         WHEN it.name ~* '\m(REFRIGERAT|FREEZER|MERCHANDISER|ICE MAC|WALK[- ]?IN|GRILL|FRYER|DISPENSER|SINK|WARMER|HEATER|OVEN)\M' THEN 'bev_equip'
         WHEN it.name ~* '\m(CYLINDER|CO2|NITROGEN)\M'                              THEN 'gas'
         WHEN it.name ~* '\mCAN \M' AND it.category_path ~* 'Packaged Beverage'     THEN 'can'
         ELSE ipf.family_code
       END,
       set_by = CASE
         WHEN it.name ~* '\m(Hoshizaki|Manitowoc|Cambro|Hatco|John Boos|Carter[- ]Hoffmann|Pitco|Middleby|Garland|Dormont|USR Brands|Glo[- ]?Ray|Crisp N Hold|Lancer)\M'
           OR it.name ~* '^RB[0-9]'
           OR it.name ~* '\m(REFRIGERAT|FREEZER|MERCHANDISER|ICE MAC|WALK[- ]?IN|GRILL|FRYER|DISPENSER|SINK|WARMER|HEATER|OVEN)\M'
           OR it.name ~* '\m(CYLINDER|CO2|NITROGEN)\M'
           OR (it.name ~* '\mCAN \M' AND it.category_path ~* 'Packaged Beverage')
         THEN 'auto-match v0.9.37 (name-pattern)'
         ELSE ipf.set_by
       END,
       set_at = now()
  FROM ops.qbo_items it
 WHERE it.qbo_item_id = ipf.qbo_item_id
   AND ipf.family_code = 'other'
   AND it.type <> 'Category'
   AND ipf.set_by LIKE 'auto-match%';

-- ───────── TYPE pass 2 ─────────

INSERT INTO ops.item_product_types (qbo_item_id, type_code, set_by)
SELECT it.qbo_item_id,
       CASE
         WHEN it.type = 'Category'                                                 THEN 'na'
         WHEN it.name ~* '\m(FRYER|FRYING|FRY[- ]STATION)\M'                       THEN 'Fry'
         WHEN it.name ~* '\m(GRILL|GRIDDLE|CHARBROIL|CLAMSHELL)\M'                  THEN 'HotE'
         WHEN it.name ~* '\m(REFRIGERAT|FREEZER|MERCHANDISER|ICE MAC|COOLER|FRIDGE)\M' THEN 'Ref/Frz'
         WHEN it.name ~* '\m(WALK[- ]?IN)\M'                                        THEN 'Walkin'
         WHEN it.name ~* '\m(FILTER)\M'                                             THEN 'Filter'
         WHEN it.name ~* '\m(POS|REGISTER|TERMINAL|CARD READER)\M'                  THEN 'POS'
         WHEN it.name ~* '\m(STAINLESS|SINK|TABLE|RACK)\M' AND it.name !~* 'COLA'   THEN 'Stainless'
         WHEN it.category_path = 'The Melt Equipment'                              THEN 'hardware'
         WHEN it.income_account_name IN ('Equipment Sales','Equipment Remanufacturing','Scrap Income','Equipment Rental Income','Tank Rental Income','Sublet Rental Income') THEN 'hardware'
         WHEN it.income_account_name IN ('Service Income','PM and Contract Service Income','Freshpet Service Income')
              OR it.type = 'Service'                                               THEN 'labor'
         WHEN it.income_account_name IN ('100% CO2','Mixed Gas and Nitro','Hazmat Del Fees','Gas COGS')
              OR it.name ~* '\m(CYLINDER|CO2|NITROGEN)\M'                          THEN 'consumable'
         WHEN it.name ~* '\m(JUICE|APPLE|CRANBERRY|FRUIT PUNCH|PINEAPPLE|SWEET *& *SOUR|PEACH|OJ|ORANGE JUICE)\M' THEN 'juice'
         WHEN it.name ~* '\mLEMONADE\M'                                            THEN 'lemonade'
         WHEN it.name ~* '\mTEA\M'                                                 THEN 'tea'
         WHEN it.name ~* '\mENERGY\M'                                              THEN 'energy'
         WHEN it.name ~* '\m(TONIC|MIXER|CLUB SODA)\M'                             THEN 'mixer'
         WHEN it.name ~* '\m(COFFEE)\M'                                            THEN 'coffee'
         WHEN it.name ~* '\m(WATER|H2O)\M' AND it.name !~* 'CARBONATED'            THEN 'water'
         WHEN it.name ~* '\m(COLA|ROOT *BEER|GINGER *ALE|LEMON.LIME|ORANGE|CREME|CRÈME|CHERRY|GRAPEFRUIT|GINGER *BEER|DOCTEUR *POIVRE|DR *POIVRE|DR *PEPPER|SODA|CSD)\M' THEN 'csd'
         WHEN it.income_account_name IN ('BIB Income','3 Gallon','5 Gallon','Packaged Beverage Income','Shopify Sales')
              OR it.name ~* '^([1-9]GSF|[1-9]GNS|[1-9]G|24P|12P|12OZ|16OZ)'        THEN 'csd'
         ELSE 'na'
       END,
       'auto-match v0.9.37'
FROM ops.qbo_items it
LEFT JOIN ops.item_product_types ipt ON ipt.qbo_item_id = it.qbo_item_id
WHERE it.qbo_item_id IS NOT NULL AND ipt.qbo_item_id IS NULL
ON CONFLICT (qbo_item_id) DO NOTHING;

-- Re-classify items currently type='na' with specific equipment patterns
UPDATE ops.item_product_types ipt
   SET type_code = CASE
         WHEN it.name ~* '\m(FRYER|FRYING|FRY[- ]STATION)\M'                       THEN 'Fry'
         WHEN it.name ~* '\m(GRILL|GRIDDLE|CHARBROIL|CLAMSHELL)\M'                  THEN 'HotE'
         WHEN it.name ~* '\m(REFRIGERAT|FREEZER|MERCHANDISER|ICE MAC|COOLER|FRIDGE)\M' THEN 'Ref/Frz'
         WHEN it.name ~* '\m(WALK[- ]?IN)\M'                                        THEN 'Walkin'
         WHEN it.name ~* '\m(FILTER)\M'                                             THEN 'Filter'
         WHEN it.name ~* '\m(POS|REGISTER|TERMINAL|CARD READER)\M'                  THEN 'POS'
         WHEN it.name ~* '\m(STAINLESS|SINK|TABLE|RACK)\M' AND it.name !~* 'COLA'   THEN 'Stainless'
         WHEN it.name ~* '\m(JUICE|APPLE|CRANBERRY|FRUIT PUNCH|PINEAPPLE|SWEET *& *SOUR|PEACH|OJ|ORANGE JUICE)\M' THEN 'juice'
         WHEN it.name ~* '\mLEMONADE\M'                                            THEN 'lemonade'
         WHEN it.name ~* '\mTEA\M'                                                 THEN 'tea'
         WHEN it.name ~* '\mENERGY\M'                                              THEN 'energy'
         WHEN it.name ~* '\m(TONIC|MIXER|CLUB SODA)\M'                             THEN 'mixer'
         WHEN it.name ~* '\m(COFFEE)\M'                                            THEN 'coffee'
         WHEN it.name ~* '\m(WATER|H2O)\M' AND it.name !~* 'CARBONATED'            THEN 'water'
         WHEN it.name ~* '\m(COLA|ROOT *BEER|GINGER *ALE|LEMON.LIME|CREME|CRÈME|CHERRY|GRAPEFRUIT|GINGER *BEER|DOCTEUR *POIVRE|DR *POIVRE|DR *PEPPER)\M' THEN 'csd'
         WHEN it.name ~* '\m(CYLINDER|CO2|NITROGEN)\M'                              THEN 'consumable'
         WHEN EXISTS (
           SELECT 1 FROM ops.item_product_families ipf2
            WHERE ipf2.qbo_item_id = it.qbo_item_id
              AND ipf2.family_code IN ('bev_equip','melt_equip','rental','reman','scrap')
         ) THEN 'hardware'
         ELSE ipt.type_code
       END,
       set_by = 'auto-match v0.9.37 (name-pattern)',
       set_at = now()
  FROM ops.qbo_items it
 WHERE it.qbo_item_id = ipt.qbo_item_id
   AND ipt.type_code = 'na'
   AND it.type <> 'Category'
   AND ipt.set_by LIKE 'auto-match%';

-- ───────── Pass 3: clean-up gaps ─────────

-- (1) Bump type from 'na' to 'hardware' for any item in an equipment family
UPDATE ops.item_product_types ipt
   SET type_code = 'hardware',
       set_by = 'auto-match v0.9.37 (equipment-default)',
       set_at = now()
  FROM ops.item_product_families ipf
 WHERE ipf.qbo_item_id = ipt.qbo_item_id
   AND ipt.type_code = 'na'
   AND ipf.family_code IN ('bev_equip','melt_equip','rental','reman','scrap','parts')
   AND ipt.set_by LIKE 'auto-match%';

-- (2) Reclassify 'other' items that look like equipment parts → bev_equip
WITH eligible AS (
  SELECT it.qbo_item_id
  FROM ops.qbo_items it
  JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
  JOIN ops.item_product_types    ipt ON ipt.qbo_item_id = it.qbo_item_id
  WHERE it.active
    AND it.type <> 'Category'
    AND ipf.family_code = 'other'
    AND ipt.type_code   = 'na'
    AND ipf.set_by LIKE 'auto-match%'
    AND ipt.set_by LIKE 'auto-match%'
    AND it.income_account_name NOT IN ('Discounts','Delivery Fees','Shipping Income',
        'Sales Tax Payable 1','Sales Tax Payable 4','Sampling',
        'CA CRV Payable','Finance and Late Fee Charges','Merchant Acct Fees',
        'Shopify Discount','Service Expense','Bad Debt')
    AND (
      (it.name ~* '^[A-Z0-9][A-Z0-9-]{3,}' AND it.name ~ '[0-9]')
      OR it.name ~* '\m(CONNECTOR|VALVE|STICKER|GASKET|HOSE|CABLE|ENCLOSURE|FILTER|FAUCET|PUMP|CONTROLLER|REGULATOR|FLAVOR)\M'
    )
)
UPDATE ops.item_product_families ipf
   SET family_code = 'bev_equip',
       set_by = 'auto-match v0.9.37 (parts-by-name)',
       set_at = now()
  FROM eligible e
 WHERE ipf.qbo_item_id = e.qbo_item_id;

-- Bump their type to hardware too
WITH eligible AS (
  SELECT it.qbo_item_id
  FROM ops.qbo_items it
  JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
  JOIN ops.item_product_types    ipt ON ipt.qbo_item_id = it.qbo_item_id
  WHERE it.active
    AND ipf.family_code = 'bev_equip'
    AND ipt.type_code   = 'na'
    AND ipt.set_by LIKE 'auto-match%'
)
UPDATE ops.item_product_types ipt
   SET type_code = 'hardware',
       set_by = 'auto-match v0.9.37 (parts-by-name)',
       set_at = now()
  FROM eligible e
 WHERE ipt.qbo_item_id = e.qbo_item_id;
