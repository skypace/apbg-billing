-- Augment ops.kpi_daily with GPS-confirmed counts pulled from
-- ops.fleet_stop_visits via team_members.fleet_driver_id.
--
-- New columns:
--   gps_stops_confirmed   number of fleet_stop_visits attributed to this
--                         team_member on this day (≥5 min dwell)
--   gps_dwell_min_total   sum of dwell_minutes across those stops
--   gps_match_pct         100 * (matched stops with a qbo_customer_id) / gps_stops_confirmed
--
-- These are FLEET-truth counterparts to the SF-reported stops_completed
-- column. The Operations dashboard can now show both numbers side by side
-- and surface deltas (truck went to a stop SF didn't book, or SF booked
-- more than the truck delivered to).
--
-- Patches fn_compute_kpi_daily to populate them. Re-applies the 30-day
-- backfill so historical kpi_daily rows get the new columns retroactively
-- (only for days with fleet_stop_visits coverage — i.e. days after we
-- started syncing).

ALTER TABLE ops.kpi_daily
  ADD COLUMN IF NOT EXISTS gps_stops_confirmed integer,
  ADD COLUMN IF NOT EXISTS gps_dwell_min_total numeric,
  ADD COLUMN IF NOT EXISTS gps_match_pct       numeric;

COMMENT ON COLUMN ops.kpi_daily.gps_stops_confirmed IS
  'Distinct customer stops (≥5 min dwell) GPS-attributed to this team_member on this kpi_date. Joined via team_members.fleet_driver_id → fleet_drivers.fc_person_id → fleet_stop_visits.fc_driver_id.';
COMMENT ON COLUMN ops.kpi_daily.gps_match_pct IS
  '100 * (gps stops with qbo_customer_id matched) / gps_stops_confirmed. Below 60% suggests stale/missing customer geocodes for the customers this driver visits.';

-- Patched function. Diff from 20260506b: adds the gps CTE + 3 new columns
-- in the SELECT/INSERT lists. All other logic preserved.
CREATE OR REPLACE FUNCTION ops.fn_compute_kpi_daily(p_date date DEFAULT (current_date - 1))
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
DECLARE
  rows_affected int := 0;
BEGIN
  WITH
  del AS (
    SELECT driver_id AS tm_id,
           count(*)::int             AS stops,
           sum(sf_total)::numeric    AS revenue
    FROM ops.delivery_stops
    WHERE stop_date = p_date AND driver_id IS NOT NULL
    GROUP BY driver_id
  ),
  svc AS (
    SELECT tech_id AS tm_id,
           count(*)::int                                   AS jobs,
           sum(COALESCE(sf_total, invoice_amount))::numeric AS revenue,
           sum(billable_hours)::numeric                     AS billable_hours,
           sum(COALESCE(
             EXTRACT(EPOCH FROM (completion_time - dispatch_time)) / 3600,
             billable_hours, 0
           ))::numeric                                       AS total_hours,
           count(*) FILTER (WHERE first_time_fix = true)::int AS first_fix_count,
           avg(EXTRACT(EPOCH FROM (arrival_time - dispatch_time)) / 60)::numeric AS avg_response_min
    FROM ops.service_jobs
    WHERE job_date = p_date AND tech_id IS NOT NULL
    GROUP BY tech_id
  ),
  rmn AS (
    SELECT tech_id AS tm_id,
           count(*)::int                                  AS units,
           sum(sale_price)::numeric                        AS revenue,
           sum(parts_cost)::numeric                        AS parts_cost,
           sum(labor_cost)::numeric                        AS labor_cost,
           avg(completion_date - intake_date)::numeric     AS turnaround_days
    FROM ops.reman_jobs
    WHERE completion_date = p_date AND tech_id IS NOT NULL
    GROUP BY tech_id
  ),
  -- GPS-confirmed stops per linked team_member.
  -- fleet_stop_visits.fc_driver_id is the FC person UUID. team_members.fleet_driver_id
  -- holds the same UUID once the Settings → Fleet Drivers tab is filled in.
  -- Filter to dwell ≥5 min implicit: buildStopVisits already filtered.
  gps AS (
    SELECT tm.id AS tm_id,
           count(DISTINCT s.id)::int                            AS stops,
           sum(s.dwell_minutes)::numeric                         AS dwell_min,
           count(DISTINCT s.id) FILTER (WHERE s.qbo_customer_id IS NOT NULL)::int AS matched_stops
    FROM ops.fleet_stop_visits s
    JOIN ops.team_members      tm ON tm.fleet_driver_id = s.fc_driver_id
    WHERE s.arrival_time::date = p_date
      AND s.fc_driver_id IS NOT NULL
    GROUP BY tm.id
  )
  INSERT INTO ops.kpi_daily (
    kpi_date, team_member_id, member_name, department, entity,
    stops_completed, delivery_revenue, delivery_cost,
    cost_per_stop, revenue_per_stop, margin_per_stop,
    jobs_completed, service_revenue, service_cost,
    cost_per_job, revenue_per_job,
    billable_hours, total_hours, utilization_pct,
    first_fix_pct, avg_response_min,
    units_completed, reman_revenue, reman_cost,
    labor_per_unit, parts_per_unit, margin_per_unit, turnaround_days,
    gps_stops_confirmed, gps_dwell_min_total, gps_match_pct,
    computed_at
  )
  SELECT
    p_date, tm.id, tm.name, tm.department, tm.entity,
    CASE WHEN tm.department = 'delivery' THEN COALESCE(d.stops, 0) END,
    CASE WHEN tm.department = 'delivery' THEN COALESCE(d.revenue, 0) END,
    CASE WHEN tm.department = 'delivery' THEN
      COALESCE(tm.annual_wage, 0) / 260.0 * COALESCE(tm.split_pct, 1)
    END,
    CASE WHEN tm.department = 'delivery' AND COALESCE(d.stops, 0) > 0 THEN
      (COALESCE(tm.annual_wage, 0) / 260.0 * COALESCE(tm.split_pct, 1)) / d.stops
    END,
    CASE WHEN tm.department = 'delivery' AND COALESCE(d.stops, 0) > 0 THEN
      COALESCE(d.revenue, 0) / d.stops
    END,
    CASE WHEN tm.department = 'delivery' AND COALESCE(d.stops, 0) > 0 THEN
      (COALESCE(d.revenue, 0) / d.stops)
        - ((COALESCE(tm.annual_wage, 0) / 260.0 * COALESCE(tm.split_pct, 1)) / d.stops)
    END,
    CASE WHEN tm.department = 'service' THEN COALESCE(s.jobs, 0) END,
    CASE WHEN tm.department = 'service' THEN COALESCE(s.revenue, 0) END,
    CASE WHEN tm.department = 'service' THEN
      COALESCE(tm.annual_wage, 0) / 260.0 * COALESCE(tm.split_pct, 1)
    END,
    CASE WHEN tm.department = 'service' AND COALESCE(s.jobs, 0) > 0 THEN
      (COALESCE(tm.annual_wage, 0) / 260.0 * COALESCE(tm.split_pct, 1)) / s.jobs
    END,
    CASE WHEN tm.department = 'service' AND COALESCE(s.jobs, 0) > 0 THEN
      COALESCE(s.revenue, 0) / s.jobs
    END,
    CASE WHEN tm.department = 'service' THEN COALESCE(s.billable_hours, 0) END,
    CASE WHEN tm.department = 'service' THEN COALESCE(s.total_hours, 0) END,
    CASE WHEN tm.department = 'service' AND COALESCE(s.total_hours, 0) > 0 THEN
      100 * COALESCE(s.billable_hours, 0) / s.total_hours
    END,
    CASE WHEN tm.department = 'service' AND COALESCE(s.jobs, 0) > 0 THEN
      100.0 * COALESCE(s.first_fix_count, 0) / s.jobs
    END,
    CASE WHEN tm.department = 'service' THEN s.avg_response_min END,
    CASE WHEN tm.department = 'reman' THEN COALESCE(r.units, 0) END,
    CASE WHEN tm.department = 'reman' THEN COALESCE(r.revenue, 0) END,
    CASE WHEN tm.department = 'reman' THEN COALESCE(r.parts_cost, 0) + COALESCE(r.labor_cost, 0) END,
    CASE WHEN tm.department = 'reman' AND COALESCE(r.units, 0) > 0 THEN COALESCE(r.labor_cost, 0) / r.units END,
    CASE WHEN tm.department = 'reman' AND COALESCE(r.units, 0) > 0 THEN COALESCE(r.parts_cost, 0) / r.units END,
    CASE WHEN tm.department = 'reman' AND COALESCE(r.units, 0) > 0 THEN
      (COALESCE(r.revenue, 0) - COALESCE(r.parts_cost, 0) - COALESCE(r.labor_cost, 0)) / r.units
    END,
    CASE WHEN tm.department = 'reman' THEN r.turnaround_days END,
    -- GPS columns (any team_member can have GPS stops if linked to FC).
    g.stops,
    g.dwell_min,
    CASE WHEN COALESCE(g.stops, 0) > 0 THEN 100.0 * COALESCE(g.matched_stops, 0) / g.stops END,
    now()
  FROM ops.team_members tm
  LEFT JOIN del d ON d.tm_id = tm.id
  LEFT JOIN svc s ON s.tm_id = tm.id
  LEFT JOIN rmn r ON r.tm_id = tm.id
  LEFT JOIN gps g ON g.tm_id = tm.id
  WHERE tm.active = true
    AND (
      (tm.department = 'delivery' AND d.tm_id IS NOT NULL) OR
      (tm.department = 'service'  AND s.tm_id IS NOT NULL) OR
      (tm.department = 'reman'    AND r.tm_id IS NOT NULL) OR
      g.tm_id IS NOT NULL  -- include any linked FC driver even if no SF data
    )
  ON CONFLICT (kpi_date, team_member_id) DO UPDATE SET
    member_name        = EXCLUDED.member_name,
    department         = EXCLUDED.department,
    entity             = EXCLUDED.entity,
    stops_completed    = EXCLUDED.stops_completed,
    delivery_revenue   = EXCLUDED.delivery_revenue,
    delivery_cost      = EXCLUDED.delivery_cost,
    cost_per_stop      = EXCLUDED.cost_per_stop,
    revenue_per_stop   = EXCLUDED.revenue_per_stop,
    margin_per_stop    = EXCLUDED.margin_per_stop,
    jobs_completed     = EXCLUDED.jobs_completed,
    service_revenue    = EXCLUDED.service_revenue,
    service_cost       = EXCLUDED.service_cost,
    cost_per_job       = EXCLUDED.cost_per_job,
    revenue_per_job    = EXCLUDED.revenue_per_job,
    billable_hours     = EXCLUDED.billable_hours,
    total_hours        = EXCLUDED.total_hours,
    utilization_pct    = EXCLUDED.utilization_pct,
    first_fix_pct      = EXCLUDED.first_fix_pct,
    avg_response_min   = EXCLUDED.avg_response_min,
    units_completed    = EXCLUDED.units_completed,
    reman_revenue      = EXCLUDED.reman_revenue,
    reman_cost         = EXCLUDED.reman_cost,
    labor_per_unit     = EXCLUDED.labor_per_unit,
    parts_per_unit     = EXCLUDED.parts_per_unit,
    margin_per_unit    = EXCLUDED.margin_per_unit,
    turnaround_days    = EXCLUDED.turnaround_days,
    gps_stops_confirmed = EXCLUDED.gps_stops_confirmed,
    gps_dwell_min_total = EXCLUDED.gps_dwell_min_total,
    gps_match_pct       = EXCLUDED.gps_match_pct,
    computed_at        = EXCLUDED.computed_at;

  GET DIAGNOSTICS rows_affected = ROW_COUNT;
  RETURN rows_affected;
END;
$$;

-- Backfill last 30 days so the new columns aren't NULL across recent history.
DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT generate_series(current_date - 30, current_date - 1, interval '1 day')::date LOOP
    PERFORM ops.fn_compute_kpi_daily(d);
  END LOOP;
END $$;
