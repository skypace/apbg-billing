import { useEffect, useMemo, useState } from 'react';
import type { GridColDef } from '@mui/x-data-grid-pro';
import { ReportGrid } from '../../components/ReportGrid';
import { fm, fp } from '../../lib/formatters';
import { TopMoverRow, fetchTopMovers } from '../../lib/reports';

type Dim = 'customer' | 'item' | 'category' | 'segment';

const DIMS: { id: Dim; label: string }[] = [
  { id: 'customer', label: 'Customer' },
  { id: 'item',     label: 'Item' },
  { id: 'category', label: 'Category' },
  { id: 'segment',  label: 'Segment' },
];

export function TopMoversReport() {
  const today = new Date();
  const ytdStart = today.getFullYear() + '-01-01';
  const todayStr = today.toISOString().slice(0, 10);
  const priorYearStart = (today.getFullYear() - 1) + '-01-01';
  const priorYearEnd = (today.getFullYear() - 1) + '-12-31';

  const [f, setF] = useState({
    dim: 'customer' as Dim,
    current_start: ytdStart,
    current_end: todayStr,
    prior_start: priorYearStart,
    prior_end: priorYearEnd,
  });
  const [rows, setRows] = useState<TopMoverRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      fetchTopMovers({
        dim: f.dim, start: f.current_start, end: f.current_end,
        prev_start: f.prior_start, prev_end: f.prior_end, limit: 50,
      })
        .then((rs) => { if (!cancelled) setRows(rs); })
        .catch(() => { if (!cancelled) setRows([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [f.dim, f.current_start, f.current_end, f.prior_start, f.prior_end]);

  const { gainers, losers } = useMemo(() => {
    if (!rows) return { gainers: [], losers: [] };
    const g = rows.filter((r) => Number(r.delta_rev) > 0)
      .sort((a, b) => Number(b.delta_rev) - Number(a.delta_rev)).slice(0, 20);
    const l = rows.filter((r) => Number(r.delta_rev) < 0)
      .sort((a, b) => Number(a.delta_rev) - Number(b.delta_rev)).slice(0, 20);
    return { gainers: g, losers: l };
  }, [rows]);

  if (!rows) return <div className="ld">Loading…</div>;

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 10 }}>
        <div className="toolbar-row">
          <div className="toolbar-section">
            <span className="toolbar-label">Group by</span>
            <div className="seg" role="group" aria-label="Movers dim">
              {DIMS.map((d) => (
                <button key={d.id}
                  onClick={() => setF({ ...f, dim: d.id })}
                  className={'seg-btn' + (f.dim === d.id ? ' seg-btn--active' : '')}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">Current</span>
            <input type="date" value={f.current_start}
              onChange={(e) => setF({ ...f, current_start: e.target.value })} className="date-input" />
            <span style={{ color: 'var(--mt)', fontSize: 11 }}>to</span>
            <input type="date" value={f.current_end}
              onChange={(e) => setF({ ...f, current_end: e.target.value })} className="date-input" />
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">vs Prior</span>
            <input type="date" value={f.prior_start}
              onChange={(e) => setF({ ...f, prior_start: e.target.value })} className="date-input" />
            <span style={{ color: 'var(--mt)', fontSize: 11 }}>to</span>
            <input type="date" value={f.prior_end}
              onChange={(e) => setF({ ...f, prior_end: e.target.value })} className="date-input" />
          </div>
        </div>
      </div>

      <div className="gr g2">
        <MoverColumn title="TOP GAINERS" items={gainers} color="var(--gn)" />
        <MoverColumn title="TOP DECLINERS" items={losers} color="var(--rd)" />
      </div>
    </div>
  );
}

function MoverColumn({ title, items, color }: { title: string; items: TopMoverRow[]; color: string }) {
  const gridRows = items.map((r, i) => ({ ...r, id: r.dim_label + '___' + i }));
  const columns: GridColDef[] = [
    { field: 'dim_label', headerName: 'Label', flex: 2, minWidth: 200,
      renderCell: (p) => (
        <span title={p.value as string} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
          {p.value as string}
        </span>
      ) },
    { field: 'current_rev', headerName: 'Current', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => fm(v) },
    { field: 'delta_rev', headerName: 'Δ $', type: 'number', width: 110, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value);
        return <span style={{ color, fontWeight: 600 }}>{(v >= 0 ? '+' : '') + fm(v)}</span>;
      } },
    { field: 'delta_pct', headerName: 'Δ %', type: 'number', width: 100, cellClassName: 'mn',
      valueFormatter: (v) => fp(Number(v)) },
  ];
  return (
    <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
        <div className="ct" style={{ margin: 0, color }}>{title} — {items.length}</div>
      </div>
      {items.length === 0 ? (
        <div className="ld">No movers in this window.</div>
      ) : (
        <ReportGrid
          rows={gridRows} columns={columns}
          pinnedLeft={['dim_label']}
          defaultSort={[{ field: 'delta_rev', sort: title === 'TOP GAINERS' ? 'desc' : 'asc' }]}
          height="50vh"
        />
      )}
    </div>
  );
}
