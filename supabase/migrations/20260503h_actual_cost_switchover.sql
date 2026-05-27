-- Switch v_sales_lines.est_cost to use actual weighted-avg from
-- Bills/Purchases when available; static Item.PurchaseCost is the
-- fallback. Adds purchase_cost / actual_unit_cost / effective_unit_cost
-- / cost_source columns so the UI can show provenance.
-- Applied to live DB on 2026-05-03.

CREATE OR REPLACE VIEW ops.v_item_actual_cost AS
SELECT
  item_ref_id,
  CASE WHEN sum(quantity) > 0 THEN sum(amount) / sum(quantity) ELSE NULL END AS avg_unit_cost,
  sum(amount)::numeric  AS total_purchases,
  sum(quantity)::numeric AS total_qty,
  count(*)::bigint      AS txn_count
FROM ops.qbo_expense_lines
WHERE detail_type = 'ItemBasedExpenseLineDetail'
  AND item_ref_id IS NOT NULL
  AND quantity IS NOT NULL AND quantity > 0
GROUP BY 1;
GRANT SELECT ON ops.v_item_actual_cost TO anon, authenticated;

-- v_sales_lines now picks COALESCE(actual_unit_cost, static purchase_cost)
-- for est_cost. Schema-altering view requires DROP CASCADE; full SQL
-- (including all dependent RPC recreates) was applied via apply_migration
-- "v_sales_lines_actual_cost".
