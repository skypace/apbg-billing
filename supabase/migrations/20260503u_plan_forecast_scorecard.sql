-- Slice V: full-year plan projection + per-customer scorecard rollup.
--   ops.fn_plan_forecast(plan_id)
--     Linear projection: ytd_actual / months_complete * 12.
--     Returns projected_full_year, full_year_plan, projected_vs_plan_pct,
--     and a status bucket: ahead / on_track / behind / critical.
--
--   ops.fn_customer_scorecard(qbo_customer_id, window_days)
--     Single-row rollup with everything needed for a printable
--     scorecard one-pager: RFM, channel, rep, YTD vs prior, AOV, margin,
--     top item, last/first invoice dates, address.
-- Applied to live DB on 2026-05-03 as migration "plan_forecast".

CREATE OR REPLACE FUNCTION ops.fn_plan_forecast(p_plan_id uuid)
RETURNS TABLE (
  line_id uuid, item_name text, account_name text,
  full_year_plan numeric,
  ytd_plan numeric, ytd_actual numeric,
  months_complete int,
  projected_full_year numeric,
  projected_vs_plan_pct numeric,
  status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH plan_meta AS (
    SELECT fiscal_year FROM ops.sales_plans WHERE id = p_plan_id
  ),
  elapsed AS (
    SELECT CASE
             WHEN extract(year FROM current_date)::int = (SELECT fiscal_year FROM plan_meta) THEN extract(month FROM current_date)::int - 1
             WHEN extract(year FROM current_date)::int >  (SELECT fiscal_year FROM plan_meta) THEN 12
             ELSE 0
           END AS m
  ),
  lines AS (
    SELECT l.id, l.item_name, COALESCE(l.account_name, it.income_account_name) AS account_name,
           l.amounts, l.qbo_item_id
    FROM ops.sales_plan_lines l
    LEFT JOIN ops.qbo_items it ON it.qbo_item_id = l.qbo_item_id
    WHERE l.plan_id = p_plan_id
  ),
  totals AS (
    SELECT id, item_name, account_name, qbo_item_id,
           (SELECT sum(amounts[i]) FROM generate_series(1, 12) i)::numeric AS full_year,
           (SELECT sum(amounts[i]) FROM generate_series(1, GREATEST((SELECT m FROM elapsed), 1)) i)::numeric AS ytd
    FROM lines
  ),
  ytd_actual AS (
    SELECT v.item_name AS item_name, sum(v.revenue)::numeric AS amt
    FROM ops.v_sales_lines v
    WHERE v.txn_date >= ((SELECT fiscal_year FROM plan_meta) || '-01-01')::date
      AND v.txn_date <  date_trunc('month', current_date)::date
    GROUP BY 1
  )
  SELECT t.id, t.item_name, t.account_name,
    COALESCE(t.full_year, 0),
    COALESCE(t.ytd, 0),
    COALESCE(ya.amt, 0),
    (SELECT m FROM elapsed),
    CASE WHEN (SELECT m FROM elapsed) > 0
         THEN (COALESCE(ya.amt, 0) * 12.0 / (SELECT m FROM elapsed))::numeric
         ELSE NULL END,
    CASE WHEN COALESCE(t.full_year, 0) > 0 AND (SELECT m FROM elapsed) > 0
         THEN ((COALESCE(ya.amt, 0) * 12.0 / (SELECT m FROM elapsed)) - t.full_year) / t.full_year
         ELSE NULL END,
    CASE
      WHEN COALESCE(t.full_year, 0) <= 0 OR (SELECT m FROM elapsed) <= 0 THEN 'no_data'
      WHEN ((COALESCE(ya.amt, 0) * 12.0 / (SELECT m FROM elapsed)) - t.full_year) / t.full_year >=  0.05 THEN 'ahead'
      WHEN ((COALESCE(ya.amt, 0) * 12.0 / (SELECT m FROM elapsed)) - t.full_year) / t.full_year <= -0.20 THEN 'critical'
      WHEN ((COALESCE(ya.amt, 0) * 12.0 / (SELECT m FROM elapsed)) - t.full_year) / t.full_year <= -0.05 THEN 'behind'
      ELSE 'on_track'
    END
  FROM totals t
  LEFT JOIN ytd_actual ya ON ya.item_name = t.item_name
  WHERE COALESCE(t.full_year, 0) > 0
  ORDER BY ((COALESCE(ya.amt, 0) * 12.0 / NULLIF((SELECT m FROM elapsed), 0)) - t.full_year) ASC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_plan_forecast(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_customer_scorecard(
  p_qbo_customer_id text,
  p_window_days     int DEFAULT 365
) RETURNS TABLE (
  qbo_customer_id text, customer_name text,
  primary_channel text, primary_sales_rep text,
  rfm_segment text, rfm_total int, r_score int, f_score int, m_score int,
  recency_days int, frequency int, monetary numeric,
  ytd_revenue numeric, prior_year_revenue numeric,
  total_invoices int, avg_order_value numeric,
  est_margin numeric, est_margin_pct numeric,
  top_item_name text, top_item_revenue numeric,
  last_invoice_date date, first_invoice_date date,
  bill_state text, bill_city text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH window_lines AS (
    SELECT * FROM ops.v_sales_lines
    WHERE customer_ref_id = p_qbo_customer_id
      AND txn_date >= current_date - p_window_days
  ),
  ytd_lines AS (
    SELECT * FROM ops.v_sales_lines
    WHERE customer_ref_id = p_qbo_customer_id
      AND txn_date >= date_trunc('year', current_date)::date
  ),
  prior_lines AS (
    SELECT * FROM ops.v_sales_lines
    WHERE customer_ref_id = p_qbo_customer_id
      AND txn_date >= date_trunc('year', current_date - interval '1 year')::date
      AND txn_date <  date_trunc('year', current_date)::date
  ),
  all_lines AS (
    SELECT * FROM ops.v_sales_lines
    WHERE customer_ref_id = p_qbo_customer_id
  ),
  top_item AS (
    SELECT item_name, sum(revenue)::numeric AS revenue
    FROM window_lines
    WHERE item_name IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 1
  ),
  health AS (
    SELECT * FROM ops.fn_customer_health(p_window_days)
    WHERE qbo_customer_id = p_qbo_customer_id
  )
  SELECT
    p_qbo_customer_id,
    qc.display_name,
    h.primary_channel, h.primary_sales_rep,
    h.rfm_segment, h.rfm_total, h.r_score, h.f_score, h.m_score,
    h.recency_days, h.frequency, h.monetary,
    COALESCE((SELECT sum(revenue) FROM ytd_lines), 0)::numeric,
    COALESCE((SELECT sum(revenue) FROM prior_lines), 0)::numeric,
    COALESCE((SELECT count(DISTINCT invoice_id) FROM window_lines)::int, 0),
    CASE WHEN (SELECT count(DISTINCT invoice_id) FROM window_lines) > 0
         THEN ((SELECT sum(revenue) FROM window_lines) / (SELECT count(DISTINCT invoice_id) FROM window_lines))::numeric
         ELSE 0 END,
    COALESCE((SELECT sum(est_margin) FROM window_lines), 0)::numeric,
    CASE WHEN COALESCE((SELECT sum(revenue) FROM window_lines), 0) > 0
         THEN ((SELECT sum(est_margin) FROM window_lines)::numeric / (SELECT sum(revenue) FROM window_lines))::numeric
         ELSE NULL END,
    (SELECT item_name FROM top_item),
    (SELECT revenue FROM top_item),
    (SELECT max(txn_date) FROM all_lines),
    (SELECT min(txn_date) FROM all_lines),
    qc.bill_addr_state, qc.bill_addr_city
  FROM ops.qbo_customers qc
  LEFT JOIN health h ON h.qbo_customer_id = p_qbo_customer_id
  WHERE qc.qbo_customer_id = p_qbo_customer_id;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_customer_scorecard(text, int) TO anon, authenticated;
