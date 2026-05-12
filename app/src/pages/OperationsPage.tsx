import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef, type GridRenderCellParams } from '@mui/x-data-grid-pro';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { Printer } from 'lucide-react';
import { KPICard } from '../components/KPICard';
import { AreaChart } from '../components/charts/AreaChart';
import { BarChart } from '../components/charts/BarChart';
import { CHART_COLORS } from '../components/charts/util';
import { fm, fp, fmtNum } from '../lib/formatters';
import { downloadCsv, toCsv } from '../lib/csv';
import { KpiRowSkeleton, ChartSkeleton, TableSkeleton } from '../components/Skeletons';
import { useToast } from '../lib/toast';
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

interface MemberGridRow extends MemberRollup {
  id: number;
  rev_per_activity: number | null;
  cost_per_activity: number | null;
}

export function OperationsPage() {
  const toast = useToast();
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

  const gridRows: MemberGridRow[] = useMemo(() => members.map((m) => ({
    ...m,
    id: m.team_member_id,
    rev_per_activity: m.activity > 0 ? m.revenue / m.activity : null,
    cost_per_activity: m.activity > 0 ? m.cost / m.activity : null,
  })), [members]);

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

  const columns: GridColDef[] = useMemo(() => columnsForTab(tab), [tab]);

  function setQuickRange(days: number) {
    const t = new Date();
    setEnd(t.toISOString().slice(0, 10));
    setStart(new Date(t.getTime() - days * 86400000).toISOString().slice(0, 10));
  }

  function exportCsv() {
    if (!members.length) return;
    const head = headerForTab(tab);
    const data = members.map((m) => rowForTab(tab, m));
    downloadCsv(`operations_${tab}_${start}_${end}.csv`, toCsv([head, ...data]));
    toast.success(`Exported ${data.length} ${tab} members to CSV`);
  }

  function printDashboard() {
    toast.info('Opening print preview…');
    setTimeout(() => window.print(), 250);
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
            {rows ? ` · ${members.length} active member${members.length === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className="hero-stamp">
            <span className="status-dot" aria-hidden="true" />
            {tabLabel}
          </div>
          <button
            onClick={printDashboard}
            className="tb-btn tb-btn--primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Printer size={13} strokeWidth={2.4} aria-hidden="true" />
            <span>Print</span>
          </button>
        </div>
      </div>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v as Department)}
        sx={{
          minHeight: 36,
          mb: 1.5,
          borderBottom: '1px solid var(--bd)',
          '& .MuiTabs-indicator': { background: 'var(--ac)', height: 2 },
          '& .MuiTab-root': {
            minHeight: 36,
            padding: '6px 18px',
            textTransform: 'uppercase',
            color: 'var(--mt)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.6,
            fontFamily: 'inherit',
          },
          '& .Mui-selected': { color: 'var(--ac) !important' },
        }}
      >
        {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
      </Tabs>

      <div className="toolbar">
        <div className="toolbar-row">
          <div className="toolbar-section">
            <span className="toolbar-label">From</span>
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="date-input"
            />
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">To</span>
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="date-input"
            />
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">Quick</span>
            <button onClick={() => setQuickRange(7)}  className="tb-btn">7d</button>
            <button onClick={() => setQuickRange(30)} className="tb-btn">30d</button>
            <button onClick={() => setQuickRange(90)} className="tb-btn">90d</button>
          </div>
          <div className="toolbar-spacer" />
          <button onClick={exportCsv} disabled={!members.length} className="tb-btn tb-btn--primary">
            Export CSV
          </button>
        </div>
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
            <KPICard
              title={activityLabel}
              value={fmtNum(totals.activity)}
              sub={totals.perDay.toFixed(1) + ' / day'}
            />
            <KPICard
              title="REVENUE"
              value={fm(totals.revenue)}
              sub={totals.perActivity != null ? fm(totals.perActivity) + ' ' + perActivityLabel : '—'}
            />
            <KPICard
              title="MARGIN"
              value={fm(totals.margin)}
              sub={fp(totals.marginPct)}
              accent={
                totals.marginPct == null
                  ? undefined
                  : totals.marginPct >= 0.3 ? 'var(--gn)'
                  : totals.marginPct >= 0 ? 'var(--am)'
                  : 'var(--rd)'
              }
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
                accent={
                  serviceAgg?.utilizationPct == null
                    ? undefined
                    : serviceAgg.utilizationPct >= 70 ? 'var(--gn)'
                    : serviceAgg.utilizationPct >= 50 ? 'var(--am)'
                    : 'var(--rd)'
                }
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

          <div className="cd" style={{ padding: 14, marginBottom: 12 }}>
            <div className="ct" style={{ marginTop: 0, marginBottom: 10 }}>
              {activityLabel} PER DAY
            </div>
            <AreaChart
              labels={daily.map((d) => d.kpi_date.slice(5))}
              series={[{
                name: activityLabel.toLowerCase(),
                color: CHART_COLORS[0],
                values: daily.map((d) => d.activity),
              }]}
              ariaLabel={`${tab} ${activityLabel.toLowerCase()} per day`}
              formatValue={(v) => fmtNum(v)}
            />
          </div>

          <div className="cd" style={{ padding: 14, marginBottom: 12 }}>
            <div className="ct" style={{ marginTop: 0, marginBottom: 10 }}>
              {activityLabel} BY MEMBER · TOP 12
            </div>
            <BarChart
              data={members.slice(0, 12).map((m) => ({ label: m.member_name, value: m.activity }))}
              ariaLabel={`${tab} activity by member`}
              formatValue={(v) => fmtNum(v)}
            />
          </div>

          <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
              <div className="ct" style={{ margin: 0 }}>BY MEMBER — {members.length}</div>
            </div>
            <DataGridPro
              rows={gridRows}
              columns={columns}
              density="compact"
              pagination
              pageSizeOptions={[10, 20, 40, 60, 100, { value: -1, label: 'All' }]}
              initialState={{
                pagination: { paginationModel: { pageSize: 20, page: 0 } },
                pinnedColumns: { left: ['member_name'] },
                sorting: { sortModel: [{ field: 'activity', sort: 'desc' }] },
              }}
              disableRowSelectionOnClick
              sx={{
                height: '52vh',
                border: 'none',
                background: 'transparent',
                color: 'var(--tx)',
                fontFamily: 'inherit',
                fontSize: 12,
                '& .MuiDataGrid-columnHeaders': { background: 'var(--sf)', borderBottom: '1px solid var(--bd)' },
                '& .MuiDataGrid-columnHeader': {
                  fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
                  fontSize: 10.5, color: 'var(--mt)',
                },
                '& .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within': { outline: 'none' },
                '& .MuiDataGrid-cell': { borderBottom: '1px solid rgba(255,255,255,0.04)', py: 0.5 },
                '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': { outline: 'none' },
                '& .MuiDataGrid-row:hover': { background: 'rgba(91,181,240,0.06)' },
                '& .MuiDataGrid-pinnedColumns': { background: 'var(--sf)', boxShadow: '4px 0 12px rgba(0,0,0,0.35)' },
                '& .MuiDataGrid-pinnedColumnHeaders': { background: 'var(--sf)' },
                '& .MuiDataGrid-footerContainer': {
                  borderTop: '1px solid var(--bd)',
                  background: 'var(--sf)',
                  minHeight: 40,
                },
                '& .MuiTablePagination-root, & .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows': {
                  color: 'var(--mt)',
                  fontFamily: 'inherit',
                  fontSize: 11,
                },
                '& .MuiTablePagination-select': { color: 'var(--ac)' },
                '& .mn': { fontFeatureSettings: '"tnum" on, "lnum" on' },
                '& .MuiDataGrid-menuIconButton, & .MuiDataGrid-sortIcon': { color: 'var(--mt)' },
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function columnsForTab(dept: Department): GridColDef[] {
  const base: GridColDef[] = [
    {
      field: 'member_name',
      headerName: dept === 'delivery' ? 'Driver' : 'Tech',
      flex: 1,
      minWidth: 180,
      renderCell: (p: GridRenderCellParams<MemberGridRow>) => (
        <span style={{ fontWeight: 600 }}>{p.value as string}</span>
      ),
    },
    { field: 'days_active', headerName: 'Days', type: 'number', width: 70, cellClassName: 'mn' },
    {
      field: 'activity',
      headerName: dept === 'delivery' ? 'Stops' : dept === 'service' ? 'Jobs' : 'Units',
      type: 'number',
      width: 90,
      cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)),
    },
    {
      field: 'revenue',
      headerName: 'Revenue',
      type: 'number',
      width: 130,
      cellClassName: 'mn',
      renderCell: (p: GridRenderCellParams<MemberGridRow>) => (
        <span style={{ fontWeight: 600 }}>{fm(Number(p.value ?? 0))}</span>
      ),
    },
    {
      field: 'cost',
      headerName: 'Cost',
      type: 'number',
      width: 120,
      cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : fm(Number(v))),
    },
    {
      field: 'margin',
      headerName: 'Margin',
      type: 'number',
      width: 130,
      cellClassName: 'mn',
      renderCell: (p: GridRenderCellParams<MemberGridRow>) => {
        const v = Number(p.value ?? 0);
        return (
          <span style={{ fontWeight: 600, color: v >= 0 ? 'var(--gn)' : 'var(--rd)' }}>{fm(v)}</span>
        );
      },
    },
    {
      field: 'margin_pct',
      headerName: 'Margin %',
      type: 'number',
      width: 95,
      cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : fp(Number(v))),
    },
  ];

  if (dept === 'delivery') {
    return [
      ...base,
      {
        field: 'rev_per_activity',
        headerName: 'Rev/Stop',
        type: 'number',
        width: 100,
        cellClassName: 'mn',
        valueFormatter: (v) => (v == null ? '—' : fm(Number(v))),
      },
      {
        field: 'cost_per_activity',
        headerName: 'Cost/Stop',
        type: 'number',
        width: 100,
        cellClassName: 'mn',
        valueFormatter: (v) => (v == null ? '—' : fm(Number(v))),
      },
    ];
  }

  if (dept === 'service') {
    return [
      ...base,
      {
        field: 'utilization_pct',
        headerName: 'Util %',
        type: 'number',
        width: 85,
        cellClassName: 'mn',
        valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(1) + '%'),
      },
      {
        field: 'first_fix_pct',
        headerName: 'First-Fix %',
        type: 'number',
        width: 105,
        cellClassName: 'mn',
        valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(0) + '%'),
      },
      {
        field: 'avg_response_min',
        headerName: 'Avg Resp (min)',
        type: 'number',
        width: 130,
        cellClassName: 'mn',
        valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(0)),
      },
    ];
  }

  return [
    ...base,
    {
      field: 'turnaround_days',
      headerName: 'Turnaround (d)',
      type: 'number',
      width: 130,
      cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(1)),
    },
  ];
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
