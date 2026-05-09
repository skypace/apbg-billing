-- ops.v_fleet_fuel_cost_monthly
-- ----------------------------
-- Sky's Capital One card runs all fleet fuel and lands as the "Fuel"
-- expense line in QBO. Rather than building a fuel-card API integration,
-- divide the monthly fuel expense by stop counts to get fuel-cost-per-stop.
-- Approximate by design — good enough for trending and benchmarking.
--
-- Stops use whatever's available, in this priority order:
--   1. ops.delivery_stops          — Service Fusion truth, populated for SF orgs
--   2. ops.fleet_stop_visits       — GPS truth, fills in once we have history
-- We compare both: SF count is what got billed, GPS count is what physically
-- happened. delta_pct surfaces the difference for sanity-checking.

CREATE OR REPLACE VIEW ops.v_fleet_fuel_cost_monthly AS
WITH fuel AS (
  SELECT date_trunc('month', period)::date AS month,
         SUM(amount)::numeric AS fuel_expense
  FROM ops.pl_snapshots
  WHERE account_name = 'Fuel' AND account_type = 'Expense'
  GROUP BY 1
),
sf_stops AS (
  SELECT date_trunc('month', stop_date)::date AS month,
         COUNT(*)::int AS sf_stop_count
  FROM ops.delivery_stops
  GROUP BY 1
),
gps_stops AS (
  SELECT date_trunc('month', arrival_time)::date AS month,
         COUNT(*)::int AS gps_stop_count,
         COUNT(*) FILTER (WHERE qbo_customer_id IS NOT NULL)::int AS gps_matched_count
  FROM ops.fleet_stop_visits
  GROUP BY 1
)
SELECT
  COALESCE(f.month, sf.month, gps.month) AS month,
  COALESCE(f.fuel_expense, 0)            AS fuel_expense,
  COALESCE(sf.sf_stop_count, 0)          AS sf_stop_count,
  COALESCE(gps.gps_stop_count, 0)        AS gps_stop_count,
  COALESCE(gps.gps_matched_count, 0)     AS gps_matched_count,
  CASE WHEN COALESCE(sf.sf_stop_count, 0) > 0
       THEN (f.fuel_expense / sf.sf_stop_count)::numeric(10,2) END
    AS fuel_per_stop_sf,
  CASE WHEN COALESCE(gps.gps_stop_count, 0) > 0
       THEN (f.fuel_expense / gps.gps_stop_count)::numeric(10,2) END
    AS fuel_per_stop_gps,
  CASE WHEN COALESCE(sf.sf_stop_count, 0) > 0 AND COALESCE(gps.gps_stop_count, 0) > 0
       THEN (100.0 * (gps.gps_stop_count - sf.sf_stop_count) / sf.sf_stop_count)::numeric(8,1) END
    AS gps_vs_sf_delta_pct
FROM fuel f
FULL OUTER JOIN sf_stops  sf  ON sf.month  = f.month
FULL OUTER JOIN gps_stops gps ON gps.month = COALESCE(f.month, sf.month)
ORDER BY 1 DESC;

COMMENT ON VIEW ops.v_fleet_fuel_cost_monthly IS
  'Monthly fuel cost per stop. fuel_expense from QBO P&L (account_name=Fuel). Stop counts from ops.delivery_stops (SF) and ops.fleet_stop_visits (GPS). Sky-approved approximation in lieu of fuel-card integration (Cap One handles fleet fuel). gps_vs_sf_delta_pct flags weeks where GPS-truth and SF-billed counts diverge by >10%.';

GRANT SELECT ON ops.v_fleet_fuel_cost_monthly TO anon, authenticated;
