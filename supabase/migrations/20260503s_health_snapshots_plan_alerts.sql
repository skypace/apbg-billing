-- Slice T: weekly health snapshots, customer movement, and plan alerts.
--   ops.customer_health_snapshots          weekly RFM snapshot
--   ops.fn_take_health_snapshot()          run by weekly cron, idempotent
--   ops.fn_health_movers(max_age_days)     diff today's RFM vs latest snapshot
--   ops.fn_plan_alerts(plan_id, threshold) plan lines underperforming YTD
-- Plus a Monday 10 UTC cron to take the snapshot.
-- Applied to live DB on 2026-05-03 as migration "health_snapshots_movers".

CREATE TABLE IF NOT EXISTS ops.customer_health_snapshots (
  snapshot_date    date NOT NULL,
  qbo_customer_id  text NOT NULL,
  r_score          int,
  f_score          int,
  m_score          int,
  rfm_total        int,
  rfm_segment      text,
  recency_days     int,
  frequency        int,
  monetary         numeric,
  PRIMARY KEY (snapshot_date, qbo_customer_id)
);
CREATE INDEX IF NOT EXISTS idx_chs_customer ON ops.customer_health_snapshots(qbo_customer_id, snapshot_date DESC);

ALTER TABLE ops.customer_health_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chs_read ON ops.customer_health_snapshots;
CREATE POLICY chs_read ON ops.customer_health_snapshots FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON ops.customer_health_snapshots TO anon, authenticated;
GRANT ALL    ON ops.customer_health_snapshots TO service_role;

CREATE OR REPLACE FUNCTION ops.fn_take_health_snapshot()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
DECLARE n int;
BEGIN
  DELETE FROM ops.customer_health_snapshots WHERE snapshot_date = current_date;
  INSERT INTO ops.customer_health_snapshots
    (snapshot_date, qbo_customer_id, r_score, f_score, m_score, rfm_total, rfm_segment, recency_days, frequency, monetary)
  SELECT current_date, h.qbo_customer_id, h.r_score, h.f_score, h.m_score, h.rfm_total, h.rfm_segment, h.recency_days, h.frequency, h.monetary
  FROM ops.fn_customer_health(365) h;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_take_health_snapshot() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION ops.fn_health_movers(p_max_age_days int DEFAULT 14)
RETURNS TABLE (
  qbo_customer_id text, customer_name text,
  primary_channel text, primary_sales_rep text,
  prev_snapshot_date date, prev_segment text, prev_rfm_total int, prev_monetary numeric,
  curr_segment text, curr_rfm_total int, curr_monetary numeric,
  rfm_total_delta int, monetary_delta numeric,
  movement text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH curr AS (
    SELECT * FROM ops.fn_customer_health(365)
  ),
  prev AS (
    SELECT DISTINCT ON (qbo_customer_id)
      qbo_customer_id, snapshot_date, rfm_segment, rfm_total, monetary
    FROM ops.customer_health_snapshots
    WHERE snapshot_date < current_date
      AND snapshot_date >= current_date - p_max_age_days
    ORDER BY qbo_customer_id, snapshot_date DESC
  )
  SELECT
    c.qbo_customer_id, c.customer_name, c.primary_channel, c.primary_sales_rep,
    p.snapshot_date, p.rfm_segment, p.rfm_total, p.monetary,
    c.rfm_segment, c.rfm_total, c.monetary,
    (c.rfm_total - p.rfm_total)::int,
    (c.monetary - p.monetary)::numeric,
    CASE
      WHEN p.rfm_segment IS NULL THEN 'New'
      WHEN p.rfm_segment <> c.rfm_segment THEN 'Segment change: ' || p.rfm_segment || ' -> ' || c.rfm_segment
      WHEN c.rfm_total > p.rfm_total THEN 'Same segment, score +' || (c.rfm_total - p.rfm_total)::text
      WHEN c.rfm_total < p.rfm_total THEN 'Same segment, score ' || (c.rfm_total - p.rfm_total)::text
      ELSE 'Stable'
    END
  FROM curr c
  LEFT JOIN prev p ON p.qbo_customer_id = c.qbo_customer_id
  WHERE p.qbo_customer_id IS NULL OR p.rfm_segment <> c.rfm_segment OR p.rfm_total <> c.rfm_total
  ORDER BY ABS(c.rfm_total - COALESCE(p.rfm_total, 0)) DESC, c.monetary DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_health_movers(int) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_plan_alerts(p_plan_id uuid, p_threshold numeric DEFAULT 0.10)
RETURNS TABLE (
  line_id uuid, item_name text, account_name text,
  ytd_plan numeric, ytd_actual numeric,
  variance_pct numeric, months_complete int
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
  ytd_plan AS (
    SELECT id, item_name, account_name, qbo_item_id,
           (SELECT sum(amounts[i]) FROM generate_series(1, (SELECT m FROM elapsed)) i)::numeric AS amt
    FROM lines
  ),
  ytd_actual AS (
    SELECT v.item_name AS item_name, sum(v.revenue)::numeric AS amt
    FROM ops.v_sales_lines v
    WHERE v.txn_date >= ((SELECT fiscal_year FROM plan_meta) || '-01-01')::date
      AND v.txn_date <  date_trunc('month', current_date)::date
    GROUP BY 1
  )
  SELECT yp.id, yp.item_name, yp.account_name,
    COALESCE(yp.amt, 0), COALESCE(ya.amt, 0),
    CASE WHEN COALESCE(yp.amt, 0) > 0
         THEN (COALESCE(ya.amt, 0) - yp.amt) / yp.amt
         ELSE NULL END,
    (SELECT m FROM elapsed)
  FROM ytd_plan yp
  LEFT JOIN ytd_actual ya ON ya.item_name = yp.item_name
  WHERE COALESCE(yp.amt, 0) > 0
    AND (COALESCE(ya.amt, 0) - yp.amt) / yp.amt < -p_threshold
  ORDER BY (COALESCE(ya.amt, 0) - yp.amt) ASC;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_plan_alerts(uuid, numeric) TO anon, authenticated;

-- Cron: Monday 10 UTC = 02:00 Pacific. Snapshot a week's RFM history.
SELECT cron.schedule('weekly-health-snapshot', '0 10 * * 1', $$
  SELECT ops.fn_take_health_snapshot();
$$);
