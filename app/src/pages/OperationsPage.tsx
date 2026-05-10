import { useEffect, useMemo, useState } from 'react';
import { KPICard } from '../components/KPICard';
import { AreaChart } from '../components/charts/AreaChart';
import { BarChart } from '../components/charts/BarChart';
import { CHART_COLORS } from '../components/charts/util';
import { fm, fp, fmtNum } from '../lib/formatters';
import { btnSecondary, inp } from '../lib/styles';
import { downloadCsv, toCsv } from '../lib/csv';
import { KpiRowSkeleton, ChartSkeleton, TableSkeleton } from '../components/Skeletons';
import {
  Department,
  KpiDailyRow,
  MemberRollup,
  aggregateByDay,
  fetchKpiDaily,
  rollupByMember,
} from '../lib/kpi';

const TABS: { id: Department; label: string }[] = [
  { id: 'delivery', label: 'Delivery' },
  { id: 'service',  label: 'Service' },
  { id: 'reman',    label: 'Reman' },
];

const DEFAULT_WINDOW_DAYS = 30;

export function OperationsPage() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const defaultStart = new Date(today.getTime() - DEFAULT_WINDOW_DAYS * 86400000)
    .toISOString().slice(0, 10);

  const [tab, setTab] = useState<Department>('delivery');
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(todayStr);
  const [rows, setRows] = useState<KpiDailyRow[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr('');
    fetchKpiDaily({ department: tab, start, end })
      .then((rs) => { if (!cancelled) setRows(rs); })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [tab, start, end]);

  const daily = useMemo(() => (rows ? aggregateByDay(rows, tab) : []), [rows, tab]);
  const members = useMemo(() => (rows ? rollupByMember(rows, tab) : []), [rows, tab]);

  const totals = useMemo(() => {
    const activity = daily.reduce((s, d) => s + d.activity, 0);
    const revenue = daily.reduce((s, d) => s + d.revenue, 0);
    const cost = daily.reduce((s, d) => s + d.cost, 0);
    const margin = revenue - cost;
    const days = daily.length || 1;
    return {
      activity,
      revenue,
      cost,
      margin,
      marginPct: revenue > 0 ? margin / revenue : null,
      perDay: activity / days,
      perActivity: activity > 0 ? revenue / activity : null,
      costPerActivity: activity > 0 ? cost / activity : null,
    };
  }, [daily]);

  const serviceAgg = useMemo(() => {
    if (tab !== 'service' || !rows) return null;
    let billable = 0, total = 0, ffWeight = 0, ffSum = 0, respDays = 0, respSum = 0;
    for (const r of rows) {
      if (r.billable_hours != null) billable += Number(r.billable_hours);
      if (r.total_hours != null) total += Number(r.total_hours);
      if (r.first_fix_pct != null && r.jobs_completed && r.jobs_completed > 0) {
        ffSum += Number(r.first_fix_pct) * r.jobs_completed;
        ffWeight += r.jobs_completed;
      }
      if (r.avg_response_min != null) {
        respSum += Number(r.avg_response_min);
        respDays += 1;
      }
    }
    return {
      utilizationPct: total > 0 ? (billable / total) * 100 : null,
      firstFixPct: ffWeight > 0 ? ffSum / ffWeight : null,
      avgResponseMin: respDays > 0 ? respSum / respDays : null,
    };
  }, [tab, rows]);

  const remanAgg = useMemo(() => {
    if (tab !== 'reman' || !rows) return null;
    const turnaround = rows
      .filter((r) => r.turnaround_days != null)
      .map((r) => Number(r.turnaround_days));
    return {
      avgTurnaround: turnaround.length > 0
        ? turnaround.reduce((s, v) => s + v, 0) / turnaround.length
        : null,
    };
  }, [tab, rows]);

  function exportCsv() {
    if (!members.length) return;
    const head = headerForTab(tab);
    const data = members.map((m) => rowForTab(tab, m));
    downloadCsv(`operations_${tab}_${start}_${end}.csv`, toCsv([head, ...data]));
  }

  const activityLabel = tab === 'delivery' ? 'STOPS' : tab === 'service' ? 'JOBS' : 'UNITS';
  const perActivityLabel = tab === 'delivery' ? 'rev/stop' : tab === 'service' ? 'rev/job' : 'rev/unit';
  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? '';

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Delivery · Service · Reman · Daily KPI</div>
          <h1 className="hero-title">Operations</h1>
          <div className="hero-meta">
            {tabLabel} · {start} → {end}
          </div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          {members.length} active member{members.length === 1 ? '' : 's'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={'tb-btn' + (on ? ' tb-btn--primary' : '')}
              style={on ? { fontWeight: 700 } : undefined}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 14,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 11,
        }}
      >
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>From</span>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="date-input" />
        <span style={{ color: 'var(--mt)' }}>to</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="date-input" />

        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={exportCsv} disabled={!members.length} style={btnSecondary()}>EXPORT CSV</button>
        </span>
      </div>

      {err ? (
        <div className="cd" style={{ padding: 14, color: 'var(--rd)' }}>Error: {err}</div>
      ) : !rows ? (
        <>
          <KpiRowSkeleton count={4} />
          <div className="cd" style={{ padding: 0, marginBottom: 14 }}>
            <ChartSkeleton />
          </div>
          <div className="cd" style={{ padding: 0 }}>
            <TableSkeleton rows={6} cols={6} />
          </div>
        </>
      ) : rows.length === 0 ? (
        <div className="cd" style={{ padding: 14, color: 'var(--mt)' }}>
          No kpi_daily rows in this window. Either nobody in this department has been active, or the
          rollup hasn't backfilled this date range yet.
        </div>
      ) : (
        <>
          <div className="gr g4" style={{ marginBottom: 12 }}>
            <KPICard title={activityLabel} value={fmtNum(totals.activity)} sub={totals.perDay.toFixed(1) + ' / day'} />
            <KPICard title="REVENUE" value={fm(totals.revenue)} sub={totals.perActivity != null ? fm(totals.perActivity) + ' ' + perActivityLabel : '—'} />
            <KPICard
              title="MARGIN"
              value={fm(totals.margin)}
              sub={fp(totals.marginPct)}
              accent={totals.marginPct == null ? undefined : totals.marginPct >= 0.3 ? 'var(--gn)' : totals.marginPct >= 0 ? 'var(--am)' : 'var(--rd)'}
            />
            {tab === 'delivery' && (
              <KPICard
                title="COST / STOP"
                value={totals.costPerActivity != null ? fm(totals.costPerActivity) : '—'}
                sub={fm(totals.cost) + ' total cost'}
              />
            )}
            {tab === 'service' && (
              <KPICard
                title="UTILIZATION"
                value={serviceAgg?.utilizationPct != null ? serviceAgg.utilizationPct.toFixed(1) + '%' : '—'}
                sub={serviceAgg?.firstFixPct != null ? serviceAgg.firstFixPct.toFixed(0) + '% first-fix' : '—'}
                accent={serviceAgg?.utilizationPct == null ? undefined : serviceAgg.utilizationPct >= 70 ? 'var(--gn)' : serviceAgg.utilizationPct >= 50 ? 'var(--am)' : 'var(--rd)'}
              />
            )}
            {tab === 'reman' && (
              <KPICard
                title="TURNAROUND"
                value={remanAgg?.avgTurnaround != null ? remanAgg.avgTurnaround.toFixed(1) + ' d' : '—'}
                sub={fm(totals.cost) + ' total cost'}
              />
            )}
          </div>

          <div className="cd" style={{ padding: 8, marginBottom: 12 }}>
            <AreaChart
              labels={daily.map((d) => d.kpi_date.slice(5))}
              series={[
                { name: activityLabel.toLowerCase(), color: CHART_COLORS[0], values: daily.map((d) => d.activity) },
              ]}
              ariaLabel={`${tab} ${activityLabel.toLowerCase()} per day`}
              formatValue={(v) => fmtNum(v)}
            />
          </div>

          <div className="cd" style={{ padding: 8, marginBottom: 12 }}>
            <BarChart
              data={members.slice(0, 12).map((m) => ({
                label: m.member_name,
                value: m.activity,
              }))}
              ariaLabel={`${tab} activity by member`}
              formatValue={(v) => fmtNum(v)}
            />
          </div>

          <div className="cd" style={{ padding: 0 }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
              <div className="ct" style={{ margin: 0 }}>BY MEMBER — {members.length}</div>
            </div>
            <div style={{ maxHeight: '50vh', overflow: 'auto' }}>
              <table>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                  <tr>{headerForTab(tab).map((h, i) => (
                    <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.team_member_id}>
                      {rowForTab(tab, m).map((cell, i) => (
                        <td
                          key={i}
                          className={i === 0 ? '' : 'mn'}
                          style={{
                            textAlign: i === 0 ? 'left' : 'right',
                            fontWeight: i === 0 ? 600 : undefined,
                          }}
                        >
                          {cell as string | number}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function headerForTab(dept: Department): string[] {
  if (dept === 'delivery') {
    return ['Driver', 'Days Active', 'Stops', 'Revenue', 'Cost', 'Margin', 'Margin %', 'Rev/Stop', 'Cost/Stop'];
  }
  if (dept === 'service') {
    return ['Tech', 'Days Active', 'Jobs', 'Revenue', 'Cost', 'Margin', 'Margin %', 'Util %', 'First-Fix %', 'Avg Resp (min)'];
  }
  return ['Tech', 'Days Active', 'Units', 'Revenue', 'Cost', 'Margin', 'Margin %', 'Turnaround (d)'];
}

function rowForTab(dept: Department, m: MemberRollup): (string | number)[] {
  const common = [
    m.member_name,
    m.days_active,
    fmtNum(m.activity),
    fm(m.revenue),
    fm(m.cost),
    fm(m.margin),
    fp(m.margin_pct),
  ];
  if (dept === 'delivery') {
    return [
      ...common,
      m.activity > 0 ? fm(m.revenue / m.activity) : '—',
      m.activity > 0 ? fm(m.cost / m.activity) : '—',
    ];
  }
  if (dept === 'service') {
    return [
      ...common,
      m.utilization_pct != null ? m.utilization_pct.toFixed(1) + '%' : '—',
      m.first_fix_pct != null ? m.first_fix_pct.toFixed(0) + '%' : '—',
      m.avg_response_min != null ? m.avg_response_min.toFixed(0) : '—',
    ];
  }
  return [
    ...common,
    m.turnaround_days != null ? m.turnaround_days.toFixed(1) : '—',
  ];
}
