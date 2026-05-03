-- Slice X: rep performance, commission tracking, and weekly health backfill.
--
--   ops.fn_customer_health_asof(date, window_days)
--     RFM scoring anchored to an arbitrary as-of date so we can backfill
--     weekly snapshots from invoice history (vs. waiting for cron).
--
--   ops.commission_rules
--     Per-rep commission terms: rate_revenue, rate_margin, draw_monthly.
--
--   ops.fn_rep_scorecard(start, end)
--     One row per active rep with totals, active/inactive customer counts,
--     and computed commission per the rule.
--
--   ops.fn_rep_book(rep_code, start, end)
--     Detailed customer breakdown for a single rep, joined to RFM segment.
--
-- The DO block at the bottom seeds 8 weekly snapshots ending today so
-- fn_health_movers has signal immediately.
-- Applied to live DB on 2026-05-03 as migrations health_asof_backfill +
-- rep_performance_commissions.

CREATE OR REPLACE FUNCTION ops.fn_customer_health_asof(
  p_asof_date   date,
  p_window_days int DEFAULT 365
) RETURNS TABLE (
  qbo_customer_id text, customer_name text,
  primary_channel text, primary_sales_rep text,
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
  ),
  reps AS (
    SELECT csr.qbo_customer_id, max(r.name) FILTER (WHERE csr.is_primary) AS primary_sales_rep
    FROM ops.customer_sales_reps csr JOIN ops.sales_reps r ON r.rep_code = csr.rep_code AND r.is_active
    GROUP BY 1
  )
  SELECT s.customer_ref_id, qc.display_name,
    ch.primary_channel, reps.primary_sales_rep,
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
  LEFT JOIN reps ON reps.qbo_customer_id = s.customer_ref_id
  WHERE qc.active IS NOT FALSE
  ORDER BY (s.r_score + s.f_score + s.m_score) DESC, s.monetary DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_customer_health_asof(date, int) TO anon, authenticated;

-- Backfill 8 weekly snapshots ending today.
DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT generate_series(current_date - interval '56 days', current_date - interval '7 days', interval '7 days')::date LOOP
    DELETE FROM ops.customer_health_snapshots WHERE snapshot_date = d;
    INSERT INTO ops.customer_health_snapshots
      (snapshot_date, qbo_customer_id, r_score, f_score, m_score, rfm_total, rfm_segment, recency_days, frequency, monetary)
    SELECT d, h.qbo_customer_id, h.r_score, h.f_score, h.m_score, h.rfm_total, h.rfm_segment, h.recency_days, h.frequency, h.monetary
    FROM ops.fn_customer_health_asof(d, 365) h;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS ops.commission_rules (
  rep_code        text PRIMARY KEY REFERENCES ops.sales_reps(rep_code) ON DELETE CASCADE,
  rate_revenue    numeric NOT NULL DEFAULT 0,
  rate_margin     numeric NOT NULL DEFAULT 0,
  draw_monthly    numeric NOT NULL DEFAULT 0,
  applies_to      text    NOT NULL DEFAULT 'primary',
  effective_from  date    NOT NULL DEFAULT current_date,
  effective_to    date,
  notes           text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ops.commission_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cr_read  ON ops.commission_rules;
DROP POLICY IF EXISTS cr_write ON ops.commission_rules;
CREATE POLICY cr_read  ON ops.commission_rules FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY cr_write ON ops.commission_rules FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON ops.commission_rules TO anon;
GRANT INSERT, UPDATE, DELETE ON ops.commission_rules TO authenticated;
GRANT ALL    ON ops.commission_rules TO service_role;

-- fn_rep_scorecard and fn_rep_book bodies are applied via migration
-- "rep_performance_commissions" — see live DB for full SQL.
