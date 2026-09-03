import { useCallback, useEffect, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { btnSecondary } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';
import { SalesFeedMode, SalesFeedRow, fetchSalesFeed, setSalesFeedMode } from '../../lib/inventoryControl';

/**
 * Where today's sales would come off, and whether the feed is allowed to write.
 *
 * ⚠ Shadow is the default and the cutover plan, not a placeholder. The feed and
 * the Reconcile button must never both be authoritative: reconcile sets the
 * ledger EQUAL to QuickBooks, so if it runs while the mirror's quantities are a
 * few hours behind the invoices the feed already deducted, it puts them
 * straight back. In shadow the feed computes and writes nothing, so these
 * numbers can be checked against the drift the strip reports for a day or two
 * before anyone lets it near the ledger.
 */
export function SalesFeedPanel({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<SalesFeedRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState<string | null>(null);

  const load = useCallback(() => {
    fetchSalesFeed().then(setRows).catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  async function flip(mode: SalesFeedMode) {
    setBusy(true); setErr(null);
    try { await setSalesFeedMode(mode); load(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!rows) return null;
  const mode  = rows[0]?.mode ?? 'shadow';
  const units = rows.reduce((n, r) => n + Number(r.units_pending || 0), 0);
  const lines = rows.reduce((n, r) => n + Number(r.lines_pending || 0), 0);
  const live  = mode === 'live';

  return (
    <div className="card" style={{ marginBottom: 14, borderLeft: `3px solid ${live ? 'var(--gn)' : 'var(--mt)'}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <ArrowRightLeft size={15} style={{ color: live ? 'var(--gn)' : 'var(--mt)', flexShrink: 0 }} />
        <div style={{ fontSize: 11.5, lineHeight: 1.6, flex: 1, minWidth: 280 }}>
          <strong>Sales feed — {live ? 'live' : mode === 'off' ? 'off' : 'watching only'}.</strong>{' '}
          {lines === 0
            ? 'Nothing invoiced to deduct since it was switched on.'
            : <>{fmtNum(lines)} invoice line{lines === 1 ? '' : 's'} · {fmtNum(units)} unit
               {Math.abs(units) === 1 ? '' : 's'} {live ? 'to deduct' : 'it would deduct'}.</>}
          {!live && mode !== 'off' && (
            <span style={{ color: 'var(--mt)' }}>
              {' '}Nothing is being written. Check these against the drift above for a day or two
              before switching it on — a reconcile run while the feed is live puts the same units
              back, so only one of them can be in charge.
            </span>
          )}
        </div>
        <button style={btnSecondary()} disabled={busy}
          onClick={() => flip(live ? 'shadow' : 'live')}>
          {busy ? 'Working…' : live ? 'Back to watching only' : 'Switch the feed on'}
        </button>
      </div>

      {err && <div style={{ marginTop: 8, fontSize: 11, color: 'var(--rd)' }}>{err}</div>}

      {rows.length > 0 && (
        <div style={{ marginTop: 9, fontSize: 11, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {rows.map((r) => (
            <span key={r.location_code}>
              <span style={{ fontFamily: 'var(--ff-mono)', color: 'var(--mt)', marginRight: 5 }}>
                {r.location_code}
              </span>
              {fmtNum(Number(r.units_pending))}
              <span style={{ color: 'var(--mt)' }}>
                {' '}· {r.route_reason === 'default_warehouse' ? 'not assigned to a partner' : r.route_reason}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* The mapping is the only thing that sends a sale anywhere but the
          warehouse, so say where it lives rather than leaving it to be found. */}
      <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--mt)' }}>
        A customer deducts from a partner's warehouse once they are attached to one under{' '}
        <strong>Sub-Distributors → Accounts</strong>. Everything else comes off Brix Warehouse.
      </div>
    </div>
  );
}
