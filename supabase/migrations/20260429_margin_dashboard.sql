-- Margin Minder-style sales analytics: item master + flat sales view + pivot RPCs.
-- Applied to project gfsdpwiqzshhexkofiif on 2026-04-29.

-- 1. Item master from QBO (populated by netlify/functions/sync-qbo-items.mjs)
CREATE TABLE IF NOT EXISTS ops.qbo_items (
  id              bigserial PRIMARY KEY,
  qbo_item_id     text UNIQUE NOT NULL,
  name            text NOT NULL,
  fully_qualified_name text,
  sku             text,
  type            text,
  active          boolean DEFAULT true,
  taxable         boolean,
  unit_price      numeric,
  purchase_cost   numeric,
  qty_on_hand     numeric,
  income_account_ref_id  text,
  income_account_name    text,
  expense_account_ref_id text,
  expense_account_name   text,
  asset_account_ref_id   text,
  asset_account_name     text,
  parent_ref_id   text,
  category_path   text,
  qbo_updated_at  timestamptz,
  synced_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qbo_items_name ON ops.qbo_items(name);
CREATE INDEX IF NOT EXISTS idx_qbo_items_active ON ops.qbo_items(active);

ALTER TABLE ops.qbo_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS qbo_items_read ON ops.qbo_items;
CREATE POLICY qbo_items_read ON ops.qbo_items FOR SELECT USING (true);

GRANT SELECT ON ops.qbo_items TO anon, authenticated;
GRANT ALL ON ops.qbo_items TO service_role;

-- 2. Flat sales-line view: line + parent invoice + item cost in one row
CREATE OR REPLACE VIEW ops.v_sales_lines AS
SELECT
  l.id                AS line_id,
  l.invoice_id,
  i.qbo_invoice_id,
  i.doc_number,
  i.txn_date,
  date_trunc('month', i.txn_date)::date AS txn_month,
  extract(year FROM i.txn_date)::int    AS txn_year,
  i.customer_ref_id,
  i.customer_name,
  i.entity,
  i.department        AS invoice_department,
  l.department        AS line_department,
  l.item_ref_id,
  l.item_name,
  l.revenue_line      AS category,
  l.account_name,
  l.description,
  l.quantity,
  l.unit_price,
  l.amount            AS revenue,
  it.purchase_cost,
  it.type             AS item_type,
  it.income_account_name,
  it.expense_account_name,
  CASE
    WHEN it.purchase_cost IS NOT NULL AND l.quantity IS NOT NULL
      THEN it.purchase_cost * l.quantity
    ELSE NULL
  END                 AS est_cost,
  CASE
    WHEN it.purchase_cost IS NOT NULL AND l.quantity IS NOT NULL
      THEN l.amount - (it.purchase_cost * l.quantity)
    ELSE NULL
  END                 AS est_margin
FROM ops.qbo_invoice_lines l
JOIN ops.qbo_invoices i ON i.id = l.invoice_id
LEFT JOIN ops.qbo_items it ON it.qbo_item_id = l.item_ref_id;

GRANT SELECT ON ops.v_sales_lines TO anon, authenticated;

-- 3. Aggregation RPC: pivot by item / customer / category / month / entity
CREATE OR REPLACE FUNCTION ops.fn_sales_pivot(
  p_dim       text DEFAULT 'item',
  p_start     date DEFAULT '2025-01-01',
  p_end       date DEFAULT current_date,
  p_entity    text DEFAULT NULL,
  p_category  text DEFAULT NULL,
  p_customer  text DEFAULT NULL,
  p_item      text DEFAULT NULL,
  p_limit     int  DEFAULT 200
) RETURNS TABLE (
  dim_label   text,
  line_count  bigint,
  qty         numeric,
  revenue     numeric,
  est_cost    numeric,
  est_margin  numeric,
  margin_pct  numeric,
  avg_price   numeric
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  WITH base AS (
    SELECT *
    FROM ops.v_sales_lines
    WHERE txn_date >= p_start
      AND txn_date <= p_end
      AND (p_entity   IS NULL OR entity = p_entity)
      AND (p_category IS NULL OR category = p_category)
      AND (p_customer IS NULL OR customer_name = p_customer)
      AND (p_item     IS NULL OR item_name = p_item)
  )
  SELECT
    COALESCE(
      CASE p_dim
        WHEN 'item'     THEN item_name
        WHEN 'customer' THEN customer_name
        WHEN 'category' THEN category
        WHEN 'entity'   THEN entity
        WHEN 'month'    THEN to_char(txn_month, 'YYYY-MM')
        WHEN 'invoice_department' THEN invoice_department
        ELSE item_name
      END,
      '(unspecified)'
    )                                                    AS dim_label,
    count(*)::bigint                                     AS line_count,
    sum(quantity)::numeric                               AS qty,
    sum(revenue)::numeric                                AS revenue,
    sum(est_cost)::numeric                               AS est_cost,
    sum(est_margin)::numeric                             AS est_margin,
    CASE WHEN sum(revenue) > 0 AND sum(est_cost) IS NOT NULL
         THEN (sum(revenue) - sum(est_cost)) / sum(revenue)
         ELSE NULL END                                   AS margin_pct,
    CASE WHEN sum(quantity) > 0
         THEN sum(revenue) / sum(quantity)
         ELSE NULL END                                   AS avg_price
  FROM base
  GROUP BY 1
  ORDER BY revenue DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 200), 1);
$$;

GRANT EXECUTE ON FUNCTION ops.fn_sales_pivot(text, date, date, text, text, text, text, int)
  TO anon, authenticated;

-- 4. Per-period totals for headline KPIs
CREATE OR REPLACE FUNCTION ops.fn_sales_totals(
  p_start    date DEFAULT '2025-01-01',
  p_end      date DEFAULT current_date,
  p_entity   text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_customer text DEFAULT NULL,
  p_item     text DEFAULT NULL
) RETURNS TABLE (
  line_count    bigint,
  invoice_count bigint,
  customer_count bigint,
  item_count    bigint,
  qty           numeric,
  revenue       numeric,
  est_cost      numeric,
  est_margin    numeric,
  margin_pct    numeric,
  cost_coverage_pct numeric
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  WITH base AS (
    SELECT *
    FROM ops.v_sales_lines
    WHERE txn_date >= p_start
      AND txn_date <= p_end
      AND (p_entity   IS NULL OR entity = p_entity)
      AND (p_category IS NULL OR category = p_category)
      AND (p_customer IS NULL OR customer_name = p_customer)
      AND (p_item     IS NULL OR item_name = p_item)
  )
  SELECT
    count(*)::bigint,
    count(DISTINCT invoice_id)::bigint,
    count(DISTINCT customer_name)::bigint,
    count(DISTINCT item_name)::bigint,
    sum(quantity)::numeric,
    sum(revenue)::numeric,
    sum(est_cost)::numeric,
    sum(est_margin)::numeric,
    CASE WHEN sum(revenue) > 0 AND sum(est_cost) IS NOT NULL
         THEN (sum(revenue) - sum(est_cost)) / sum(revenue)
         ELSE NULL END,
    CASE WHEN sum(revenue) > 0
         THEN sum(revenue) FILTER (WHERE purchase_cost IS NOT NULL) / sum(revenue)
         ELSE NULL END
  FROM base;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_sales_totals(date, date, text, text, text, text)
  TO anon, authenticated;
