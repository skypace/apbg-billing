-- Slice U: co-purchase basket analytics + revenue anomaly detection.
--   ops.fn_item_copurchase(anchor_id, start, end, min_support, limit)
--     Apriori-style: co-occurrence on the same invoice. Returns
--     pair_invoices, support, confidence (a→b and b→a), and lift.
--     Used by Item-Sets editor to suggest companion items to add.
--
--   ops.fn_revenue_anomalies(baseline_months, recent_months,
--                            min_baseline, sigma_threshold)
--     For each customer, compute baseline avg/stddev over baseline_months
--     and recent avg over recent_months. Flag those whose recent z-score
--     |x-mean|/stddev exceeds threshold. Direction = 'spike' | 'drop'.
-- Applied to live DB on 2026-05-03 as migration "copurchase_anomaly".

CREATE OR REPLACE FUNCTION ops.fn_item_copurchase(
  p_anchor_item_id text DEFAULT NULL,
  p_start          date DEFAULT (current_date - 365),
  p_end            date DEFAULT current_date,
  p_min_support    int  DEFAULT 5,
  p_limit          int  DEFAULT 100
) RETURNS TABLE (
  item_a_id text, item_a_name text,
  item_b_id text, item_b_name text,
  pair_invoices int,
  item_a_invoices int, item_b_invoices int,
  total_invoices int,
  support  numeric,
  confidence_a_to_b numeric,
  confidence_b_to_a numeric,
  lift     numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH inv_items AS (
    SELECT DISTINCT v.invoice_id, v.item_ref_id, v.item_name
    FROM ops.v_sales_lines v
    WHERE v.txn_date BETWEEN p_start AND p_end
      AND v.item_ref_id IS NOT NULL
  ),
  total AS (
    SELECT count(DISTINCT invoice_id)::int AS n FROM inv_items
  ),
  per_item AS (
    SELECT item_ref_id, item_name, count(DISTINCT invoice_id)::int AS n
    FROM inv_items GROUP BY 1, 2
  ),
  pairs AS (
    SELECT a.item_ref_id AS a_id, a.item_name AS a_name,
           b.item_ref_id AS b_id, b.item_name AS b_name,
           count(DISTINCT a.invoice_id)::int AS pair_n
    FROM inv_items a
    JOIN inv_items b ON a.invoice_id = b.invoice_id AND a.item_ref_id < b.item_ref_id
    WHERE (p_anchor_item_id IS NULL OR a.item_ref_id = p_anchor_item_id OR b.item_ref_id = p_anchor_item_id)
    GROUP BY 1,2,3,4
    HAVING count(DISTINCT a.invoice_id) >= p_min_support
  ),
  scored AS (
    SELECT
      p.a_id, p.a_name, p.b_id, p.b_name,
      p.pair_n,
      pa.n AS pa_n, pb.n AS pb_n,
      (SELECT n FROM total) AS total_n,
      (p.pair_n::numeric / NULLIF((SELECT n FROM total), 0))::numeric AS support,
      (p.pair_n::numeric / NULLIF(pa.n, 0))::numeric AS conf_ab,
      (p.pair_n::numeric / NULLIF(pb.n, 0))::numeric AS conf_ba,
      ((p.pair_n::numeric / NULLIF((SELECT n FROM total), 0)) /
       NULLIF((pa.n::numeric / NULLIF((SELECT n FROM total), 0)) *
              (pb.n::numeric / NULLIF((SELECT n FROM total), 0)), 0))::numeric AS lift_v
    FROM pairs p
    JOIN per_item pa ON pa.item_ref_id = p.a_id
    JOIN per_item pb ON pb.item_ref_id = p.b_id
  )
  SELECT a_id, a_name, b_id, b_name, pair_n, pa_n, pb_n, total_n, support, conf_ab, conf_ba, lift_v
  FROM scored
  ORDER BY pair_n DESC, lift_v DESC NULLS LAST
  LIMIT p_limit;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_item_copurchase(text, date, date, int, int) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_revenue_anomalies(
  p_baseline_months int     DEFAULT 6,
  p_recent_months   int     DEFAULT 1,
  p_min_baseline    numeric DEFAULT 500,
  p_sigma_threshold numeric DEFAULT 2.0
) RETURNS TABLE (
  qbo_customer_id   text,
  customer_name     text,
  primary_channel   text,
  primary_sales_rep text,
  baseline_avg      numeric,
  baseline_stddev   numeric,
  recent_avg        numeric,
  z_score           numeric,
  delta_pct         numeric,
  direction         text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH monthly AS (
    SELECT v.customer_ref_id,
           date_trunc('month', v.txn_date)::date AS m,
           sum(v.revenue)::numeric AS rev
    FROM ops.v_sales_lines v
    WHERE v.txn_date >= date_trunc('month', current_date) - ((p_baseline_months + p_recent_months) || ' months')::interval
      AND v.txn_date <  date_trunc('month', current_date)
    GROUP BY 1, 2
  ),
  agg AS (
    SELECT customer_ref_id,
      avg(rev) FILTER (WHERE m <  date_trunc('month', current_date) - (p_recent_months || ' months')::interval) AS base_avg,
      stddev_samp(rev) FILTER (WHERE m <  date_trunc('month', current_date) - (p_recent_months || ' months')::interval) AS base_sd,
      avg(rev) FILTER (WHERE m >= date_trunc('month', current_date) - (p_recent_months || ' months')::interval) AS rec_avg
    FROM monthly
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
  SELECT a.customer_ref_id,
    qc.display_name,
    ch.primary_channel,
    reps.primary_sales_rep,
    COALESCE(a.base_avg, 0)::numeric,
    COALESCE(a.base_sd, 0)::numeric,
    COALESCE(a.rec_avg, 0)::numeric,
    CASE WHEN COALESCE(a.base_sd, 0) > 0
         THEN ((COALESCE(a.rec_avg, 0) - COALESCE(a.base_avg, 0)) / a.base_sd)::numeric
         ELSE NULL END,
    CASE WHEN COALESCE(a.base_avg, 0) > 0
         THEN ((COALESCE(a.rec_avg, 0) - a.base_avg) / a.base_avg)::numeric
         ELSE NULL END,
    CASE WHEN COALESCE(a.rec_avg, 0) > COALESCE(a.base_avg, 0) THEN 'spike' ELSE 'drop' END
  FROM agg a
  LEFT JOIN ops.qbo_customers qc ON qc.qbo_customer_id = a.customer_ref_id
  LEFT JOIN ch   ON ch.qbo_customer_id = a.customer_ref_id
  LEFT JOIN reps ON reps.qbo_customer_id = a.customer_ref_id
  WHERE COALESCE(a.base_avg, 0) >= p_min_baseline
    AND COALESCE(a.base_sd, 0)  > 0
    AND ABS((COALESCE(a.rec_avg, 0) - a.base_avg) / a.base_sd) >= p_sigma_threshold
  ORDER BY ABS((COALESCE(a.rec_avg, 0) - a.base_avg) / a.base_sd) DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_revenue_anomalies(int, int, numeric, numeric) TO anon, authenticated;
