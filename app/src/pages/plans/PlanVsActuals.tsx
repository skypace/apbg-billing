import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { fm, fp } from '../../lib/formatters';
import { MONTHS_SHORT, SalesPlan, SalesPlanLine } from '../../lib/plans';
import { GRID_SX, GRID_DEFAULTS } from '../../lib/gridStyles';

interface Props {
  plan: SalesPlan;
  lines: SalesPlanLine[];
  actualsByItem: Record<string, { amounts: number[]; total: number }> | null;
}

interface VsRow {
  id: string | number;
  item_name: string | null;
  ytdPlan: number; ytdAct: number; ytdVar: number | null;
  totalPlan: number; totalAct: number; fyVar: number | null;
}

const varColor = (v: number | null) =>
  v == null ? 'var(--mt)' : v >= 0 ? 'var(--gn)' : v <= -0.1 ? 'var(--rd)' : 'var(--am)';

const VS_COLUMNS: GridColDef<VsRow>[] = [
  {
    field: 'item_name', headerName: 'Item', flex: 1, minWidth: 200,
    renderCell: (p) => <span style={{ fontWeight: 600 }} title={p.row.item_name ?? ''}>{p.row.item_name ?? '—'}</span>,
  },
  { field: 'ytdPlan', headerName: 'YTD Plan', type: 'number', width: 120, cellClassName: 'mn', renderCell: (p) => fm(p.row.ytdPlan) },
  { field: 'ytdAct', headerName: 'YTD Actual', type: 'number', width: 120, cellClassName: 'mn', renderCell: (p) => fm(p.row.ytdAct) },
  {
    field: 'ytdVar', headerName: 'YTD Δ%', type: 'number', width: 100, cellClassName: 'mn',
    valueGetter: (_v, row) => row.ytdVar ?? -Infinity,
    renderCell: (p) => <span style={{ color: varColor(p.row.ytdVar), fontWeight: 600 }}>{fp(p.row.ytdVar)}</span>,
  },
  { field: 'totalPlan', headerName: 'FY Plan', type: 'number', width: 120, cellClassName: 'mn', renderCell: (p) => <span style={{ color: 'var(--mt)' }}>{fm(p.row.totalPlan)}</span> },
  { field: 'totalAct', headerName: 'FY Actual', type: 'number', width: 120, cellClassName: 'mn', renderCell: (p) => fm(p.row.totalAct) },
  {
    field: 'fyVar', headerName: 'FY Δ%', type: 'number', width: 100, cellClassName: 'mn',
    valueGetter: (_v, row) => row.fyVar ?? -Infinity,
    renderCell: (p) => <span style={{ color: varColor(p.row.fyVar), fontWeight: 600 }}>{fp(p.row.fyVar)}</span>,
  },
];

export function PlanVsActuals({ plan, lines, actualsByItem }: Props) {
  if (!actualsByItem) {
    return <div className="cd" style={{ padding: 14 }}>Loading actuals for FY{plan.fiscal_year}…</div>;
  }

  const today = new Date();
  const elapsedIdx =
    today.getFullYear() === plan.fiscal_year
      ? today.getMonth()
      : today.getFullYear() > plan.fiscal_year
        ? 12
        : 0;

  function summarize(line: SalesPlanLine) {
    const amts = line.amounts ?? Array(12).fill(0);
    const act = actualsByItem?.[line.item_name ?? '']?.amounts ?? Array(12).fill(0);
    const totalPlan = amts.reduce((s, v) => s + Number(v || 0), 0);
    const totalAct = act.reduce((s, v) => s + Number(v || 0), 0);
    let ytdPlan = 0, ytdAct = 0;
    for (let i = 0; i < elapsedIdx; i++) {
      ytdPlan += Number(amts[i] || 0);
      ytdAct  += Number(act[i] || 0);
    }
    const ytdVar = ytdPlan === 0 ? null : (ytdAct - ytdPlan) / ytdPlan;
    const fyVar  = totalPlan === 0 ? null : (totalAct - totalPlan) / totalPlan;
    return { totalPlan, totalAct, ytdPlan, ytdAct, ytdVar, fyVar, amts, act };
  }

  const gridRows: VsRow[] = lines.map((l) => {
    const s = summarize(l);
    return {
      id: l.id, item_name: l.item_name ?? null,
      ytdPlan: s.ytdPlan, ytdAct: s.ytdAct, ytdVar: s.ytdVar,
      totalPlan: s.totalPlan, totalAct: s.totalAct, fyVar: s.fyVar,
    };
  });

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--bd)',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <div className="ct" style={{ margin: 0 }}>VS ACTUALS — through {MONTHS_SHORT[Math.max(0, elapsedIdx - 1)]} {plan.fiscal_year}</div>
        <div style={{ fontSize: 10, color: 'var(--mt)' }}>{elapsedIdx} months elapsed</div>
      </div>
      <DataGridPro
        rows={gridRows}
        columns={VS_COLUMNS}
        density="compact"
        pagination
        disableRowSelectionOnClick
        {...GRID_DEFAULTS}
        pageSizeOptions={[25, 50, 100, { value: -1, label: 'All' }]}
        initialState={{
          pagination: { paginationModel: { pageSize: 50, page: 0 } },
          sorting: { sortModel: [{ field: 'totalPlan', sort: 'desc' }] },
        }}
        sx={{ ...GRID_SX, height: '60vh', border: 'none' }}
      />
    </div>
  );
}
