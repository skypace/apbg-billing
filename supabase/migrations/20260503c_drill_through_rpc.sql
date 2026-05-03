-- Drill-through: returns the invoice lines contributing to a single pivot row.
-- Applied to live DB on 2026-05-03.

CREATE OR REPLACE FUNCTION ops.fn_pivot_drill(
  p_dim          text,
  p_dim_label    text,
  p_start        date   DEFAULT '2025-01-01',
  p_end          date   DEFAULT current_date,
  p_entities     text[] DEFAULT NULL,
  p_categories   text[] DEFAULT NULL,
  p_customers    text[] DEFAULT NULL,
  p_items        text[] DEFAULT NULL,
  p_channels     text[] DEFAULT NULL,
  p_segments     text[] DEFAULT NULL,
  p_limit        int    DEFAULT 200
) RETURNS TABLE (
  txn_date       date,
  doc_number     text,
  qbo_invoice_id text,
  customer_name  text,
  item_name      text,
  category       text,
  segment        text,
  description    text,
  quantity       numeric,
  unit_price     numeric,
  revenue        numeric,
  est_cost       numeric,
  est_margin     numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  SELECT v.txn_date, v.doc_number, v.qbo_invoice_id, v.customer_name,
    v.item_name, v.category, v.segment, v.description,
    v.quantity, v.unit_price, v.revenue, v.est_cost, v.est_margin
  FROM ops.v_sales_lines v
  WHERE v.txn_date >= p_start AND v.txn_date <= p_end
    AND (p_entities   IS NULL OR cardinality(p_entities)   = 0 OR v.entity        = ANY(p_entities))
    AND (p_categories IS NULL OR cardinality(p_categories) = 0 OR v.category      = ANY(p_categories))
    AND (p_customers  IS NULL OR cardinality(p_customers)  = 0 OR v.customer_name = ANY(p_customers))
    AND (p_items      IS NULL OR cardinality(p_items)      = 0 OR v.item_name     = ANY(p_items))
    AND (p_channels   IS NULL OR cardinality(p_channels)   = 0 OR v.channels && p_channels)
    AND (p_segments   IS NULL OR cardinality(p_segments)   = 0 OR v.segment       = ANY(p_segments))
    AND (
      p_dim IS NULL OR p_dim_label IS NULL OR p_dim_label = '(unspecified)'
      OR (p_dim = 'item'     AND v.item_name     = p_dim_label)
      OR (p_dim = 'customer' AND v.customer_name = p_dim_label)
      OR (p_dim = 'category' AND v.category      = p_dim_label)
      OR (p_dim = 'segment'  AND v.segment       = p_dim_label)
      OR (p_dim = 'entity'   AND v.entity        = p_dim_label)
      OR (p_dim = 'month'    AND to_char(v.txn_month, 'YYYY-MM') = p_dim_label)
      OR (p_dim = 'channel'  AND (
            p_dim_label = '(unassigned)' AND cardinality(v.channels) = 0
            OR p_dim_label = ANY(v.channels)
         ))
    )
  ORDER BY v.revenue DESC NULLS LAST, v.txn_date DESC
  LIMIT GREATEST(COALESCE(p_limit, 200), 1);
$$;
GRANT EXECUTE ON FUNCTION ops.fn_pivot_drill(text, text, date, date, text[], text[], text[], text[], text[], text[], int) TO anon, authenticated;
