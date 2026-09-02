-- The gaps a material has depend on HOW it is bought. A rolled-up ingredient
-- needs no QuickBooks item — that is the whole point of the roll-up — so
-- reporting one as missing would make seventeen permanent amber rows, and an
-- amber that can never be cleared is an amber nobody reads.
DROP VIEW IF EXISTS ops.v_raw_ingredients;
CREATE VIEW ops.v_raw_ingredients AS
SELECT
  r.*,
  qi.name         AS qbo_item_name,
  qi.active       AS qbo_item_active,
  qi.expense_account_name,
  v.display_name  AS vendor_name,
  (SELECT count(*) FROM ops.product_formula_ingredients fi WHERE fi.ingredient_id = r.id) AS formula_count,
  ARRAY_REMOVE(ARRAY[
    CASE WHEN r.is_purchased AND r.purchase_mode = 'direct' AND r.qbo_item_id IS NULL
         THEN 'no QuickBooks item' END,
    CASE WHEN r.is_purchased AND r.qbo_vendor_id IS NULL THEN 'no vendor' END,
    CASE WHEN r.is_purchased AND r.pack_size IS NULL     THEN 'no pack size' END,
    CASE WHEN r.is_purchased AND r.purchase_cost IS NULL THEN 'no cost' END
  ], NULL) AS gaps
FROM ops.raw_ingredients r
LEFT JOIN ops.qbo_items   qi ON qi.qbo_item_id = r.qbo_item_id
LEFT JOIN ops.qbo_vendors v  ON v.qbo_vendor_id = r.qbo_vendor_id;

GRANT SELECT ON ops.v_raw_ingredients TO authenticated;
