// Typed wrappers for ops.kpi_daily — the per-(date, team_member) rollup
// produced by ops.fn_compute_kpi_daily, which runs nightly at 11:00 UTC.
//
// Direct PostgREST queries; no RPC needed. The table has ~7 active members
// × 30+ days of backfill, so unfiltered scans stay sub-100ms.

import { sbq } from './rpc';

export type Department = 'delivery' | 'service' | 'reman';

export interface KpiDailyRow {
  id: number;
  kpi_date: string;
  team_member_id: number;
  member_name: string | null;
  department: Department;
  entity: string | null;

  // Delivery
  stops_completed: number | null;
  delivery_revenue: number | null;
  delivery_cost: number | null;
  cost_per_stop: number | null;
  revenue_per_stop: number | null;
  margin_per_stop: number | null;
  miles_driven: number | null;
  revenue_per_mile: number | null;

  // Service
  jobs_completed: number | null;
  service_revenue: number | null;
  service_cost: number | null;
  cost_per_job: number | null;
  revenue_per_job: number | null;
  billable_hours: number | null;
  total_hours: number | null;
  utilization_pct: number | null;
  first_fix_pct: number | null;
  avg_response_min: number | null;

  // Reman
  units_completed: number | null;
  reman_revenue: number | null;
  reman_cost: number | null;
  labor_per_unit: number | null;
  parts_per_unit: number | null;
  margin_per_unit: number | null;
  turnaround_days: number | null;

  computed_at: string;
}

// Fetch all kpi_daily rows for a department within a date window.
// Returns rows ordered by date ascending so chart consumers can use them
// directly without re-sorting.
export function fetchKpiDaily(opts: {
  department: Department;
  start: string;
  end: string;
}): Promise<KpiDailyRow[]> {
  const params = [
    'select=*',
    'department=eq.' + encodeURIComponent(opts.department),
    'kpi_date=gte.' + opts.start,
    'kpi_date=lte.' + opts.end,
    'order=kpi_date.asc,member_name.asc',
    'limit=5000',
  ].join('&');
  return sbq<KpiDailyRow>('kpi_daily', params);
}

// Aggregate helpers ---------------------------------------------------

export interface DailyAgg {
  kpi_date: string;
  activity: number;       // stops / jobs / units
  revenue: number;
  cost: number;
  margin: number;
}

// Sum across all members for each date — drives the daily activity chart.
export function aggregateByDay(rows: KpiDailyRow[], dept: Department): DailyAgg[] {
  const byDate = new Map<string, DailyAgg>();
  for (const r of rows) {
    const a = byDate.get(r.kpi_date) ?? {
      kpi_date: r.kpi_date,
      activity: 0,
      revenue: 0,
      cost: 0,
      margin: 0,
    };
    if (dept === 'delivery') {
      a.activity += Number(r.stops_completed || 0);
      a.revenue += Number(r.delivery_revenue || 0);
      a.cost += Number(r.delivery_cost || 0);
    } else if (dept === 'service') {
      a.activity += Number(r.jobs_completed || 0);
      a.revenue += Number(r.service_revenue || 0);
      a.cost += Number(r.service_cost || 0);
    } else {
      a.activity += Number(r.units_completed || 0);
      a.revenue += Number(r.reman_revenue || 0);
      a.cost += Number(r.reman_cost || 0);
    }
    a.margin = a.revenue - a.cost;
    byDate.set(r.kpi_date, a);
  }
  return Array.from(byDate.values()).sort((a, b) => a.kpi_date.localeCompare(b.kpi_date));
}

export interface MemberRollup {
  team_member_id: number;
  member_name: string;
  days_active: number;     // days with activity > 0
  activity: number;        // total stops / jobs / units
  revenue: number;
  cost: number;
  margin: number;
  margin_pct: number | null;
  // dept-specific extras (null when not applicable)
  utilization_pct: number | null;   // service: avg billable/total
  first_fix_pct: number | null;     // service: weighted by jobs
  avg_response_min: number | null;  // service: avg
  turnaround_days: number | null;   // reman: avg
}

// Per-member rollup for the breakdown table. Weighted aggregates where
// applicable (utilization, first-fix, turnaround) so members with more
// activity dominate.
export function rollupByMember(rows: KpiDailyRow[], dept: Department): MemberRollup[] {
  const byMember = new Map<number, {
    name: string;
    daysActive: number;
    activity: number;
    revenue: number;
    cost: number;
    billableHours: number;
    totalHours: number;
    firstFixWeight: number;
    firstFixSum: number;
    responseDays: number;
    responseSum: number;
    turnaroundDays: number;
    turnaroundSum: number;
  }>();

  for (const r of rows) {
    let activity = 0;
    let revenue = 0;
    let cost = 0;
    if (dept === 'delivery') {
      activity = Number(r.stops_completed || 0);
      revenue = Number(r.delivery_revenue || 0);
      cost = Number(r.delivery_cost || 0);
    } else if (dept === 'service') {
      activity = Number(r.jobs_completed || 0);
      revenue = Number(r.service_revenue || 0);
      cost = Number(r.service_cost || 0);
    } else {
      activity = Number(r.units_completed || 0);
      revenue = Number(r.reman_revenue || 0);
      cost = Number(r.reman_cost || 0);
    }
    const cur = byMember.get(r.team_member_id) ?? {
      name: r.member_name ?? '(unnamed)',
      daysActive: 0,
      activity: 0,
      revenue: 0,
      cost: 0,
      billableHours: 0,
      totalHours: 0,
      firstFixWeight: 0,
      firstFixSum: 0,
      responseDays: 0,
      responseSum: 0,
      turnaroundDays: 0,
      turnaroundSum: 0,
    };
    cur.activity += activity;
    cur.revenue += revenue;
    cur.cost += cost;
    if (activity > 0) cur.daysActive += 1;
    if (dept === 'service') {
      if (r.billable_hours != null) cur.billableHours += Number(r.billable_hours);
      if (r.total_hours != null) cur.totalHours += Number(r.total_hours);
      if (r.first_fix_pct != null && activity > 0) {
        cur.firstFixSum += Number(r.first_fix_pct) * activity;
        cur.firstFixWeight += activity;
      }
      if (r.avg_response_min != null) {
        cur.responseSum += Number(r.avg_response_min);
        cur.responseDays += 1;
      }
    }
    if (dept === 'reman' && r.turnaround_days != null) {
      cur.turnaroundSum += Number(r.turnaround_days);
      cur.turnaroundDays += 1;
    }
    byMember.set(r.team_member_id, cur);
  }

  return Array.from(byMember.entries()).map(([id, m]) => {
    const margin = m.revenue - m.cost;
    return {
      team_member_id: id,
      member_name: m.name,
      days_active: m.daysActive,
      activity: m.activity,
      revenue: m.revenue,
      cost: m.cost,
      margin,
      margin_pct: m.revenue > 0 ? margin / m.revenue : null,
      utilization_pct: dept === 'service' && m.totalHours > 0
        ? (m.billableHours / m.totalHours) * 100
        : null,
      first_fix_pct: dept === 'service' && m.firstFixWeight > 0
        ? m.firstFixSum / m.firstFixWeight
        : null,
      avg_response_min: dept === 'service' && m.responseDays > 0
        ? m.responseSum / m.responseDays
        : null,
      turnaround_days: dept === 'reman' && m.turnaroundDays > 0
        ? m.turnaroundSum / m.turnaroundDays
        : null,
    };
  }).sort((a, b) => b.activity - a.activity);
}
