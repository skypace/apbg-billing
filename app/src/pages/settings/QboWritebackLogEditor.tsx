import { useEffect, useState } from 'react';
import { btnSecondary, inp } from '../../lib/styles';
import { sbrpc } from '../../lib/rpc';
import { useToast } from '../../lib/toast';

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
        <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
          <table>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Item</th>
                <th>Before</th>
                <th>After</th>
                <th style={{ textAlign: 'center', width: 90 }}>Result</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 14, color: 'var(--mt)' }}>No writebacks in this window.</td></tr>
              ) : (
                rows.map((r) => {
                  const before = r.before_state ?? {};
                  const after  = r.after_state ?? {};
                  const diffKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
                  return (
                    <tr key={r.id}>
                      <td style={{ fontSize: 10, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>
                        {new Date(r.performed_at).toLocaleString()}
                      </td>
                      <td style={{ fontSize: 11, fontFamily: 'var(--ff-mono)', color: 'var(--ac)' }}>{r.action}</td>
                      <td style={{ fontSize: 11 }}>
                        <div>{r.item_name ?? '—'}</div>
                        {r.qbo_item_id && (
                          <div style={{ fontSize: 9, color: 'var(--mt)', fontFamily: 'var(--ff-mono)' }}>id: {r.qbo_item_id}</div>
                        )}
                      </td>
                      <td style={{ fontSize: 10, fontFamily: 'var(--ff-mono)', color: 'var(--tx2)' }}>
                        {diffKeys.map((k) => (
                          <div key={k}><span style={{ color: 'var(--mt)' }}>{k}:</span> {fmtField(before[k])}</div>
                        ))}
                      </td>
                      <td style={{ fontSize: 10, fontFamily: 'var(--ff-mono)', color: 'var(--ac)' }}>
                        {diffKeys.map((k) => (
                          <div key={k}><span style={{ color: 'var(--mt)' }}>{k}:</span> {fmtField(after[k])}</div>
                        ))}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                          color: RESULT_COLOR[r.result_status] ?? 'var(--mt)',
                          textTransform: 'uppercase',
                        }}>{r.result_status}</span>
                        {r.error_message && (
                          <div style={{ fontSize: 9, color: 'var(--rd)', marginTop: 2 }} title={r.error_message}>
                            {r.error_message.slice(0, 40)}…
                          </div>
                        )}
                      </td>
                      <td style={{ fontSize: 10, color: 'var(--mt)' }}>{r.performed_by ?? '—'}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
