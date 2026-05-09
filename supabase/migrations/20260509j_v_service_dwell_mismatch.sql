-- ops.v_service_dwell_mismatch
-- ----------------------------
-- Compares ops.service_jobs.duration_min (Service Fusion's reported job
-- duration, set by techs in the field) against the GPS-truth dwell time
-- at the same customer on the same day, summed across fleet_stop_visits.
--
-- delivery_stops doesn't ship arrival/departure timestamps from Service
-- Fusion (0 / 309 rows have them populated as of 2026-05-09), so this
-- view is service-only. When SF starts publishing those timestamps the
-- same view shape can extend to delivery.
--
-- Match path: service_jobs.customer_ref_id is a Service Fusion customer
-- ID, NOT a QBO customer ID. Direct join is impossible. We fall back to
-- date + customer_name fuzzy match: service_jobs.customer_name vs
-- qbo_customers.display_name via pg_trgm similarity (case-insensitive,
-- threshold 0.5). Imperfect but the universe is small (200 service_jobs)
-- and a few false matches are tolerable for a triage view.
--
-- Flags:
--   over_billed   sf_duration > 1.5 * gps_dwell  AND  delta > 30 min
--   under_billed  sf_duration < 0.5 * gps_dwell  AND  delta > 30 min
--   matched       within ±50% of GPS dwell
--   no_gps        no GPS visit found for that customer-date

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE VIEW ops.v_service_dwell_mismatch AS
WITH sj AS (
  SELECT
    j.id              AS service_job_id,
    j.sf_job_number,
    j.job_date,
    j.customer_name,
    j.tech_name,
    j.duration_min    AS sf_duration_min,
    j.invoice_amount,
    j.sf_total
  FROM ops.service_jobs j
  WHERE j.duration_min IS NOT NULL
    AND j.duration_min > 0
    AND j.customer_name IS NOT NULL
    AND j.job_date >= now() - interval '90 days'
),
-- For each service_job, find the qbo_customer with the highest name similarity.
-- LATERAL keeps the join O(N*M) but N is small (≤200 in 90-day window) and the
-- pg_trgm gist index on display_name makes the inner scan fast.
sj_matched AS (
  SELECT sj.*, c.qbo_customer_id, c.display_name AS qbo_name,
         similarity(sj.customer_name, c.display_name) AS sim
  FROM sj
  CROSS JOIN LATERAL (
    SELECT qbo_customer_id, display_name
    FROM ops.qbo_customers
    WHERE display_name IS NOT NULL
      AND similarity(sj.customer_name, display_name) > 0.5
    ORDER BY similarity(sj.customer_name, display_name) DESC
    LIMIT 1
  ) c
),
gps_dwell AS (
  SELECT
    qbo_customer_id,
    arrival_time::date AS day,
    SUM(dwell_minutes)  AS gps_dwell_min,
    COUNT(*)            AS gps_visits
  FROM ops.fleet_stop_visits
  WHERE qbo_customer_id IS NOT NULL
  GROUP BY qbo_customer_id, arrival_time::date
)
SELECT
  m.service_job_id,
  m.sf_job_number,
  m.job_date,
  m.customer_name      AS sf_customer_name,
  m.qbo_name           AS qbo_customer_name,
  m.qbo_customer_id,
  m.tech_name,
  m.sf_duration_min,
  COALESCE(g.gps_dwell_min, 0) AS gps_dwell_min,
  COALESCE(g.gps_visits, 0)    AS gps_visits,
  m.sf_duration_min - COALESCE(g.gps_dwell_min, 0) AS delta_min,
  m.sim                 AS name_match_similarity,
  m.invoice_amount,
  m.sf_total,
  CASE
    WHEN g.gps_dwell_min IS NULL THEN 'no_gps'
    WHEN m.sf_duration_min > 1.5 * g.gps_dwell_min
         AND (m.sf_duration_min - g.gps_dwell_min) > 30 THEN 'over_billed'
    WHEN m.sf_duration_min < 0.5 * g.gps_dwell_min
         AND (g.gps_dwell_min - m.sf_duration_min) > 30 THEN 'under_billed'
    ELSE 'matched'
  END AS flag
FROM sj_matched m
LEFT JOIN gps_dwell g
       ON g.qbo_customer_id = m.qbo_customer_id
      AND g.day = m.job_date;

COMMENT ON VIEW ops.v_service_dwell_mismatch IS
  'Service-job dwell mismatch: SF-reported duration_min vs GPS-confirmed dwell time. Customer match via pg_trgm name similarity (threshold 0.5). Flags over_billed / under_billed / matched / no_gps.';

GRANT SELECT ON ops.v_service_dwell_mismatch TO anon, authenticated;
