-- §12 #5 — drop the rep taxonomy tables and rebuild every RPC that
-- referenced them. Sales-rep attribution is fundamentally 1:1-at-a-time
-- in real B2B operations; modeling it as M:N (sales_reps × customers via
-- customer_sales_reps junction) was over-engineered. Audit on 2026-05-05
-- showed 0/790 customers had any rep mapping in production. Apbg-ops
-- audit on the same date returned zero references to the rep schema in
-- its codebase or migrations.
--
-- When rep attribution becomes a real KPI, the right shape is a single
-- column on ops.qbo_customers (e.g. current_rep_code) plus a separate
-- customer_rep_history SCD table for historical changes. That work is
-- deferred until somebody actually needs it.
--
-- This migration:
--   1. Drops fn_rep_book, fn_rep_scorecard, fn_set_customer_sales_reps
--      entirely (purely rep-focused; no replacement).
--   2. Drops + recreates every RPC whose RETURN TABLE included
--      primary_sales_rep / all_sales_reps. Those columns are removed
--      from the return shapes; the bodies no longer join the rep tables.
--   3. Drops fn_sales_stacked (its signature includes p_sales_reps and
--      its body references the 'sales_rep' dim) and recreates it without
--      either.
--   4. Drops the view ops.v_sales_lines and recreates it without the
--      sales_reps[] / primary_sales_rep columns or the LATERAL join to
--      the rep tables.
--   5. Drops ops.commission_rules, ops.customer_sales_reps,
--      ops.sales_reps in dependency order.
--
-- Cross-repo coordination: apbg-ops verified clean on 2026-05-05 round 2.

-- ------------------------------------------------------------------
-- 1. Drop functions whose entire purpose was rep performance.
DROP FUNCTION IF EXISTS ops.fn_rep_book(text, date, date);
DROP FUNCTION IF EXISTS ops.fn_rep_scorecard(date, date);
DROP FUNCTION IF EXISTS ops.fn_set_customer_sales_reps(text, text[], text, text);

-- ------------------------------------------------------------------
-- 2. Drop functions whose RETURN TABLE shape needs to change. Postgres
-- requires drop-and-recreate for OUT-parameter (RETURNS TABLE) changes;
-- CREATE OR REPLACE preserves the existing column list.
DROP FUNCTION IF EXISTS ops.fn_customer_detail(text, date, date);
DROP FUNCTION IF EXISTS ops.fn_customer_health(int);
DROP FUNCTION IF EXISTS ops.fn_customer_health_asof(date, int);
DROP FUNCTION IF EXISTS ops.fn_inactive_customers(date, date, date, date, numeric, numeric, int);
DROP FUNCTION IF EXISTS ops.fn_product_voids(text, date, date, numeric, boolean);
DROP FUNCTION IF EXISTS ops.fn_revenue_anomalies(int, int, numeric, numeric);
DROP FUNCTION IF EXISTS ops.fn_customer_scorecard(text, int);
DROP FUNCTION IF EXISTS ops.fn_sales_stacked(text, text, date, date, text[], text[], text[], text[], text[], text[], text[], int);

-- ------------------------------------------------------------------
-- 3. Drop the view (must come before dropping the tables it joins).
DROP VIEW IF EXISTS ops.v_sales_lines;

-- ------------------------------------------------------------------
-- 4. Drop the rep tables in dependency order.
DROP TABLE IF EXISTS ops.commission_rules;
DROP TABLE IF EXISTS ops.customer_sales_reps;
DROP TABLE IF EXISTS ops.sales_reps;

-- ==================================================================
-- Recreate the view without rep columns / joins.
-- Same canonical form as 20260505a; this is the rep-free version.
-- ==================================================================
CREATE VIEW ops.v_sales_lines AS
WITH effective AS (
  SELECT l.id,
         l.invoice_id,
         l.item_ref_id,
         l.item_name,
         l.revenue_line,
         l.account_name,
         l.description,
         l.quantity,
         l.unit_price,
         l.amount,
         l.department,
         it.purchase_cost                            AS static_unit_cost,
         ac.avg_unit_cost                            AS actual_unit_cost,
         COALESCE(ac.avg_unit_cost, it.purchase_cost) AS effective_unit_cost,
         CASE
           WHEN ac.avg_unit_cost  IS NOT NULL THEN 'actual'
           WHEN it.purchase_cost  IS NOT NULL THEN 'static'
           ELSE 'none'
         END                                          AS cost_source,
         it.type                                      AS item_type,
         it.income_account_name,
         it.expense_account_name
  FROM ops.qbo_invoice_lines l
    LEFT JOIN ops.qbo_items           it ON it.qbo_item_id  = l.item_ref_id
    LEFT JOIN ops.v_item_actual_cost  ac ON ac.item_ref_id  = l.item_ref_id
)
SELECT e.id                                           AS line_id,
       e.invoice_id,
       i.qbo_invoice_id,
       i.doc_number,
       i.txn_date,
       date_trunc('month', i.txn_date::timestamptz)::date AS txn_month,
       EXTRACT(year FROM i.txn_date)::integer            AS txn_year,
       i.customer_ref_id,
       i.customer_name,
       i.entity,
       i.department                                   AS invoice_department,
       e.department                                   AS line_department,
       e.item_ref_id,
       e.item_name,
       e.revenue_line                                 AS category,
       COALESCE(s_item.label, s_cat.label)            AS segment,
       e.account_name,
       e.description,
       e.quantity,
       e.unit_price,
       e.amount                                       AS revenue,
       e.static_unit_cost                             AS purchase_cost,
       e.actual_unit_cost,
       e.effective_unit_cost,
       e.cost_source,
       e.item_type,
       e.income_account_name,
       e.expense_account_name,
       CASE
         WHEN e.effective_unit_cost IS NOT NULL AND e.quantity IS NOT NULL
         THEN e.effective_unit_cost * e.quantity
       END                                            AS est_cost,
       CASE
         WHEN e.effective_unit_cost IS NOT NULL AND e.quantity IS NOT NULL
         THEN e.amount - e.effective_unit_cost * e.quantity
       END                                            AS est_margin,
       COALESCE(lc.channels, ARRAY[]::text[])         AS channels,
       lc.primary_channel
FROM effective e
  JOIN      ops.qbo_invoices    i      ON i.id              = e.invoice_id
  LEFT JOIN ops.item_segments   is_map ON is_map.item_name  = e.item_name
  LEFT JOIN ops.segments        s_item ON s_item.segment_code = is_map.segment_code
                                       AND s_item.is_active
  LEFT JOIN ops.category_segments cs   ON cs.category       = e.revenue_line
  LEFT JOIN ops.segments        s_cat  ON s_cat.segment_code = cs.segment_code
                                       AND s_cat.is_active
  LEFT JOIN LATERAL (
    SELECT array_agg(c.label ORDER BY c.sort_order)        AS channels,
           max(c.label) FILTER (WHERE cc.is_primary)       AS primary_channel
    FROM ops.customer_channels cc
      JOIN ops.channels c ON c.channel_code = cc.channel_code
    WHERE cc.qbo_customer_id = i.customer_ref_id
      AND c.is_active
  ) lc ON true;

COMMENT ON VIEW ops.v_sales_lines IS
  'Canonical sales-lines view (rep-free). Defined in 20260505d (supersedes 20260505a + the v1-v4 chain). Rep columns dropped per §12 #5.';

-- ==================================================================
-- Recreate fn_customer_detail without primary_sales_rep / all_sales_reps.
-- ==================================================================
CREATE FUNCTION ops.fn_customer_detail(
  p_qbo_customer_id text,
  p_start date DEFAULT '2025-01-01',
  p_end date DEFAULT current_date
) RETURNS TABLE (
  qbo_customer_id text, display_name text, customer_type_name text,
  bill_addr_line1 text, bill_addr_city text, bill_addr_state text, bill_addr_postal text,
  email text, phone text, is_sub_customer boolean, active boolean, notes text,
  primary_channel text, all_channels text[],
  current_revenue numeric, current_invoice_count bigint, current_line_count bigint,
  current_est_cost numeric, current_est_margin numeric, current_margin_pct numeric,
  lifetime_revenue numeric, lifetime_invoice_count bigint, last_invoice_date date,
  ar_balance numeric, ar_overdue numeric, ar_overdue_count int
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH cur AS (
    SELECT sum(revenue)::numeric AS revenue,
      count(DISTINCT invoice_id)::bigint AS invoice_count, count(*)::bigint AS line_count,
      sum(est_cost)::numeric AS est_cost, sum(est_margin)::numeric AS est_margin
    FROM ops.v_sales_lines
    WHERE customer_ref_id = p_qbo_customer_id AND txn_date >= p_start AND txn_date <= p_end
  ),
  life AS (
    SELECT sum(revenue)::numeric AS revenue,
      count(DISTINCT invoice_id)::bigint AS invoice_count, max(txn_date) AS last_date
    FROM ops.v_sales_lines WHERE customer_ref_id = p_qbo_customer_id
  ),
  ar AS (
    SELECT sum(balance)::numeric AS ar_balance,
      sum(CASE WHEN due_date < current_date THEN balance ELSE 0 END)::numeric AS ar_overdue,
      count(*) FILTER (WHERE balance > 0 AND due_date < current_date)::int AS ar_overdue_count
    FROM ops.qbo_invoices WHERE customer_ref_id = p_qbo_customer_id AND balance > 0
  ),
  ch AS (
    SELECT array_agg(c.label ORDER BY c.sort_order) AS labels,
      max(c.label) FILTER (WHERE cc.is_primary) AS primary_label
    FROM ops.customer_channels cc JOIN ops.channels c ON c.channel_code = cc.channel_code AND c.is_active
    WHERE cc.qbo_customer_id = p_qbo_customer_id
  )
  SELECT qc.qbo_customer_id, qc.display_name, qc.customer_type_name,
    qc.bill_addr_line1, qc.bill_addr_city, qc.bill_addr_state, qc.bill_addr_postal,
    qc.email, qc.phone, qc.is_sub_customer, qc.active, qc.notes,
    ch.primary_label,
    COALESCE(ch.labels, ARRAY[]::text[]),
    COALESCE(cur.revenue, 0), COALESCE(cur.invoice_count, 0), COALESCE(cur.line_count, 0),
    cur.est_cost, cur.est_margin,
    CASE WHEN cur.revenue > 0 AND cur.est_cost IS NOT NULL THEN (cur.revenue - cur.est_cost) / cur.revenue ELSE NULL END,
    COALESCE(life.revenue, 0), COALESCE(life.invoice_count, 0), life.last_date,
    COALESCE(ar.ar_balance, 0), COALESCE(ar.ar_overdue, 0), COALESCE(ar.ar_overdue_count, 0)
  FROM ops.qbo_customers qc
  CROSS JOIN cur CROSS JOIN life CROSS JOIN ar
  LEFT JOIN ch ON true
  WHERE qc.qbo_customer_id = p_qbo_customer_id;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_customer_detail(text, date, date) TO anon, authenticated;

-- ==================================================================
-- Recreate fn_customer_health without primary_sales_rep.
-- ==================================================================
CREATE FUNCTION ops.fn_customer_health(
  p_window_days int DEFAULT 365
) RETURNS TABLE (
  qbo_customer_id text, customer_name text,
  primary_channel text,
  recency_days int, frequency int, monetary numeric,
  r_score int, f_score int, m_score int,
  rfm_total int, rfm_segment text, last_invoice_date date
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH stats AS (
    SELECT v.customer_ref_id,
      max(v.txn_date) AS last_date,
      count(DISTINCT v.invoice_id)::int AS frequency,
      sum(v.revenue)::numeric AS monetary
    FROM ops.v_sales_lines v
    WHERE v.txn_date >= current_date - p_window_days
    GROUP BY 1
  ),
  scored AS (
    SELECT *,
      (current_date - last_date)::int AS recency_days,
      ntile(5) OVER (ORDER BY (current_date - last_date)::int DESC) AS r_score,
      ntile(5) OVER (ORDER BY frequency ASC) AS f_score,
      ntile(5) OVER (ORDER BY monetary  ASC) AS m_score
    FROM stats
  ),
  ch AS (
    SELECT cc.qbo_customer_id, max(c.label) FILTER (WHERE cc.is_primary) AS primary_channel
    FROM ops.customer_channels cc JOIN ops.channels c ON c.channel_code = cc.channel_code AND c.is_active
    GROUP BY 1
  )
  SELECT s.customer_ref_id, qc.display_name,
    ch.primary_channel,
    s.recency_days, s.frequency, s.monetary,
    s.r_score::int, s.f_score::int, s.m_score::int,
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
GRANT EXECUTE ON FUNCTION ops.fn_customer_health(int) TO anon, authenticated;

-- ==================================================================
-- Recreate fn_customer_health_asof without primary_sales_rep.
-- ==================================================================
CREATE FUNCTION ops.fn_customer_health_asof(
  p_asof_date   date,
  p_window_days int DEFAULT 365
) RETURNS TABLE (
  qbo_customer_id text, customer_name text,
  primary_channel text,
  recency_days int, frequency int, monetary numeric,
  r_score int, f_score int, m_score int,
  rfm_total int, rfm_segment text, last_invoice_date date
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH stats AS (
    SELECT v.customer_ref_id,
      max(v.txn_date) AS last_date,
      count(DISTINCT v.invoice_id)::int AS frequency,
      sum(v.revenue)::numeric AS monetary
    FROM ops.v_sales_lines v
    WHERE v.txn_date >= p_asof_date - p_window_days
      AND v.txn_date <= p_asof_date
    GROUP BY 1
  ),
  scored AS (
    SELECT *,
      (p_asof_date - last_date)::int AS recency_days,
      ntile(5) OVER (ORDER BY (p_asof_date - last_date)::int DESC) AS r_score,
      ntile(5) OVER (ORDER BY frequency ASC) AS f_score,
      ntile(5) OVER (ORDER BY monetary  ASC) AS m_score
    FROM stats
  ),
  ch AS (
    SELECT cc.qbo_customer_id, max(c.label) FILTER (WHERE cc.is_primary) AS primary_channel
    FROM ops.customer_channels cc JOIN ops.channels c ON c.channel_code = cc.channel_code AND c.is_active
    GROUP BY 1
  )
  SELECT s.customer_ref_id, qc.display_name,
    ch.primary_channel,
    s.recency_days, s.frequency, s.monetary,
    s.r_score::int, s.f_score::int, s.m_score::int,
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
GRANT EXECUTE ON FUNCTION ops.fn_customer_health_asof(date, int) TO anon, authenticated;

-- ==================================================================
-- Recreate fn_inactive_customers without primary_sales_rep.
-- ==================================================================
CREATE FUNCTION ops.fn_inactive_customers(
  p_current_start date, p_current_end date,
  p_prior_start   date, p_prior_end   date,
  p_min_prior_rev numeric DEFAULT 1000,
  p_max_current_rev numeric DEFAULT 0,
  p_limit int DEFAULT 200
) RETURNS TABLE (
  qbo_customer_id text, customer_name text,
  prior_revenue numeric, current_revenue numeric,
  last_invoice_date date,
  primary_channel text, bill_state text
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
  )
  SELECT p.customer_ref_id, qc.display_name,
    p.rev, COALESCE(c.rev, 0), GREATEST(c.last_date, p.last_date),
    ch.primary_channel, qc.bill_addr_state
  FROM prior p
  LEFT JOIN cur c ON c.customer_ref_id = p.customer_ref_id
  LEFT JOIN ops.qbo_customers qc ON qc.qbo_customer_id = p.customer_ref_id
  LEFT JOIN ch ON ch.qbo_customer_id = p.customer_ref_id
  WHERE p.rev >= p_min_prior_rev
    AND COALESCE(c.rev, 0) <= p_max_current_rev
    AND qc.active IS NOT FALSE
  ORDER BY p.rev DESC
  LIMIT GREATEST(COALESCE(p_limit, 200), 1);
$$;
GRANT EXECUTE ON FUNCTION ops.fn_inactive_customers(date, date, date, date, numeric, numeric, int) TO anon, authenticated;

-- ==================================================================
-- Recreate fn_product_voids without primary_sales_rep.
-- ==================================================================
CREATE FUNCTION ops.fn_product_voids(
  p_set_code text, p_start date DEFAULT '2025-01-01', p_end date DEFAULT current_date,
  p_min_set_revenue numeric DEFAULT 0, p_require_some boolean DEFAULT true
) RETURNS TABLE (
  qbo_customer_id text, customer_name text, primary_channel text,
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
  )
  SELECT cell.customer_ref_id, qc.display_name, ch.primary_channel,
    cell.qbo_item_id, cell.item_name,
    COALESCE(cell.revenue, 0), COALESCE(cell.qty, 0), COALESCE(cell.revenue, 0) > 0,
    cs.set_revenue, cs.items_bought, ti.n
  FROM cell
  LEFT JOIN cust_summary cs ON cs.customer_ref_id = cell.customer_ref_id
  LEFT JOIN ops.qbo_customers qc ON qc.qbo_customer_id = cell.customer_ref_id
  LEFT JOIN ch   ON ch.qbo_customer_id   = cell.customer_ref_id
  CROSS JOIN total_items ti
  WHERE cs.set_revenue >= p_min_set_revenue
    AND (NOT p_require_some OR cs.items_bought < ti.n)
    AND qc.active IS NOT FALSE
  ORDER BY cs.set_revenue DESC NULLS LAST, cell.customer_ref_id, cell.item_name;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_product_voids(text, date, date, numeric, boolean) TO anon, authenticated;

-- ==================================================================
-- Recreate fn_revenue_anomalies without primary_sales_rep.
-- ==================================================================
CREATE FUNCTION ops.fn_revenue_anomalies(
  p_baseline_months int     DEFAULT 6,
  p_recent_months   int     DEFAULT 1,
  p_min_baseline    numeric DEFAULT 500,
  p_sigma_threshold numeric DEFAULT 2.0
) RETURNS TABLE (
  qbo_customer_id   text,
  customer_name     text,
  primary_channel   text,
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
  )
  SELECT a.customer_ref_id,
    qc.display_name,
    ch.primary_channel,
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
  WHERE COALESCE(a.base_avg, 0) >= p_min_baseline
    AND COALESCE(a.base_sd, 0)  > 0
    AND ABS((COALESCE(a.rec_avg, 0) - a.base_avg) / a.base_sd) >= p_sigma_threshold
  ORDER BY ABS((COALESCE(a.rec_avg, 0) - a.base_avg) / a.base_sd) DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_revenue_anomalies(int, int, numeric, numeric) TO anon, authenticated;

-- ==================================================================
-- Recreate fn_customer_scorecard without primary_sales_rep.
-- ==================================================================
CREATE FUNCTION ops.fn_customer_scorecard(
  p_qbo_customer_id text,
  p_window_days     int DEFAULT 365
) RETURNS TABLE (
  qbo_customer_id text, customer_name text,
  primary_channel text,
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
    h.primary_channel,
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

-- ==================================================================
-- Recreate fn_sales_stacked without p_sales_reps + 'sales_rep' dim option.
-- ==================================================================
CREATE FUNCTION ops.fn_sales_stacked(
  p_dim         text   DEFAULT 'customer',
  p_stack       text   DEFAULT 'segment',
  p_start       date   DEFAULT '2025-01-01',
  p_end         date   DEFAULT current_date,
  p_entities    text[] DEFAULT NULL,
  p_categories  text[] DEFAULT NULL,
  p_customers   text[] DEFAULT NULL,
  p_items       text[] DEFAULT NULL,
  p_channels    text[] DEFAULT NULL,
  p_segments    text[] DEFAULT NULL,
  p_limit       int    DEFAULT 30
) RETURNS TABLE (
  dim_label text, stack_label text, revenue numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH base AS (
    SELECT * FROM ops.v_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
      AND (p_entities    IS NULL OR cardinality(p_entities)    = 0 OR entity        = ANY(p_entities))
      AND (p_categories  IS NULL OR cardinality(p_categories)  = 0 OR category      = ANY(p_categories))
      AND (p_customers   IS NULL OR cardinality(p_customers)   = 0 OR customer_name = ANY(p_customers))
      AND (p_items       IS NULL OR cardinality(p_items)       = 0 OR item_name     = ANY(p_items))
      AND (p_channels    IS NULL OR cardinality(p_channels)    = 0 OR channels && p_channels)
      AND (p_segments    IS NULL OR cardinality(p_segments)    = 0 OR segment       = ANY(p_segments))
  ),
  expanded AS (
    SELECT b.*, ch.code AS dim_channel
    FROM base b
    LEFT JOIN LATERAL (
      SELECT u AS code FROM unnest(b.channels) AS u
      WHERE (p_dim = 'channel' OR p_stack = 'channel') AND cardinality(b.channels) > 0
      UNION ALL SELECT '(unassigned)'::text
      WHERE (p_dim = 'channel' OR p_stack = 'channel') AND cardinality(b.channels) = 0
    ) ch ON TRUE
  ),
  agg AS (
    SELECT
      COALESCE(CASE p_dim
        WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
        WHEN 'category' THEN category WHEN 'segment' THEN segment
        WHEN 'entity' THEN entity WHEN 'month' THEN to_char(txn_month, 'YYYY-MM')
        WHEN 'channel' THEN dim_channel
        ELSE customer_name END, '(unspecified)') AS dim_label,
      COALESCE(CASE p_stack
        WHEN 'item' THEN item_name WHEN 'customer' THEN customer_name
        WHEN 'category' THEN category WHEN 'segment' THEN segment
        WHEN 'entity' THEN entity WHEN 'month' THEN to_char(txn_month, 'YYYY-MM')
        WHEN 'channel' THEN dim_channel
        ELSE segment END, '(unspecified)') AS stack_label,
      sum(revenue)::numeric AS revenue
    FROM expanded GROUP BY 1, 2
  ),
  top_dims AS (
    SELECT dim_label, sum(revenue) AS total_rev
    FROM agg GROUP BY 1
    ORDER BY total_rev DESC NULLS LAST
    LIMIT GREATEST(COALESCE(p_limit, 30), 1)
  )
  SELECT a.dim_label, a.stack_label, a.revenue
  FROM agg a JOIN top_dims t ON t.dim_label = a.dim_label
  ORDER BY t.total_rev DESC NULLS LAST, a.revenue DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_sales_stacked(text, text, date, date, text[], text[], text[], text[], text[], text[], int) TO anon, authenticated;
