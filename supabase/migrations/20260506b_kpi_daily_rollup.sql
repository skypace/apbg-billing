-- §3.B from CLAUDE.md (apbg-billing) — kpi_daily nightly rollup.
--
-- ops.kpi_daily was created with the right shape but never wired. This
-- migration:
--   1. Defines ops.fn_compute_kpi_daily(p_date) — single-day rollup.
--      For every active team_members row in delivery / service / reman
--      departments, it computes that day's KPIs from delivery_stops /
--      service_jobs / reman_jobs (joined on driver_id / tech_id) and
--      upserts into ops.kpi_daily keyed on (kpi_date, team_member_id).
--   2. Schedules pg_cron 'nightly-kpi-daily' at 11:00 UTC, covering
--      yesterday (current_date - 1). 11:00 UTC is comfortably after
--      sync-qbo's 09:00 UTC + the half-hourly sync-sf cycle, so the
--      day's data has settled.
--   3. Backfills the last 30 days at apply time so the table isn't
--      empty when the dashboard first reads it.
--
-- Updates the orphan list in architecture/sync-manifest.json — kpi_daily
-- now has fn_compute_kpi_daily as its writer.

-- ------------------------------------------------------------------
-- 1. Single-day rollup function.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops.fn_compute_kpi_daily(p_date date DEFAULT (current_date - 1))
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
DECLARE
  rows_affected int := 0;
BEGIN
  WITH
  -- Per-driver delivery aggregates for the day.
  del AS (
    SELECT driver_id AS tm_id,
           count(*)::int             AS stops,
           sum(sf_total)::numeric    AS revenue
    FROM ops.delivery_stops
    WHERE stop_date = p_date
      AND driver_id IS NOT NULL
    GROUP BY driver_id
  ),
  -- Per-tech service aggregates.
  svc AS (
    SELECT tech_id AS tm_id,
           count(*)::int                                   AS jobs,
           sum(COALESCE(sf_total, invoice_amount))::numeric AS revenue,
           sum(billable_hours)::numeric                     AS billable_hours,
           -- Total hours: dispatch→completion duration when present, else billable.
           sum(COALESCE(
             EXTRACT(EPOCH FROM (completion_time - dispatch_time)) / 3600,
             billable_hours,
             0
           ))::numeric                                       AS total_hours,
           count(*) FILTER (WHERE first_time_fix = true)::int AS first_fix_count,
           avg(EXTRACT(EPOCH FROM (arrival_time - dispatch_time)) / 60)::numeric AS avg_response_min
    FROM ops.service_jobs
    WHERE job_date = p_date
      AND tech_id IS NOT NULL
    GROUP BY tech_id
  ),
  -- Per-tech reman aggregates (keyed on completion_date, not intake).
  rmn AS (
    SELECT tech_id AS tm_id,
           count(*)::int                                  AS units,
           sum(sale_price)::numeric                        AS revenue,
           sum(parts_cost)::numeric                        AS parts_cost,
           sum(labor_cost)::numeric                        AS labor_cost,
           avg(completion_date - intake_date)::numeric     AS turnaround_days
    FROM ops.reman_jobs
    WHERE completion_date = p_date
      AND tech_id IS NOT NULL
    GROUP BY tech_id
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
    computed_at
  )
  SELECT
    p_date                                                         AS kpi_date,
    tm.id                                                          AS team_member_id,
    tm.name                                                        AS member_name,
    tm.department                                                  AS department,
    tm.entity                                                      AS entity,

    -- Delivery columns (only populate when this is a delivery member).
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

    -- Service columns.
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
    CASE WHEN tm.department = 'service' THEN s.billable_hours END,
    CASE WHEN tm.department = 'service' THEN s.total_hours END,
    CASE WHEN tm.department = 'service' AND COALESCE(s.total_hours, 0) > 0 THEN
      s.billable_hours / s.total_hours * 100
    END,
    CASE WHEN tm.department = 'service' AND COALESCE(s.jobs, 0) > 0 THEN
      s.first_fix_count::numeric / s.jobs * 100
    END,
    CASE WHEN tm.department = 'service' THEN s.avg_response_min END,

    -- Reman columns.
    CASE WHEN tm.department = 'reman' THEN COALESCE(r.units, 0) END,
    CASE WHEN tm.department = 'reman' THEN COALESCE(r.revenue, 0) END,
    CASE WHEN tm.department = 'reman' THEN
      COALESCE(r.parts_cost, 0) + COALESCE(r.labor_cost, 0)
    END,
    CASE WHEN tm.department = 'reman' AND COALESCE(r.units, 0) > 0 THEN
      COALESCE(r.labor_cost, 0) / r.units
    END,
    CASE WHEN tm.department = 'reman' AND COALESCE(r.units, 0) > 0 THEN
      COALESCE(r.parts_cost, 0) / r.units
    END,
    CASE WHEN tm.department = 'reman' AND COALESCE(r.units, 0) > 0 THEN
      (COALESCE(r.revenue, 0) - COALESCE(r.parts_cost, 0) - COALESCE(r.labor_cost, 0)) / r.units
    END,
    CASE WHEN tm.department = 'reman' THEN r.turnaround_days END,

    now() AS computed_at
  FROM ops.team_members tm
    LEFT JOIN del d ON d.tm_id = tm.id
    LEFT JOIN svc s ON s.tm_id = tm.id
    LEFT JOIN rmn r ON r.tm_id = tm.id
  WHERE tm.active = true
    AND tm.department IN ('delivery', 'service', 'reman')
  ON CONFLICT (kpi_date, team_member_id) DO UPDATE SET
    member_name      = EXCLUDED.member_name,
    department       = EXCLUDED.department,
    entity           = EXCLUDED.entity,
    stops_completed  = EXCLUDED.stops_completed,
    delivery_revenue = EXCLUDED.delivery_revenue,
    delivery_cost    = EXCLUDED.delivery_cost,
    cost_per_stop    = EXCLUDED.cost_per_stop,
    revenue_per_stop = EXCLUDED.revenue_per_stop,
    margin_per_stop  = EXCLUDED.margin_per_stop,
    jobs_completed   = EXCLUDED.jobs_completed,
    service_revenue  = EXCLUDED.service_revenue,
    service_cost     = EXCLUDED.service_cost,
    cost_per_job     = EXCLUDED.cost_per_job,
    revenue_per_job  = EXCLUDED.revenue_per_job,
    billable_hours   = EXCLUDED.billable_hours,
    total_hours      = EXCLUDED.total_hours,
    utilization_pct  = EXCLUDED.utilization_pct,
    first_fix_pct    = EXCLUDED.first_fix_pct,
    avg_response_min = EXCLUDED.avg_response_min,
    units_completed  = EXCLUDED.units_completed,
    reman_revenue    = EXCLUDED.reman_revenue,
    reman_cost       = EXCLUDED.reman_cost,
    labor_per_unit   = EXCLUDED.labor_per_unit,
    parts_per_unit   = EXCLUDED.parts_per_unit,
    margin_per_unit  = EXCLUDED.margin_per_unit,
    turnaround_days  = EXCLUDED.turnaround_days,
    computed_at      = EXCLUDED.computed_at;

  GET DIAGNOSTICS rows_affected = ROW_COUNT;
  RETURN rows_affected;
END $$;

GRANT EXECUTE ON FUNCTION ops.fn_compute_kpi_daily(date) TO authenticated, service_role;

COMMENT ON FUNCTION ops.fn_compute_kpi_daily(date) IS
  'Compute and upsert ops.kpi_daily rows for a single date. Joins delivery_stops/service_jobs/reman_jobs to team_members via driver_id/tech_id. Idempotent. Called nightly by cron nightly-kpi-daily for current_date - 1.';

-- ------------------------------------------------------------------
-- 2. Nightly cron at 11:00 UTC for yesterday's KPIs.
-- ------------------------------------------------------------------
SELECT cron.schedule('nightly-kpi-daily', '0 11 * * *', $$
  SELECT ops.fn_compute_kpi_daily(current_date - 1);
$$);

-- ------------------------------------------------------------------
-- 3. Backfill the last 30 days at apply time so kpi_daily isn't empty
--    when dashboards first read it.
-- ------------------------------------------------------------------
DO $$
DECLARE
  d date;
BEGIN
  FOR d IN
    SELECT generate_series(current_date - 30, current_date - 1, interval '1 day')::date
  LOOP
    PERFORM ops.fn_compute_kpi_daily(d);
  END LOOP;
END $$;
