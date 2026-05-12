import { useEffect, useMemo, useState } from 'react';
import type { GridColDef } from '@mui/x-data-grid-pro';
import { KPICard } from '../../components/KPICard';
import { CustomerLink } from '../../components/CustomerLink';
import { SegmentChip } from '../../components/SegmentChip';
import { ReportGrid } from '../../components/ReportGrid';
import { fm } from '../../lib/formatters';
import { btnSecondary } from '../../lib/styles';
import { HealthMoverRow, fetchHealthMovers, takeHealthSnapshot } from '../../lib/reports';

interface HealthGridRow extends HealthMoverRow {
  id: string;
}

export function HealthMoversReport() {
  const [maxAge, setMaxAge] = useState(14);
  const [rows, setRows] = useState<HealthMoverRow[] | null>(null);
  const [snapMsg, setSnapMsg] = useState('');

  function load() {
    setRows(null);
    fetchHealthMovers(Number(maxAge) || 14).then(setRows).catch(() => setRows([]));
  }
  useEffect(load, [maxAge]);

  function takeSnapshot() {
    setSnapMsg('snapshotting…');
    takeHealthSnapshot()
      .then((n) => { setSnapMsg('snapshot taken: ' + (n ?? 0) + ' customers'); load(); })
      .catch((e) => setSnapMsg('error: ' + e.message));
  }

  const gridRows: HealthGridRow[] = useMemo(
    () => (rows ?? []).map((r) => ({ ...r, id: r.qbo_customer_id })),
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
    { field: 'prev_segment', headerName: 'Was', width: 110,
      renderCell: (p) => <SegmentChip segment={p.value as string | null} /> },
    { field: 'curr_segment', headerName: 'Now', width: 110,
      renderCell: (p) => <SegmentChip segment={p.value as string | null} /> },
    {
      field: 'rfm_total_delta', headerName: 'RFM Δ', type: 'number', width: 90, cellClassName: 'mn',
      renderCell: (p) => {
        const d = Number(p.value);
        const color = d > 0 ? 'var(--gn)' : d < 0 ? 'var(--rd)' : 'var(--mt)';
        return <span style={{ color, fontWeight: 600 }}>{(d > 0 ? '+' : '') + d}</span>;
      },
    },
    {
      field: 'monetary_delta', headerName: 'Monetary Δ', type: 'number', width: 130, cellClassName: 'mn',
      renderCell: (p) => {
        const md = Number(p.value);
        const color = md > 0 ? 'var(--gn)' : md < 0 ? 'var(--rd)' : 'var(--mt)';
        return <span style={{ color, fontWeight: 600 }}>{(md > 0 ? '+' : '') + fm(md)}</span>;
      },
    },
    { field: 'movement', headerName: 'Movement', width: 140,
      valueFormatter: (v) => (v == null || v === '' ? '—' : String(v)) },
  ], []);

  if (!rows) return <div className="ld">Loading…</div>;

  const promoted = rows.filter((r) => Number(r.rfm_total_delta) > 0 || r.prev_segment === null);
  const demoted  = rows.filter((r) => Number(r.rfm_total_delta) < 0);
  const bigJump  = rows.filter((r) => Math.abs(Number(r.rfm_total_delta) || 0) >= 3);
  const newCust  = rows.filter((r) => r.prev_segment === null);

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="CUSTOMERS WITH MOVEMENT" value={rows.length} accent="var(--ac)" />
        <KPICard title="PROMOTED" value={promoted.length} accent="var(--gn)" sub="higher RFM or new" />
        <KPICard title="DEMOTED" value={demoted.length} accent="var(--rd)" sub="lower RFM total" />
        <KPICard title="BIG MOVES (≥3)" value={bigJump.length} accent="var(--am)" sub="segment-changing magnitudes" />
      </div>

      <div className="toolbar" style={{ marginBottom: 10 }}>
        <div className="toolbar-row">
          <div className="toolbar-section">
            <span className="toolbar-label">Compare within last</span>
            <input type="number" min={1} max={90} value={maxAge}
              onChange={(e) => setMaxAge(Number(e.target.value) || 14)}
              className="date-input" style={{ width: 60 }} />
            <span style={{ color: 'var(--mt)', fontSize: 11 }}>days</span>
          </div>
          <div className="toolbar-section">
            <button onClick={takeSnapshot} style={btnSecondary()}>Take snapshot now</button>
            {snapMsg && <span style={{ color: 'var(--mt)', fontSize: 10, marginLeft: 8 }}>{snapMsg}</span>}
          </div>
          <div className="toolbar-spacer" />
          {newCust.length > 0 && (
            <span style={{ color: 'var(--mt)', fontSize: 10 }}>
              {newCust.length} first-seen this period
            </span>
          )}
        </div>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        {rows.length === 0 ? (
          <div className="ld">
            No customer health movement detected. Either no prior snapshot exists in this window, or every customer is stable.
          </div>
        ) : (
          <ReportGrid
            rows={gridRows} columns={columns}
            pinnedLeft={['customer_name']}
            defaultSort={[{ field: 'rfm_total_delta', sort: 'desc' }]}
            height="62vh"
          />
        )}
      </div>
    </div>
  );
}
