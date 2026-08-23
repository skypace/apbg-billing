import { useEffect, useMemo, useState } from 'react';
import type { GridColDef } from '@mui/x-data-grid-pro';
import { KPICard } from '../../components/KPICard';
import { CustomerLink } from '../../components/CustomerLink';
import { ReportGrid } from '../../components/ReportGrid';
import { fm } from '../../lib/formatters';
import { AnomalyRow, fetchAnomalies } from '../../lib/reports';

interface AnomalyGridRow extends AnomalyRow { id: string }

export function AnomaliesReport() {
  const [f, setF] = useState({
    baseline_months: 6, recent_months: 1, min_baseline: 500, sigma: 2.0,
  });
  const [rows, setRows] = useState<AnomalyRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    const t = setTimeout(() => {
      fetchAnomalies({
        baseline_months: Number(f.baseline_months) || 6,
        recent_months:   Number(f.recent_months) || 1,
        min_baseline:    Number(f.min_baseline) || 0,
        sigma_threshold: Number(f.sigma) || 2,
      })
        .then((rs) => { if (!cancelled) setRows(rs); })
        .catch(() => { if (!cancelled) setRows([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [f.baseline_months, f.recent_months, f.min_baseline, f.sigma]);

  const gridRows: AnomalyGridRow[] = useMemo(
    () => (rows ?? []).map((r, i) => ({ ...r, id: r.qbo_customer_id + '___' + i })),
    [rows],
  );

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'customer_name', headerName: 'Customer', flex: 2, minWidth: 220,
      renderCell: (p) => (
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <CustomerLink qboCustomerId={p.row.qbo_customer_id} name={p.row.customer_name} />
        </span>
      ),
    },
    { field: 'primary_channel', headerName: 'Channel', width: 150,
      valueFormatter: (v) => (v == null ? '—' : String(v)) },
    {
      field: 'direction', headerName: 'Direction', width: 100,
      renderCell: (p) => {
        const dirColor = p.value === 'spike' ? 'var(--gn)' : 'var(--rd)';
        return (
          <span style={{
            background: 'rgba(255,255,255,0.04)', color: dirColor,
            border: '1px solid ' + dirColor, padding: '1px 7px',
            borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
          }}>{String(p.value).toUpperCase()}</span>
        );
      },
    },
    { field: 'baseline_avg', headerName: 'Baseline avg/mo', type: 'number', width: 140, cellClassName: 'mn',
      valueFormatter: (v) => fm(v) },
    { field: 'recent_avg', headerName: 'Recent avg/mo', type: 'number', width: 130, cellClassName: 'mn',
      valueFormatter: (v) => fm(v) },
    {
      field: 'delta_pct', headerName: 'Δ%', type: 'number', width: 90, cellClassName: 'mn',
      renderCell: (p) => {
        const d = Number(p.value);
        if (!isFinite(d)) return <span style={{ color: 'var(--mt)' }}>—</span>;
        return (
          <span style={{ color: d >= 0 ? 'var(--gn)' : 'var(--rd)', fontWeight: 600 }}>
            {(d >= 0 ? '+' : '') + (d * 100).toFixed(0) + '%'}
          </span>
        );
      },
    },
    {
      field: 'z_score', headerName: 'Z-score', type: 'number', width: 90, cellClassName: 'mn',
      renderCell: (p) => {
        const z = Number(p.value);
        if (!isFinite(z)) return <span style={{ color: 'var(--mt)' }}>—</span>;
        const dirColor = p.row.direction === 'spike' ? 'var(--gn)' : 'var(--rd)';
        return <span style={{ color: dirColor, fontWeight: 600 }}>{(z >= 0 ? '+' : '') + z.toFixed(2)}</span>;
      },
    },
  ], []);

  if (!rows) return <div className="ld">Loading…</div>;
  const spikes = rows.filter((r) => r.direction === 'spike');
  const drops  = rows.filter((r) => r.direction === 'drop');

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="ANOMALIES" value={rows.length} accent="var(--am)" sub={'>' + f.sigma + 'σ from baseline'} />
        <KPICard title="SPIKES" value={spikes.length} accent="var(--gn)" sub="recent revenue above trend" />
        <KPICard title="DROPS" value={drops.length} accent="var(--rd)" sub="recent revenue below trend" />
        <KPICard title="BIGGEST DROP" value={drops[0] ? fm(drops[0].baseline_avg) : '—'}
          sub={drops[0]?.customer_name ?? 'baseline @ risk'} />
      </div>

      <div className="toolbar" style={{ marginBottom: 10 }}>
        <div className="toolbar-row">
          <div className="toolbar-section">
            <span className="toolbar-label">Baseline months</span>
            <input type="number" min={2} max={24} value={f.baseline_months}
              onChange={(e) => setF({ ...f, baseline_months: Number(e.target.value) })}
              className="date-input" style={{ width: 60 }} />
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">Recent months</span>
            <input type="number" min={1} max={6} value={f.recent_months}
              onChange={(e) => setF({ ...f, recent_months: Number(e.target.value) })}
              className="date-input" style={{ width: 50 }} />
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">Min baseline $</span>
            <input type="number" value={f.min_baseline}
              onChange={(e) => setF({ ...f, min_baseline: Number(e.target.value) })}
              className="date-input" style={{ width: 80 }} />
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">Sigma threshold</span>
            <input type="number" step={0.1} min={0.5} max={5} value={f.sigma}
              onChange={(e) => setF({ ...f, sigma: Number(e.target.value) })}
              className="date-input" style={{ width: 60 }} />
          </div>
        </div>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        {rows.length === 0 ? (
          <div className="ld">No anomalies above threshold. Drop sigma to see softer signals.</div>
        ) : (
          <ReportGrid
            rows={gridRows} columns={columns}
            pinnedLeft={['customer_name']}
            defaultSort={[{ field: 'z_score', sort: 'desc' }]}
            height="62vh"
          />
        )}
      </div>
    </div>
  );
}
