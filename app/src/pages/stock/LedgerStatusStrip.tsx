import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { btnSecondary } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';
import {
  LedgerStatus, ReconcilePreviewRow,
  fetchLedgerStatus, reconcileInventoryBulk,
} from '../../lib/inventoryControl';

/**
 * Does this ledger still agree with QuickBooks, and when did it last move?
 *
 * Both questions used to be unanswerable from the screen, which is how the
 * ledger sat frozen from 2026-05-14 to 2026-09-02 -- 31 of 34 tracked items
 * adrift by 3,345 units -- while the On-Hand grid printed those numbers with
 * no more hesitation than if they had been counted that morning. A quantity
 * with no date beside it cannot be judged.
 *
 * The division of labour it reports on: QuickBooks owns HOW MANY we hold, this
 * ledger owns WHERE it is. Drift means the warehouse total has come adrift.
 */

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days > 1) return `${days} days ago`;
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return 'just now';
}

export function LedgerStatusStrip({ onReconciled }: { onReconciled: () => void }) {
  const [status,  setStatus]  = useState<LedgerStatus | null>(null);
  const [preview, setPreview] = useState<ReconcilePreviewRow[] | null>(null);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const load = useCallback(() => {
    fetchLedgerStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(load, [load]);

  // A failure here is worth reading in full: the server refuses a reconcile
  // while stock is away from the warehouse, and the reason it gives is the
  // useful part.
  async function run(commit: boolean) {
    setBusy(true); setError(null);
    try {
      const rows = await reconcileInventoryBulk(
        commit ? 'Reconciled from the Stock screen' : null, commit,
      );
      if (commit) { setPreview(null); load(); onReconciled(); }
      else setPreview(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  if (!status) return null;

  const stale   = status.items_drifting > 0;
  const blocked = Number(status.qty_away_from_warehouse) !== 0;
  const accent  = stale ? 'var(--am)' : 'var(--gn)';

  return (
    <div className="card" style={{ marginBottom: 14, borderLeft: `3px solid ${accent}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {stale
          ? <AlertTriangle size={15} style={{ color: accent, flexShrink: 0 }} />
          : <CheckCircle2  size={15} style={{ color: accent, flexShrink: 0 }} />}

        <div style={{ fontSize: 11.5, lineHeight: 1.6, flex: 1, minWidth: 260 }}>
          {stale ? (
            <>
              <strong>{status.items_drifting} item{status.items_drifting === 1 ? '' : 's'} disagree
              with QuickBooks</strong> by {fmtNum(Number(status.abs_drift))} unit
              {Number(status.abs_drift) === 1 ? '' : 's'}.
            </>
          ) : (
            <><strong>On-hand agrees with QuickBooks.</strong></>
          )}
          {' '}Last movement <strong>{ago(status.last_movement_at)}</strong>
          {' · '}{fmtNum(status.movement_count)} in the ledger.
          {blocked && (
            <>
              {' '}<span style={{ color: 'var(--am)' }}>
                {fmtNum(Number(status.qty_away_from_warehouse))} unit
                {Number(status.qty_away_from_warehouse) === 1 ? '' : 's'} are at a co-packer or in
                transit, so a reconcile is unavailable — those are not warehouse drift, and adjusting
                them in now would count the batch twice when it is received.
              </span>
            </>
          )}
        </div>

        {stale && !blocked && (
          <button
            style={btnSecondary()}
            disabled={busy}
            onClick={() => (preview ? run(true) : run(false))}
          >
            <RefreshCw size={12} style={{ marginRight: 5, verticalAlign: -1 }} />
            {busy ? 'Working…' : preview ? `Apply to ${preview.length} item${preview.length === 1 ? '' : 's'}` : 'Reconcile to QuickBooks…'}
          </button>
        )}
      </div>

      {error && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--rd)', lineHeight: 1.6 }}>{error}</div>
      )}

      {/* Preview first, always. A reconcile writes a correcting movement per
          item; it never edits history, but it is still 45 rows of somebody's
          stock and it should be read before it is pressed. */}
      {preview && (
        <div style={{ marginTop: 10, fontSize: 11 }}>
          <div style={{ color: 'var(--mt)', marginBottom: 6 }}>
            Nothing has been written yet. Each line posts one correcting movement dated today; the
            original count stays in the ledger's history.
          </div>
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--mt)', fontSize: 9.5, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                  <th style={{ textAlign: 'left',  padding: '4px 6px' }}>Item</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Ledger</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>QuickBooks</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Change</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r) => (
                  <tr key={r.qbo_item_id} style={{ borderTop: '1px solid var(--bd)' }}>
                    <td style={{ padding: '4px 6px' }}>{r.item_name}</td>
                    <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>{fmtNum(Number(r.brix_qty))}</td>
                    <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(r.qbo_qty))}</td>
                    <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--ff-mono)', color: Number(r.drift) > 0 ? 'var(--gn)' : 'var(--rd)' }}>
                      {Number(r.drift) > 0 ? '+' : ''}{fmtNum(Number(r.drift))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button style={{ ...btnSecondary(), marginTop: 8 }} onClick={() => setPreview(null)} disabled={busy}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
