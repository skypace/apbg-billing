import { useEffect, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { KPICard } from '../../components/KPICard';
import { fm } from '../../lib/formatters';
import { PlanForecastRow, SalesPlan, fetchPlanForecast } from '../../lib/plans';
import { GRID_SX, GRID_DEFAULTS } from '../../lib/gridStyles';

interface Props { plan: SalesPlan }

const STATUS_COLOR: Record<string, string> = {
  ahead: 'var(--gn)',
  on_track: 'var(--ac)',
  behind: 'var(--am)',
  critical: 'var(--rd)',
  no_data: 'var(--mt)',
};

const num = (v: unknown) => Number(v ?? 0);

const FORECAST_COLUMNS: GridColDef<PlanForecastRow>[] = [
  {
    field: 'item_name', headerName: 'Item', flex: 1, minWidth: 200,
    renderCell: (p) => <span style={{ fontWeight: 600 }} title={p.row.item_name ?? ''}>{p.row.item_name ?? '—'}</span>,
  },
  {
    field: 'account_name', headerName: 'Account', width: 160,
    renderCell: (p) => <span style={{ fontSize: 11, color: 'var(--mt)' }}>{p.row.account_name ?? '—'}</span>,
  },
  {
    field: 'ytd_actual', headerName: 'YTD Actual', type: 'number', width: 120, cellClassName: 'mn',
    valueGetter: (_v, row) => num(row.ytd_actual), renderCell: (p) => fm(p.row.ytd_actual),
  },
  {
    field: 'ytd_plan', headerName: 'YTD Plan', type: 'number', width: 110, cellClassName: 'mn',
    valueGetter: (_v, row) => num(row.ytd_plan), renderCell: (p) => <span style={{ color: 'var(--mt)' }}>{fm(p.row.ytd_plan)}</span>,
  },
  {
    field: 'projected_full_year', headerName: 'Projected FY', type: 'number', width: 130, cellClassName: 'mn',
    valueGetter: (_v, row) => num(row.projected_full_year), renderCell: (p) => <span style={{ fontWeight: 600 }}>{fm(p.row.projected_full_year)}</span>,
  },
  {
    field: 'full_year_plan', headerName: 'Plan FY', type: 'number', width: 120, cellClassName: 'mn',
    valueGetter: (_v, row) => num(row.full_year_plan), renderCell: (p) => <span style={{ color: 'var(--mt)' }}>{fm(p.row.full_year_plan)}</span>,
  },
  {
    field: 'projected_vs_plan_pct', headerName: 'Δ vs Plan', type: 'number', width: 110, cellClassName: 'mn',
    valueGetter: (_v, row) => Number(row.projected_vs_plan_pct),
    renderCell: (p) => {
      const dPct = Number(p.row.projected_vs_plan_pct);
      const color = STATUS_COLOR[p.row.status] ?? 'var(--mt)';
      return <span style={{ color, fontWeight: 600 }}>{isFinite(dPct) ? (dPct >= 0 ? '+' : '') + (dPct * 100).toFixed(0) + '%' : '—'}</span>;
    },
  },
  {
    field: 'status', headerName: 'Status', width: 120,
    renderCell: (p) => {
      const color = STATUS_COLOR[p.row.status] ?? 'var(--mt)';
      return (
        <span style={{ background: 'rgba(255,255,255,0.04)', color, border: '1px solid ' + color, padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>
          {p.row.status.toUpperCase().replace('_', ' ')}
        </span>
      );
    },
  },
];

export function PlanForecast({ plan }: Props) {
  const [rows, setRows] = useState<PlanForecastRow[] | null>(null);

  useEffect(() => {
    fetchPlanForecast(plan.id).then(setRows).catch(() => setRows([]));
  }, [plan.id]);

  if (!rows) return <div className="cd" style={{ padding: 14 }}>Computing forecast…</div>;

  const totalFY    = rows.reduce((s, r) => s + Number(r.full_year_plan ?? 0), 0);
  const totalProj  = rows.reduce((s, r) => s + Number(r.projected_full_year ?? 0), 0);
  const totalAct   = rows.reduce((s, r) => s + Number(r.ytd_actual ?? 0), 0);
  const monthsDone = rows[0]?.months_complete ?? 0;
  const deltaPct   = totalFY > 0 ? (totalProj - totalFY) / totalFY : null;
  const critical   = rows.filter((r) => r.status === 'critical');
  const behind     = rows.filter((r) => r.status === 'behind');
  const ahead      = rows.filter((r) => r.status === 'ahead');

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 10 }}>
        <KPICard title="FULL-YEAR PLAN" value={fm(totalFY)} sub={`${rows.length} lines · FY${plan.fiscal_year}`} />
        <KPICard title="YTD ACTUAL" value={fm(totalAct)} sub={monthsDone + ' months complete'} />
        <KPICard
          title="PROJECTED FULL-YEAR"
          value={fm(totalProj)}
          accent={deltaPct == null ? undefined : deltaPct >= 0 ? 'var(--gn)' : 'var(--rd)'}
          sub={
            deltaPct == null
              ? ''
              : (deltaPct >= 0 ? '+' : '') + (deltaPct * 100).toFixed(1) + '% vs plan'
          }
        />
        <KPICard
          title="CRITICAL / BEHIND"
          value={`${critical.length} / ${behind.length}`}
          accent="var(--rd)"
          sub={`${ahead.length} ahead`}
        />
      </div>

      <div className="cd" style={{ padding: 0 }}>
        <DataGridPro
          rows={rows}
          columns={FORECAST_COLUMNS}
          getRowId={(r) => r.line_id}
          density="compact"
          pagination
          disableRowSelectionOnClick
          {...GRID_DEFAULTS}
          pageSizeOptions={[25, 50, 100, { value: -1, label: 'All' }]}
          initialState={{
            pagination: { paginationModel: { pageSize: 50, page: 0 } },
            sorting: { sortModel: [{ field: 'full_year_plan', sort: 'desc' }] },
          }}
          sx={{ ...GRID_SX, height: '58vh' }}
        />
      </div>
    </div>
  );
}
