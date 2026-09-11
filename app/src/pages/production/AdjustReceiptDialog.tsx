// Correct what was received on one PO line — up or down — with a reason. The
// server posts a compensating movement (receipt / receipt_reversal); nothing is
// edited in the ledger, and a correction down is refused once the goods have
// moved on from the destination.
import { useState } from 'react';
import { adjustReceipt, type PurchaseOrderLine } from '../../lib/purchasing';
import { inp, btnPrimary, btnSecondary } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';

export function AdjustReceiptDialog({ line, itemName, poStatus, onCancel, onDone }: {
  line: PurchaseOrderLine; itemName: string; poStatus: string;
  onCancel: () => void;
  onDone: (r: { from: number; to: number; delta: number; status: string }) => void;
}) {
  const [qty, setQty] = useState(String(line.qty_received));
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const to = Number(qty);
  const delta = to - Number(line.qty_received);
  const valid = Number.isFinite(to) && to >= 0 && to <= Number(line.qty_ordered) && delta !== 0 && reason.trim().length > 0;

  async function go() {
    setBusy(true); setErr(null);
    try { onDone(await adjustReceipt({ po_line_id: line.id, new_qty_received: to, reason: reason.trim(), occurred_at: date ? new Date(date + 'T12:00:00').toISOString() : null })); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="cd" style={{ width: 'min(480px, 100%)', padding: 16, border: '1px solid var(--ac)' }} role="dialog" aria-modal="true">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Correct the receipt</div>
        <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 12 }}>
          {itemName} · ordered {fmtNum(Number(line.qty_ordered))} · received {fmtNum(Number(line.qty_received))}
          {poStatus === 'closed' && <> · <span style={{ color: 'var(--am)' }}>this PO is closed — a correction that leaves lines outstanding reopens it</span></>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>Received quantity should be
            <input type="number" min={0} max={Number(line.qty_ordered)} step="any" style={{ ...inp(), marginTop: 4 }} value={qty} onChange={(e) => setQty(e.target.value)} autoFocus /></label>
          <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>Dated
            <input type="date" style={{ ...inp(), marginTop: 4 }} value={date} onChange={(e) => setDate(e.target.value)} /></label>
        </div>
        {Number.isFinite(to) && delta !== 0 && (
          <div style={{ fontSize: 11, marginTop: 8, color: delta > 0 ? 'var(--gn)' : 'var(--am)' }}>
            {delta > 0 ? `+${fmtNum(delta)} more lands at the destination` : `${fmtNum(-delta)} comes back out of the destination`} — a new movement, dated as above.
          </div>
        )}
        <label style={{ display: 'block', fontSize: 10.5, color: 'var(--mt)', marginTop: 10 }}>Reason (recorded on the movement and the PO)
          <input style={{ ...inp(), marginTop: 4 }} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        {err && <div style={{ color: 'var(--rd)', fontSize: 11, marginTop: 8 }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button type="button" style={btnSecondary()} onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" style={btnPrimary()} disabled={!valid || busy} onClick={() => void go()}>{busy ? 'Saving…' : 'Correct receipt'}</button>
        </div>
      </div>
    </div>
  );
}
