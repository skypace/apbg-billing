-- Customer scorecard upgrade.
--
-- Make the customer scorecard useful as an operating readout, not just a
-- printable RFM summary. Future-dated invoices are surfaced separately and no
-- longer make recency negative.

CREATE OR REPLACE FUNCTION ops.fn_customer_health(p_window_days integer DEFAULT 365)
RETURNS TABLE(
  qbo_customer_id text,
  customer_name text,
  primary_channel text,
  recency_days integer,
  frequency integer,
  monetary numeric,
  r_score integer,
  f_score integer,
  m_score integer,
  rfm_total integer,
  rfm_segment text,
  last_invoice_date date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
  WITH params AS (
    SELECT GREATEST(COALESCE(p_window_days, 365), 1) AS days
  ),
  stats AS (
    SELECT
      v.customer_ref_id,
      max(v.txn_date) AS last_date,
      count(DISTINCT v.invoice_id)::int AS frequency,
      sum(v.revenue)::numeric AS monetary
    FROM ops.v_sales_lines v, params p
    WHERE v.txn_date >= current_date - p.days
      AND v.txn_date <= current_date
      AND v.customer_ref_id IS NOT NULL
    GROUP BY 1
  ),
  scored AS (
    SELECT
      *,
      GREATEST((current_date - last_date)::int, 0) AS recency_days,
      ntile(5) OVER (ORDER BY GREATEST((current_date - last_date)::int, 0) DESC) AS r_score,
      ntile(5) OVER (ORDER BY frequency ASC) AS f_score,
      ntile(5) OVER (ORDER BY monetary ASC) AS m_score
    FROM stats
  ),
  ch AS (
    SELECT
      cc.qbo_customer_id,
      max(c.label) FILTER (WHERE cc.is_primary) AS primary_channel
    FROM ops.customer_channels cc
    JOIN ops.channels c ON c.channel_code = cc.channel_code AND c.is_active
    GROUP BY 1
  )
  SELECT
    s.customer_ref_id,
    qc.display_name,
    ch.primary_channel,
    s.recency_days,
    s.frequency,
    s.monetary,
    s.r_score::int,
    s.f_score::int,
    s.m_score::int,
    (s.r_score + s.f_score + s.m_score)::int,
    CASE
      WHEN s.r_score >= 4 AND s.f_score >= 4 AND s.m_score >= 4 THEN 'Champion'
      WHEN s.r_score >= 3 AND s.f_score >= 3 AND s.m_score >= 4 THEN 'Loyal'
      WHEN s.r_score >= 4 AND s.f_score <= 2                    THEN 'New / Potential'
      WHEN s.r_score <= 2 AND s.m_score >= 4                    THEN 'At Risk — High Value'
      WHEN s.r_score <= 2 AND s.f_score >= 4                    THEN 'At Risk'
      WHEN s.r_score <= 2 AND s.f_score <= 2                    THEN 'Lost / Hibernating'
      ELSE 'Average'
    END,
    s.last_date
  FROM scored s
  LEFT JOIN ops.qbo_customers qc ON qc.qbo_customer_id = s.customer_ref_id
  LEFT JOIN ch ON ch.qbo_customer_id = s.customer_ref_id
  WHERE qc.active IS NOT FALSE
  ORDER BY (s.r_score + s.f_score + s.m_score) DESC, s.monetary DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_customer_health(integer) TO anon, authenticated;

DROP FUNCTION IF EXISTS ops.fn_customer_scorecard(text, integer);

CREATE FUNCTION ops.fn_customer_scorecard(
  p_qbo_customer_id text,
  p_window_days integer DEFAULT 365
)
RETURNS TABLE(
  qbo_customer_id text,
  customer_name text,
  primary_channel text,
  rfm_segment text,
  rfm_total integer,
  r_score integer,
  f_score integer,
  m_score integer,
  recency_days integer,
  frequency integer,
  monetary numeric,
  ytd_revenue numeric,
  prior_year_revenue numeric,
  total_invoices integer,
  avg_order_value numeric,
  est_margin numeric,
  est_margin_pct numeric,
  top_item_name text,
  top_item_revenue numeric,
  last_invoice_date date,
  first_invoice_date date,
  bill_state text,
  bill_city text,
  active boolean,
  customer_type_name text,
  window_revenue numeric,
  prior_window_revenue numeric,
  window_revenue_delta_pct numeric,
  prior_ytd_revenue numeric,
  ytd_revenue_delta_pct numeric,
  cost_coverage_pct numeric,
  top_item_share_pct numeric,
  ar_balance numeric,
  ar_overdue numeric,
  ar_90_plus numeric,
  open_invoice_count integer,
  days_oldest_overdue integer,
  future_invoice_count integer,
  future_revenue numeric,
  future_last_invoice_date date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
  WITH params AS (
    SELECT GREATEST(COALESCE(p_window_days, 365), 1) AS days
  ),
  window_lines AS (
    SELECT v.*
    FROM ops.v_sales_lines v, params p
    WHERE v.customer_ref_id = p_qbo_customer_id
      AND v.txn_date >= current_date - p.days
      AND v.txn_date <= current_date
  ),
  prior_window_lines AS (
    SELECT v.*
    FROM ops.v_sales_lines v, params p
    WHERE v.customer_ref_id = p_qbo_customer_id
      AND v.txn_date >= current_date - (p.days * 2)
      AND v.txn_date < current_date - p.days
  ),
  ytd_lines AS (
    SELECT *
    FROM ops.v_sales_lines
    WHERE customer_ref_id = p_qbo_customer_id
      AND txn_date >= date_trunc('year', current_date)::date
      AND txn_date <= current_date
  ),
  prior_ytd_lines AS (
    SELECT *
    FROM ops.v_sales_lines
    WHERE customer_ref_id = p_qbo_customer_id
      AND txn_date >= date_trunc('year', current_date - interval '1 year')::date
      AND txn_date <= (current_date - interval '1 year')::date
  ),
  prior_year_lines AS (
    SELECT *
    FROM ops.v_sales_lines
    WHERE customer_ref_id = p_qbo_customer_id
      AND txn_date >= date_trunc('year', current_date - interval '1 year')::date
      AND txn_date < date_trunc('year', current_date)::date
  ),
  future_lines AS (
    SELECT *
    FROM ops.v_sales_lines
    WHERE customer_ref_id = p_qbo_customer_id
      AND txn_date > current_date
  ),
  all_lines AS (
    SELECT *
    FROM ops.v_sales_lines
    WHERE customer_ref_id = p_qbo_customer_id
  ),
  window_summary AS (
    SELECT
      COALESCE(sum(revenue), 0)::numeric AS revenue,
      COALESCE(sum(est_margin), 0)::numeric AS est_margin,
      count(DISTINCT invoice_id)::int AS invoices,
      COALESCE(sum(abs(revenue)), 0)::numeric AS abs_revenue,
      COALESCE(sum(abs(revenue)) FILTER (WHERE est_cost IS NOT NULL), 0)::numeric AS costed_abs_revenue
    FROM window_lines
  ),
  top_item AS (
    SELECT
      item_name,
      sum(revenue)::numeric AS revenue
    FROM window_lines
    WHERE item_name IS NOT NULL
    GROUP BY 1
    ORDER BY sum(revenue) DESC NULLS LAST
    LIMIT 1
  ),
  ar AS (
    SELECT
      COALESCE(sum(balance), 0)::numeric AS ar_balance,
      COALESCE(sum(balance) FILTER (WHERE due_date < current_date), 0)::numeric AS ar_overdue,
      COALESCE(sum(balance) FILTER (WHERE current_date - due_date > 90), 0)::numeric AS ar_90_plus,
      count(*) FILTER (WHERE balance > 0)::int AS open_invoice_count,
      max(current_date - due_date) FILTER (WHERE balance > 0 AND due_date < current_date)::int AS days_oldest_overdue
    FROM ops.qbo_invoices
    WHERE customer_ref_id = p_qbo_customer_id
      AND balance > 0
  ),
  future AS (
    SELECT
      count(DISTINCT invoice_id)::int AS future_invoice_count,
      COALESCE(sum(revenue), 0)::numeric AS future_revenue,
      max(txn_date) AS future_last_invoice_date
    FROM future_lines
  ),
  health AS (
    SELECT *
    FROM ops.fn_customer_health((SELECT days FROM params))
    WHERE qbo_customer_id = p_qbo_customer_id
  )
  SELECT
    p_qbo_customer_id,
    qc.display_name,
    h.primary_channel,
    h.rfm_segment,
    h.rfm_total,
    h.r_score,
    h.f_score,
    h.m_score,
    h.recency_days,
    h.frequency,
    h.monetary,
    COALESCE((SELECT sum(revenue) FROM ytd_lines), 0)::numeric AS ytd_revenue,
    COALESCE((SELECT sum(revenue) FROM prior_year_lines), 0)::numeric AS prior_year_revenue,
    ws.invoices AS total_invoices,
    CASE WHEN ws.invoices > 0 THEN ws.revenue / ws.invoices ELSE 0 END::numeric AS avg_order_value,
    ws.est_margin,
    CASE WHEN ws.revenue <> 0 THEN ws.est_margin / ws.revenue ELSE NULL END::numeric AS est_margin_pct,
    ti.item_name,
    ti.revenue,
    (SELECT max(txn_date) FROM all_lines WHERE txn_date <= current_date) AS last_invoice_date,
    (SELECT min(txn_date) FROM all_lines) AS first_invoice_date,
    qc.bill_addr_state,
    qc.bill_addr_city,
    qc.active,
    qc.customer_type_name,
    ws.revenue AS window_revenue,
    COALESCE((SELECT sum(revenue) FROM prior_window_lines), 0)::numeric AS prior_window_revenue,
    CASE
      WHEN COALESCE((SELECT sum(revenue) FROM prior_window_lines), 0) <> 0
        THEN (ws.revenue - (SELECT sum(revenue) FROM prior_window_lines)) / abs((SELECT sum(revenue) FROM prior_window_lines))
      ELSE NULL
    END::numeric AS window_revenue_delta_pct,
    COALESCE((SELECT sum(revenue) FROM prior_ytd_lines), 0)::numeric AS prior_ytd_revenue,
    CASE
      WHEN COALESCE((SELECT sum(revenue) FROM prior_ytd_lines), 0) <> 0
        THEN (COALESCE((SELECT sum(revenue) FROM ytd_lines), 0) - (SELECT sum(revenue) FROM prior_ytd_lines)) / abs((SELECT sum(revenue) FROM prior_ytd_lines))
      ELSE NULL
    END::numeric AS ytd_revenue_delta_pct,
    CASE WHEN ws.abs_revenue <> 0 THEN ws.costed_abs_revenue / ws.abs_revenue ELSE NULL END::numeric AS cost_coverage_pct,
    CASE WHEN ws.revenue <> 0 AND ti.revenue IS NOT NULL THEN ti.revenue / ws.revenue ELSE NULL END::numeric AS top_item_share_pct,
    ar.ar_balance,
    ar.ar_overdue,
    ar.ar_90_plus,
    ar.open_invoice_count,
    ar.days_oldest_overdue,
    future.future_invoice_count,
    future.future_revenue,
    future.future_last_invoice_date
  FROM ops.qbo_customers qc
  CROSS JOIN window_summary ws
  CROSS JOIN ar
  CROSS JOIN future
  LEFT JOIN top_item ti ON true
  LEFT JOIN health h ON h.qbo_customer_id = p_qbo_customer_id
  WHERE qc.qbo_customer_id = p_qbo_customer_id;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_customer_scorecard(text, integer) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
