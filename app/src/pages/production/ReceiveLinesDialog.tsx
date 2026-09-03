// Receive several purchase orders at once: every receivable line of the
// selected POs, grouped by PO with its destination, quantity defaulting to what
// is still outstanding, one receipt date, optional per-line cost override.
// Submits through fn_receive_po_lines — each line in its own sub-transaction,
// so a refused line is named rather than sinking the batch.
import { useEffect, useMemo, useState } from 'react';
import { fetchPoLines, type PurchaseOrderLine, type PurchaseOrderRow } from '../../lib/purchasing';
import { receivePoLines, type BulkResult, type ReceiveLineInput } from '../../lib/bulkActions';
import { inp, btnPrimary, btnSecondary } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';
import type { ProductionItemLookup } from './ProductionPage';

interface Row { line: PurchaseOrderLine; po: PurchaseOrderRow; remaining: number }

export function ReceiveLinesDialog({ pos, itemLookup, busy, onCancel, onDone }: {
  pos: PurchaseOrderRow[];
  itemLookup: ProductionItemLookup;
  busy?: boolean;
  onCancel: () => void;
  onDone: (result: BulkResult) => void;
}) {
  const receivable = useMemo(() => pos.filter((p) => p.status === 'open' || p.status === 'partial'), [pos]);
  const skippedPos = useMemo(() => pos.filter((p) => !(p.status === 'open' || p.status === 'partial')), [pos]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [cost, setCost] = useState<Record<string, string>>({});
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all(receivable.map((po) => fetchPoLines(po.id).then((ls) => ls.map((line) => ({ line, po, remaining: Number(line.qty_ordered) - Number(line.qty_received) })))))
      .then((all) => {
        if (!alive) return;
        const flat = all.flat().filter((r) => r.remaining > 0);
        setRows(flat);
        setQty(Object.fromEntries(flat.map((r) => [r.line.id, String(r.remaining)])));
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [receivable]);

  const inputs: ReceiveLineInput[] = (rows ?? []).flatMap((r) => {
    const q = Number(qty[r.line.id]);
    if (!(q > 0)) return [];
    const c = cost[r.line.id];
    return [{ po_line_id: r.line.id, qty: q, unit_cost: c ? Number(c) : null, receipt_date: date || null }];
  });
  const overs = (rows ?? []).filter((r) => Number(qty[r.line.id]) > r.remaining + 1e-9);
  const canGo = inputs.length > 0 && overs.length === 0 && !sending && !busy;

  async function go() {
    setSending(true); setErr(null);
    try { onDone(await receivePoLines(inputs)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSending(false); }
  }

  const th: React.CSSProperties = { textAlign: 'left', fontSize: 9.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', padding: '4px 6px', fontWeight: 600 };
  const td: React.CSSProperties = { padding: '4px 6px', fontSize: 11 };
  const byPo = new Map<string, Row[]>();
  for (const r of rows ?? []) { const arr = byPo.get(r.po.id) ?? []; arr.push(r); byPo.set(r.po.id, arr); }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="cd" style={{ width: 'min(900px, 100%)', maxHeight: '90vh', overflow: 'auto', padding: 16, border: '1px solid var(--ac)' }} role="dialog" aria-modal="true">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Receive {receivable.length} purchase order{receivable.length === 1 ? '' : 's'}</div>
          <label style={{ fontSize: 10.5, color: 'var(--mt)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Receipt date <input type="date" style={{ ...inp(), width: 150 }} value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 10 }}>
          Quantities default to what is still outstanding — change any that came up short, or blank a line to leave it. Cost is the PO price unless you type one.
        </div>
        {skippedPos.length > 0 && (
          <div style={{ marginBottom: 10, padding: 8, background: 'rgba(239,191,65,0.08)', border: '1px solid rgba(239,191,65,0.30)', borderRadius: 4, fontSize: 11 }}>
            <span style={{ color: 'var(--am)' }}>Not receivable:</span> {skippedPos.map((p) => `${p.po_number} (${p.status})`).join(', ')}
          </div>
        )}
        {err && <div style={{ color: 'var(--rd)', fontSize: 11, marginBottom: 8 }}>{err}</div>}
        {rows === null ? <div className="ld">Loading lines…</div> : rows.length === 0 ? (
          <div className="ld">Nothing outstanding on these purchase orders.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--bd)' }}>
              <th style={th}>Item</th><th style={{ ...th, textAlign: 'right' }}>Ordered</th><th style={{ ...th, textAlign: 'right' }}>Received</th>
              <th style={{ ...th, textAlign: 'right' }}>Outstanding</th><th style={{ ...th, width: 110 }}>Receive now</th><th style={{ ...th, width: 110 }}>Unit cost</th>
            </tr></thead>
            <tbody>
              {[...byPo.entries()].map(([poId, prs]) => (
                <FragmentRows key={poId} po={prs[0].po} rows={prs} qty={qty} setQty={setQty} cost={cost} setCost={setCost} itemLookup={itemLookup} th={th} td={td} />
              ))}
            </tbody>
          </table>
        )}
        {overs.length > 0 && <div style={{ color: 'var(--rd)', fontSize: 11, marginBottom: 8 }}>{overs.length} line{overs.length === 1 ? '' : 's'} exceed what is outstanding.</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" style={btnSecondary()} onClick={onCancel} disabled={sending}>Cancel</button>
          <button type="button" style={btnPrimary()} disabled={!canGo} onClick={() => void go()}>
            {sending ? 'Receiving…' : `Receive ${inputs.length} line${inputs.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function FragmentRows({ po, rows, qty, setQty, cost, setCost, itemLookup, th, td }: {
  po: PurchaseOrderRow; rows: Row[];
  qty: Record<string, string>; setQty: (v: Record<string, string>) => void;
  cost: Record<string, string>; setCost: (v: Record<string, string>) => void;
  itemLookup: ProductionItemLookup; th: React.CSSProperties; td: React.CSSProperties;
}) {
  return (
    <>
      <tr><td colSpan={6} style={{ ...th, paddingTop: 10, color: 'var(--tx)' }}>
        <span style={{ fontFamily: 'var(--ff-mono)' }}>{po.po_number}</span> · {po.vendor_name ?? po.qbo_vendor_id} → {po.location_label ?? 'destination'}
      </td></tr>
      {rows.map((r) => (
        <tr key={r.line.id} style={{ borderBottom: '1px solid var(--bd)' }}>
          <td style={td}>{itemLookup.byId.get(r.line.qbo_item_id)?.item_name ?? r.line.description ?? r.line.qbo_item_id}</td>
          <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(r.line.qty_ordered))}</td>
          <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(r.line.qty_received))}</td>
          <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--am)' }}>{fmtNum(r.remaining)}</td>
          <td style={td}><input type="number" min={0} max={r.remaining} step="any" style={{ ...inp(), width: 100, textAlign: 'right' }}
            value={qty[r.line.id] ?? ''} onChange={(e) => setQty({ ...qty, [r.line.id]: e.target.value })} /></td>
          <td style={td}><input type="number" min={0} step="any" style={{ ...inp(), width: 100, textAlign: 'right' }} placeholder={Number(r.line.unit_cost).toFixed(4)}
            value={cost[r.line.id] ?? ''} onChange={(e) => setCost({ ...cost, [r.line.id]: e.target.value })} /></td>
        </tr>
      ))}
    </>
  );
}
