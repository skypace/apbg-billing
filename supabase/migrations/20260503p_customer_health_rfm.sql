-- Customer health RFM (Recency / Frequency / Monetary) scoring.
-- Each customer scored 1-5 on each axis (quintiles within the window),
-- composite total 3-15, segment label.
-- Applied to live DB on 2026-05-03.

CREATE OR REPLACE FUNCTION ops.fn_customer_health(
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
GRANT EXECUTE ON FUNCTION ops.fn_customer_health(int) TO anon, authenticated;
