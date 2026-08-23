-- Item sets + product-voids RPC for cross-sell opportunity reporting.
-- Applied to live DB on 2026-05-03.

CREATE TABLE IF NOT EXISTS ops.item_sets (
  set_code   text PRIMARY KEY,
  label      text NOT NULL,
  description text,
  sort_order int NOT NULL DEFAULT 100,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ops.item_set_items (
  set_code     text NOT NULL REFERENCES ops.item_sets(set_code) ON DELETE CASCADE,
  qbo_item_id  text NOT NULL,
  item_name    text,
  sort_order   int NOT NULL DEFAULT 100,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (set_code, qbo_item_id)
);

ALTER TABLE ops.item_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.item_set_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS item_sets_read ON ops.item_sets;
DROP POLICY IF EXISTS item_sets_write ON ops.item_sets;
CREATE POLICY item_sets_read ON ops.item_sets FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY item_sets_write ON ops.item_sets FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.item_sets TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.item_sets TO authenticated;

DROP POLICY IF EXISTS item_set_items_read ON ops.item_set_items;
DROP POLICY IF EXISTS item_set_items_write ON ops.item_set_items;
CREATE POLICY item_set_items_read ON ops.item_set_items FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY item_set_items_write ON ops.item_set_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.item_set_items TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.item_set_items TO authenticated;

CREATE OR REPLACE FUNCTION ops.fn_product_voids(
  p_set_code text, p_start date DEFAULT '2025-01-01', p_end date DEFAULT current_date,
  p_min_set_revenue numeric DEFAULT 0, p_require_some boolean DEFAULT true
) RETURNS TABLE (
  qbo_customer_id text, customer_name text, primary_channel text, primary_sales_rep text,
  qbo_item_id text, item_name text, revenue numeric, qty numeric, has_item boolean,
  customer_set_revenue numeric, customer_set_items_count int, set_total_items int
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH set_items AS (
    SELECT s.qbo_item_id, COALESCE(s.item_name, it.name) AS item_name
    FROM ops.item_set_items s
    LEFT JOIN ops.qbo_items it ON it.qbo_item_id = s.qbo_item_id
    WHERE s.set_code = p_set_code
  ),
  total_items AS (SELECT count(*)::int AS n FROM set_items),
  candidates AS (
    SELECT DISTINCT v.customer_ref_id
    FROM ops.v_sales_lines v JOIN set_items si ON si.qbo_item_id = v.item_ref_id
    WHERE v.txn_date >= p_start AND v.txn_date <= p_end
  ),
  cell AS (
    SELECT c.customer_ref_id, si.qbo_item_id, si.item_name,
      sum(v.revenue)::numeric AS revenue, sum(v.quantity)::numeric AS qty
    FROM candidates c CROSS JOIN set_items si
    LEFT JOIN ops.v_sales_lines v ON v.customer_ref_id = c.customer_ref_id
      AND v.item_ref_id = si.qbo_item_id
      AND v.txn_date >= p_start AND v.txn_date <= p_end
    GROUP BY c.customer_ref_id, si.qbo_item_id, si.item_name
  ),
  cust_summary AS (
    SELECT customer_ref_id, sum(revenue)::numeric AS set_revenue,
      sum(CASE WHEN revenue > 0 THEN 1 ELSE 0 END)::int AS items_bought
    FROM cell GROUP BY 1
  ),
  ch AS (
    SELECT cc.qbo_customer_id, max(c.label) FILTER (WHERE cc.is_primary) AS primary_channel
    FROM ops.customer_channels cc JOIN ops.channels c ON c.channel_code = cc.channel_code AND c.is_active
    GROUP BY 1
  ),
  reps AS (
    SELECT csr.qbo_customer_id, max(r.name) FILTER (WHERE csr.is_primary) AS primary_sales_rep
    FROM ops.customer_sales_reps csr JOIN ops.sales_reps r ON r.rep_code = csr.rep_code AND r.is_active
    GROUP BY 1
  )
  SELECT cell.customer_ref_id, qc.display_name, ch.primary_channel, reps.primary_sales_rep,
    cell.qbo_item_id, cell.item_name,
    COALESCE(cell.revenue, 0), COALESCE(cell.qty, 0), COALESCE(cell.revenue, 0) > 0,
    cs.set_revenue, cs.items_bought, ti.n
  FROM cell
  LEFT JOIN cust_summary cs ON cs.customer_ref_id = cell.customer_ref_id
  LEFT JOIN ops.qbo_customers qc ON qc.qbo_customer_id = cell.customer_ref_id
  LEFT JOIN ch   ON ch.qbo_customer_id   = cell.customer_ref_id
  LEFT JOIN reps ON reps.qbo_customer_id = cell.customer_ref_id
  CROSS JOIN total_items ti
  WHERE cs.set_revenue >= p_min_set_revenue
    AND (NOT p_require_some OR cs.items_bought < ti.n)
    AND qc.active IS NOT FALSE
  ORDER BY cs.set_revenue DESC NULLS LAST, cell.customer_ref_id, cell.item_name;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_product_voids(text, date, date, numeric, boolean) TO anon, authenticated;
