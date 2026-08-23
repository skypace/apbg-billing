-- Reports preset RPCs:
--   fn_inactive_customers — customers with prior-period revenue and ~zero current
--   fn_top_movers — biggest absolute Δ revenue between two periods, by dim
-- Applied to live DB on 2026-05-03.

CREATE OR REPLACE FUNCTION ops.fn_inactive_customers(
  p_current_start date, p_current_end date,
  p_prior_start   date, p_prior_end   date,
  p_min_prior_rev numeric DEFAULT 1000,
  p_max_current_rev numeric DEFAULT 0,
  p_limit int DEFAULT 200
) RETURNS TABLE (
  qbo_customer_id text, customer_name text,
  prior_revenue numeric, current_revenue numeric,
  last_invoice_date date,
  primary_channel text, primary_sales_rep text, bill_state text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH cur AS (
    SELECT customer_ref_id, sum(revenue)::numeric AS rev, max(txn_date) AS last_date
    FROM ops.v_sales_lines
    WHERE txn_date >= p_current_start AND txn_date <= p_current_end
    GROUP BY 1
  ),
  prior AS (
    SELECT customer_ref_id, sum(revenue)::numeric AS rev, max(txn_date) AS last_date
    FROM ops.v_sales_lines
    WHERE txn_date >= p_prior_start AND txn_date <= p_prior_end
    GROUP BY 1
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
  SELECT p.customer_ref_id, qc.display_name,
    p.rev, COALESCE(c.rev, 0), GREATEST(c.last_date, p.last_date),
    ch.primary_channel, reps.primary_sales_rep, qc.bill_addr_state
  FROM prior p
  LEFT JOIN cur c ON c.customer_ref_id = p.customer_ref_id
  LEFT JOIN ops.qbo_customers qc ON qc.qbo_customer_id = p.customer_ref_id
  LEFT JOIN ch ON ch.qbo_customer_id = p.customer_ref_id
  LEFT JOIN reps ON reps.qbo_customer_id = p.customer_ref_id
  WHERE p.rev >= p_min_prior_rev
    AND COALESCE(c.rev, 0) <= p_max_current_rev
    AND qc.active IS NOT FALSE
  ORDER BY p.rev DESC
  LIMIT GREATEST(COALESCE(p_limit, 200), 1);
$$;
GRANT EXECUTE ON FUNCTION ops.fn_inactive_customers(date, date, date, date, numeric, numeric, int) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_top_movers(
  p_dim text DEFAULT 'customer',
  p_start date DEFAULT NULL, p_end date DEFAULT current_date,
  p_prev_start date DEFAULT NULL, p_prev_end date DEFAULT NULL,
  p_limit int DEFAULT 200
) RETURNS TABLE (
  dim_label text, current_rev numeric, prior_rev numeric,
  delta_rev numeric, delta_pct numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH cur AS (
    SELECT COALESCE(CASE p_dim
      WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
      WHEN 'category' THEN category WHEN 'segment' THEN segment
      WHEN 'entity' THEN entity ELSE customer_name END, '(unspecified)') AS dim_label,
      sum(revenue)::numeric AS rev
    FROM ops.v_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
    GROUP BY 1
  ),
  prev AS (
    SELECT COALESCE(CASE p_dim
      WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
      WHEN 'category' THEN category WHEN 'segment' THEN segment
      WHEN 'entity' THEN entity ELSE customer_name END, '(unspecified)') AS dim_label,
      sum(revenue)::numeric AS rev
    FROM ops.v_sales_lines
    WHERE p_prev_start IS NOT NULL AND p_prev_end IS NOT NULL
      AND txn_date >= p_prev_start AND txn_date <= p_prev_end
    GROUP BY 1
  )
  SELECT COALESCE(c.dim_label, p.dim_label),
    COALESCE(c.rev, 0), COALESCE(p.rev, 0),
    COALESCE(c.rev, 0) - COALESCE(p.rev, 0),
    CASE WHEN p.rev IS NOT NULL AND p.rev <> 0
         THEN (COALESCE(c.rev, 0) - p.rev) / p.rev ELSE NULL END
  FROM cur c FULL OUTER JOIN prev p ON p.dim_label = c.dim_label
  ORDER BY ABS(COALESCE(c.rev, 0) - COALESCE(p.rev, 0)) DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 200), 1);
$$;
GRANT EXECUTE ON FUNCTION ops.fn_top_movers(text, date, date, date, date, int) TO anon, authenticated;
