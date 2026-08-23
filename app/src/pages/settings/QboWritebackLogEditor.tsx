import { useEffect, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { btnSecondary, inp } from '../../lib/styles';
import { sbrpc } from '../../lib/rpc';
import { useToast } from '../../lib/toast';
import { GRID_SX, GRID_DEFAULTS } from '../../lib/gridStyles';

// Read-only audit view of ops.qbo_writeback_log. Every Active toggle
// (and any future writeback) lands here with before/after state, so the
// question "what did I push to QBO today?" can be answered in one place.

interface LogRow {
  id: number;
  action: string;
  qbo_item_id: string | null;
  item_name: string | null;
  before_state: Record<string, unknown> | null;
  after_state:  Record<string, unknown> | null;
  result_status: 'success' | 'failure' | 'cancelled';
  error_message: string | null;
  performed_by: string | null;
  performed_at: string;
}

const RESULT_COLOR: Record<string, string> = {
  success:   'var(--gn)',
  failure:   'var(--rd)',
  cancelled: 'var(--mt)',
};

function fmtField(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Active' : 'Inactive';
  return String(v);
}

// Before/After cell — a key: value list of the union of changed fields.
function DiffCell({ state, other, color }: {
  state: Record<string, unknown> | null;
  other: Record<string, unknown> | null;
  color: string;
}) {
  const keys = Array.from(new Set([...Object.keys(state ?? {}), ...Object.keys(other ?? {})]));
  if (keys.length === 0) return <span style={{ color: 'var(--mt)' }}>—</span>;
  return (
    <div style={{ fontSize: 10, fontFamily: 'var(--ff-mono)', color, lineHeight: 1.35, paddingTop: 4, paddingBottom: 4 }}>
      {keys.map((k) => (
        <div key={k}><span style={{ color: 'var(--mt)' }}>{k}:</span> {fmtField((state ?? {})[k])}</div>
      ))}
    </div>
  );
}

const LOG_COLUMNS: GridColDef<LogRow>[] = [
  {
    field: 'performed_at', headerName: 'When', width: 155,
    renderCell: (p) => <span style={{ fontSize: 10, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>{new Date(p.row.performed_at).toLocaleString()}</span>,
  },
  {
    field: 'action', headerName: 'Action', width: 160,
    renderCell: (p) => <span style={{ fontSize: 11, fontFamily: 'var(--ff-mono)', color: 'var(--ac)' }}>{p.row.action}</span>,
  },
  {
    field: 'item_name', headerName: 'Item', width: 210,
    renderCell: (p) => (
      <div style={{ lineHeight: 1.3 }}>
        <div style={{ fontSize: 11 }}>{p.row.item_name ?? '—'}</div>
        {p.row.qbo_item_id && <div style={{ fontSize: 9, color: 'var(--mt)', fontFamily: 'var(--ff-mono)' }}>id: {p.row.qbo_item_id}</div>}
      </div>
    ),
  },
  {
    field: 'before_state', headerName: 'Before', width: 200, sortable: false,
    renderCell: (p) => <DiffCell state={p.row.before_state} other={p.row.after_state} color="var(--tx2)" />,
  },
  {
    field: 'after_state', headerName: 'After', width: 200, sortable: false,
    renderCell: (p) => <DiffCell state={p.row.after_state} other={p.row.before_state} color="var(--ac)" />,
  },
  {
    field: 'result_status', headerName: 'Result', width: 130, align: 'center', headerAlign: 'center',
    renderCell: (p) => (
      <div style={{ textAlign: 'center' }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: RESULT_COLOR[p.row.result_status] ?? 'var(--mt)', textTransform: 'uppercase' }}>{p.row.result_status}</span>
        {p.row.error_message && (
          <div style={{ fontSize: 9, color: 'var(--rd)', marginTop: 2 }} title={p.row.error_message}>{p.row.error_message.slice(0, 40)}…</div>
        )}
      </div>
    ),
  },
  {
    field: 'performed_by', headerName: 'By', width: 140,
    renderCell: (p) => <span style={{ fontSize: 10, color: 'var(--mt)' }}>{p.row.performed_by ?? '—'}</span>,
  },
];

export function QboWritebackLogEditor() {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [days, setDays] = useState(7);
  const toast = useToast();

  function load() {
    setRows(null);
    sbrpc<LogRow[]>('fn_recent_qbo_writebacks', { p_days: days })
      .then(setRows)
      .catch((e) => { toast.error('Load failed: ' + (e as Error).message); setRows([]); });
  }
  useEffect(load, [days]);

  if (!rows) return <div className="ld">Loading writeback log…</div>;

  const successCount   = rows.filter((r) => r.result_status === 'success').length;
  const failureCount   = rows.filter((r) => r.result_status === 'failure').length;
  const cancelledCount = rows.filter((r) => r.result_status === 'cancelled').length;

  return (
    <div>
      <div className="cd" style={{ padding: '12px 14px', marginBottom: 12 }}>
        <div className="ct" style={{ margin: 0, marginBottom: 4 }}>QBO WRITEBACK LOG</div>
        <div style={{ fontSize: 11, color: 'var(--mt)', lineHeight: 1.4 }}>
          Every time BRIX pushes something to QuickBooks (Active flip, category sync, etc.)
          a row lands here. Before / after state lets you reconstruct exactly what changed
          and reverse anything that shouldn't have happened. Cancellations are also logged
          so you can see "almost pushed" decisions in the trail.
        </div>
      </div>

      <div className="gr g4" style={{ marginBottom: 12 }}>
        <div className="kpi-card">
          <div className="kpi-label">SUCCESS</div>
          <div className="kpi-value" style={{ color: 'var(--gn)' }}>{successCount}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">FAILED</div>
          <div className="kpi-value" style={{ color: failureCount > 0 ? 'var(--rd)' : undefined }}>{failureCount}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">CANCELLED</div>
          <div className="kpi-value">{cancelledCount}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">TOTAL ROWS</div>
          <div className="kpi-value">{rows.length}</div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--mt)' }}>Window:</span>
        {[1, 7, 30, 90].map((d) => (
          <button key={d} onClick={() => setDays(d)}
            className={'tb-btn' + (days === d ? ' tb-btn--primary' : '')}
            style={days === d ? { fontWeight: 700 } : undefined}>
            {d === 1 ? 'Today' : d + ' days'}
          </button>
        ))}
        <button onClick={load} style={{ ...btnSecondary(), marginLeft: 'auto' }}>Refresh</button>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        <DataGridPro
          rows={rows}
          columns={LOG_COLUMNS}
          density="compact"
          pagination
          disableRowSelectionOnClick
          {...GRID_DEFAULTS}
          pageSizeOptions={[25, 50, 100, { value: -1, label: 'All' }]}
          getRowHeight={() => 'auto'}
          initialState={{
            pagination: { paginationModel: { pageSize: 50, page: 0 } },
            sorting: { sortModel: [{ field: 'performed_at', sort: 'desc' }] },
          }}
          sx={{ ...GRID_SX, height: '60vh' }}
        />
      </div>
    </div>
  );
}
