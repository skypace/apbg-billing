-- ops.v_fleet_stop_billing
-- ------------------------
-- Reconciles GPS-detected stops (fleet_stop_visits) against QBO invoices
-- for the same (customer, day). Powers the "billing reconcile" feature on
-- the Fleet page — surfaces three classes of mismatch:
--
--   matched         GPS visit AND invoice on the same day. Healthy.
--   billed_no_visit Invoice on day D but no GPS visit at that customer's
--                   geocoded address on day D-1, D, or D+1. Either the
--                   customer wasn't visited (ghost stop) OR our customer
--                   geocode is off, OR the truck doing the work isn't on
--                   FleetComplete tracking.
--   visit_no_bill   GPS visit on day D, no invoice on day D-1..D+1. Could
--                   be a missed bill, or a non-billable visit (depot,
--                   warranty return, etc.).
--
-- Date alignment uses ±1 day tolerance because invoices commonly land on
-- the day AFTER the work was done.

CREATE OR REPLACE VIEW ops.v_fleet_stop_billing AS
WITH visit_days AS (
  SELECT
    qbo_customer_id,
    arrival_time::date AS activity_date,
    COUNT(*)           AS visit_count,
    SUM(dwell_minutes) AS total_dwell_min
  FROM ops.fleet_stop_visits
  WHERE qbo_customer_id IS NOT NULL
  GROUP BY qbo_customer_id, arrival_time::date
),
invoice_days AS (
  SELECT
    customer_ref_id  AS qbo_customer_id,
    txn_date         AS activity_date,
    COUNT(*)         AS invoice_count,
    SUM(total_amount) AS invoice_amount
  FROM ops.qbo_invoices
  WHERE customer_ref_id IS NOT NULL
  GROUP BY customer_ref_id, txn_date
),
-- For each visit day, look for an invoice within ±1 day. For each invoice
-- day with no matching visit in ±1 day, flag billed_no_visit.
all_keys AS (
  SELECT qbo_customer_id, activity_date FROM visit_days
  UNION
  SELECT qbo_customer_id, activity_date FROM invoice_days
)
SELECT
  k.qbo_customer_id,
  k.activity_date,
  c.display_name AS customer_name,
  COALESCE(v.visit_count, 0)     AS visit_count,
  COALESCE(v.total_dwell_min, 0) AS total_dwell_min,
  -- ±1 day invoice match: sum invoice_amount for any invoice within 1 day.
  COALESCE((
    SELECT SUM(i2.invoice_amount)
    FROM invoice_days i2
    WHERE i2.qbo_customer_id = k.qbo_customer_id
      AND ABS(i2.activity_date - k.activity_date) <= 1
  ), 0) AS invoice_amount_pm1,
  COALESCE((
    SELECT SUM(i2.invoice_count)
    FROM invoice_days i2
    WHERE i2.qbo_customer_id = k.qbo_customer_id
      AND ABS(i2.activity_date - k.activity_date) <= 1
  ), 0) AS invoice_count_pm1,
  -- Flag derived from the ±1-day comparison.
  CASE
    WHEN COALESCE(v.visit_count, 0) > 0
         AND EXISTS (
           SELECT 1 FROM invoice_days i2
           WHERE i2.qbo_customer_id = k.qbo_customer_id
             AND ABS(i2.activity_date - k.activity_date) <= 1
         )
      THEN 'matched'
    WHEN COALESCE(v.visit_count, 0) > 0
      THEN 'visit_no_bill'
    WHEN EXISTS (
           SELECT 1 FROM visit_days v2
           WHERE v2.qbo_customer_id = k.qbo_customer_id
             AND ABS(v2.activity_date - k.activity_date) <= 1
         )
      THEN 'matched'
    ELSE 'billed_no_visit'
  END AS flag
FROM all_keys k
LEFT JOIN visit_days v
       ON v.qbo_customer_id = k.qbo_customer_id AND v.activity_date = k.activity_date
LEFT JOIN ops.qbo_customers c
       ON c.qbo_customer_id = k.qbo_customer_id;

COMMENT ON VIEW ops.v_fleet_stop_billing IS
  'Per-(customer, day) reconciliation of GPS stops vs QBO invoices over ±1 day. Flag = matched / visit_no_bill / billed_no_visit. Drives the Reconcile tab on the Fleet page.';

GRANT SELECT ON ops.v_fleet_stop_billing TO anon, authenticated;
