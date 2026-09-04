import { useCallback, useEffect, useMemo, useState } from 'react';
import { SearchSelect } from '../../components/SearchSelect';
import { X as XIcon, Truck, CheckCircle2, FileText, Mail, Pencil, RefreshCw, AlertTriangle, Plus, Trash2 } from 'lucide-react';
import {
  PoLineEdit, PoReceipt, PurchaseOrderLine, PurchaseOrderRow,
  closePurchaseOrder, fetchPoLines, fetchPoReceipts, isConflict, pushPoToQbo, receivePurchaseOrder,
  reloadPoFromQbo, retryReceiptBill, updatePurchaseOrder, voidPurchaseOrder,
} from '../../lib/purchasing';
import { InventoryLocation } from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { fmtNum, fm } from '../../lib/formatters';
import type { ProductionItemLookup } from './ProductionPage';
import { openDocPdf } from '../../lib/productionDocs';
import { EmailDocModal } from './EmailDocModal';

/**
 * One purchase order, whichever side created it.
 *
 * QuickBooks and Refractor share this row (20260904d): a PO keyed into
 * QuickBooks lands here as origin 'qbo' on the 15-minute pull, and a PO created
 * here is pushed there. Either can be edited here and pushed back — the
 * SyncToken decides a conflict, never the last writer. Receiving here writes
 * the stock ledger FIRST, then creates the QuickBooks Bill linked to the PO
 * lines (so QuickBooks closes the PO itself), then files a posted Brixpense
 * row that waits for the vendor's invoice. A bill that QuickBooks refuses is
 * a receipt with an error and a Retry, never a lost delivery.
 */

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.floor(h / 24)} days ago`;
}

type Mode = 'view' | 'receive' | 'edit';

interface EditLine { id: string | null; qbo_item_id: string; description: string; qty_ordered: string; unit_cost: string; qty_received: number }

export function PoDetailModal({
  poId, po, itemLookup, locById, onClose, onChanged,
}: {
  poId: string;
  po: PurchaseOrderRow | null;
  itemLookup: ProductionItemLookup;
  locById: Map<string, InventoryLocation>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [lines, setLines] = useState<PurchaseOrderLine[] | null>(null);
  const [receipts, setReceipts] = useState<PoReceipt[]>([]);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('view');
  const [emailOpen, setEmailOpen] = useState(false);

  // receive form
  const [recvQty, setRecvQty] = useState<Record<string, string>>({});
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [recvNotes, setRecvNotes] = useState('');
  const [lastReceive, setLastReceive] = useState<{ ok: boolean; text: string } | null>(null);

  // edit form
  const [editLines, setEditLines] = useState<EditLine[]>([]);
  const [editExpected, setEditExpected] = useState('');
  const [editNotes, setEditNotes] = useState('');

  const reload = useCallback(async () => {
    // Every line on the PO, never a lane-filtered subset — a materials PO is
    // mostly `excluded` items by design, and a document's lines must match
    // the PDF and QuickBooks.
    const [ls, rs] = await Promise.all([fetchPoLines(poId), fetchPoReceipts(poId).catch(() => [] as PoReceipt[])]);
    setLines(ls); setReceipts(rs);
    return ls;
  }, [poId]);

  useEffect(() => {
    let alive = true;
    reload().catch(() => alive && setLines([]));
    return () => { alive = false; };
  }, [reload]);

  const itemName = (id: string) => itemLookup.byId.get(id)?.item_name ?? id;
  const componentItems = itemLookup.componentOptions;

  const canReceive = !!po && (po.status === 'open' || po.status === 'partial');
  const canEdit    = !!po && (po.status === 'draft' || po.status === 'open' || po.status === 'partial');
  const canClose   = !!po && (po.status === 'received' || po.status === 'partial');
  const canVoid    = !!po && (po.status === 'draft' || po.status === 'open');
  const inQbo      = !!po?.qbo_purchase_order_id;

  const receivable = useMemo(() => (lines ?? []).filter((l) => l.receivable !== false && Number(l.qty_ordered) - Number(l.qty_received) > 0), [lines]);

  function startReceive() {
    const seed: Record<string, string> = {};
    for (const l of receivable) seed[l.id] = String(Number(l.qty_ordered) - Number(l.qty_received));
    setRecvQty(seed); setInvoiceNo(''); setInvoiceDate(''); setRecvNotes(''); setLastReceive(null);
    setMode('receive');
  }

  function startEdit() {
    if (!po) return;
    setEditLines((lines ?? []).map((l) => ({
      id: l.id, qbo_item_id: l.qbo_item_id, description: l.description ?? '',
      qty_ordered: String(l.qty_ordered), unit_cost: String(l.unit_cost), qty_received: Number(l.qty_received),
    })));
    setEditExpected(po.expected_date ?? ''); setEditNotes(po.notes ?? '');
    setMode('edit');
  }

  async function doReceive() {
    const picked = receivable
      .map((l) => ({ po_line_id: l.id, qty: Number(recvQty[l.id] ?? 0) }))
      .filter((l) => Number.isFinite(l.qty) && l.qty > 0);
    if (!picked.length) { toast.error('Enter a quantity on at least one line'); return; }
    for (const p of picked) {
      const l = receivable.find((x) => x.id === p.po_line_id)!;
      const remaining = Number(l.qty_ordered) - Number(l.qty_received);
      if (p.qty > remaining + 1e-9) { toast.error(`${itemName(l.qbo_item_id)}: only ${fmtNum(remaining)} still to come`); return; }
    }
    setBusy(true); setLastReceive(null);
    try {
      const r = await receivePurchaseOrder({
        po_id: poId, lines: picked,
        vendor_invoice_number: invoiceNo.trim() || null,
        invoice_date: invoiceDate || null,
        notes: recvNotes.trim() || null,
      });
      setLastReceive({ ok: true, text: `Received ${fm(Number(r.total))} · QuickBooks Bill ${r.qbo_bill_doc_number ? '#' + r.qbo_bill_doc_number : r.qbo_bill_id} created and filed in Brixpense (Posted) awaiting the vendor invoice${r.completes_po ? ' · PO complete' : ''}.` });
      toast.success('Received · bill ' + (r.qbo_bill_doc_number || r.qbo_bill_id) + ' created');
      await reload(); setMode('view'); onChanged();
    } catch (e) {
      const err = e as Error & { status?: number; body?: { receipt_id?: string } };
      if (err.status === 502 && err.body?.receipt_id) {
        setLastReceive({ ok: false, text: err.message });
        toast.error('Stock received; the QuickBooks bill failed — see Retry below');
        await reload(); setMode('view'); onChanged();
      } else {
        toast.error(errMsg(e));
      }
    } finally { setBusy(false); }
  }

  async function doRetry(r: PoReceipt) {
    setBusy(true);
    try {
      const res = await retryReceiptBill(r.id);
      toast.success('Bill ' + (res.qbo_bill_doc_number || res.qbo_bill_id) + ' created');
      await reload(); onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doSaveEdit(force = false) {
    const payload: PoLineEdit[] = [];
    for (const l of editLines) {
      const qty = Number(l.qty_ordered); const cost = Number(l.unit_cost);
      if (!l.qbo_item_id) { toast.error('Every line needs an item'); return; }
      if (!Number.isFinite(qty) || qty <= 0) { toast.error(`${itemName(l.qbo_item_id)}: quantity must be above zero`); return; }
      if (qty < l.qty_received) { toast.error(`${itemName(l.qbo_item_id)}: ${fmtNum(l.qty_received)} already arrived — a line cannot be cut below that`); return; }
      if (!Number.isFinite(cost) || cost < 0) { toast.error(`${itemName(l.qbo_item_id)}: bad unit cost`); return; }
      payload.push({ id: l.id, qbo_item_id: l.qbo_item_id, description: l.description.trim() || null, qty_ordered: qty, unit_cost: cost });
    }
    if (!payload.length) { toast.error('A purchase order needs at least one line'); return; }
    setBusy(true);
    try {
      const r = await updatePurchaseOrder(poId, { expected_date: editExpected || null, notes: editNotes.trim() || null }, payload, { force });
      if (r.pushed) toast.success(r.pushed.message ?? 'Saved and pushed to QuickBooks');
      else toast.success('Saved');
      await reload(); setMode('view'); onChanged();
    } catch (e) {
      if (isConflict(e)) {
        // The edit is saved HERE (qbo_dirty); QuickBooks moved on since our last
        // pull. A person picks: overwrite QuickBooks, or reload and redo.
        const overwrite = confirm(e.message + '\n\nOK = push anyway and overwrite QuickBooks.\nCancel = keep QuickBooks and reload it here (your edit is dropped).');
        try {
          if (overwrite) { const p = await pushPoToQbo(poId, { force: true }); toast.success(p.message ?? 'Pushed'); }
          else { await reloadPoFromQbo(poId, true); toast.info('Reloaded from QuickBooks'); }
          await reload(); setMode('view'); onChanged();
        } catch (e2) { toast.error(errMsg(e2)); }
      } else toast.error(errMsg(e));
    } finally { setBusy(false); }
  }

  async function doPush() {
    setBusy(true);
    try {
      const r = await pushPoToQbo(poId);
      toast.success(r.message ?? 'Pushed to QuickBooks');
      await reload(); onChanged();
    } catch (e) {
      if (isConflict(e)) {
        if (confirm(e.message + '\n\nOK = push anyway and overwrite QuickBooks.')) {
          try { const r = await pushPoToQbo(poId, { force: true }); toast.success(r.message ?? 'Pushed'); await reload(); onChanged(); }
          catch (e2) { toast.error(errMsg(e2)); }
        }
      } else toast.error(errMsg(e));
    } finally { setBusy(false); }
  }

  async function doReload() {
    setBusy(true);
    try {
      const r = await reloadPoFromQbo(poId, false);
      toast.success(r.message ?? 'Reloaded');
      await reload(); onChanged();
    } catch (e) {
      if (isConflict(e)) {
        if (confirm(e.message)) {
          try { await reloadPoFromQbo(poId, true); toast.success('Reloaded from QuickBooks'); await reload(); onChanged(); }
          catch (e2) { toast.error(errMsg(e2)); }
        }
      } else toast.error(errMsg(e));
    } finally { setBusy(false); }
  }

  async function doClose() {
    if (!po || !confirm('Mark PO ' + po.po_number + ' as closed? Any unreceived lines will be force-closed.')) return;
    setBusy(true);
    try { await closePurchaseOrder(poId); toast.success('PO closed'); onChanged(); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doVoid() {
    const reason = prompt('Void reason:');
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try { await voidPurchaseOrder(poId, reason.trim()); toast.success('PO voided'); onChanged(); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  if (!po) return null;
  const destLabel = locById.get(po.destination_location_id)?.name ?? po.location_label ?? '—';
  const receiveTotal = receivable.reduce((s, l) => s + Number(recvQty[l.id] ?? 0) * Number(l.unit_cost), 0);
  const editTotal = editLines.reduce((s, l) => s + (Number(l.qty_ordered) || 0) * (Number(l.unit_cost) || 0), 0);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
        maxWidth: 980, width: '100%', maxHeight: '92vh', overflow: 'auto', padding: 18,
      }}>
        {/* ── header ─────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', display: 'flex', gap: 8, alignItems: 'center' }}>
              Purchase Order · {po.status}
              <OriginBadge origin={po.origin} />
              {po.qbo_dirty && <span style={pill('var(--am)')}>edited here · not yet in QuickBooks</span>}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--ff-mono)', color: 'var(--tx)' }}>
              {po.po_number}
              {po.qbo_doc_number && po.qbo_doc_number !== po.po_number && (
                <span style={{ fontSize: 11, color: 'var(--mt)', marginLeft: 8, fontWeight: 500 }}>QuickBooks # {po.qbo_doc_number}</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--mt)' }}>
              {po.vendor_name ?? po.qbo_vendor_id} · destination {destLabel}
              {po.expected_date && ' · expected ' + po.expected_date}
              {po.run_number && ' · run ' + po.run_number}
            </div>
            {inQbo ? (
              <div style={{ fontSize: 10, color: 'var(--gn)', marginTop: 4, fontWeight: 600 }}>
                ✓ In QuickBooks as PurchaseOrder #{po.qbo_purchase_order_id}
                {po.qbo_status && <> · QuickBooks says <strong>{po.qbo_status}</strong></>}
                {' · pulled '}{ago(po.qbo_synced_at ?? po.qbo_pushed_at)}
              </div>
            ) : (
              <div style={{ fontSize: 10, color: 'var(--am)', marginTop: 4 }}>
                Not in QuickBooks yet — it is pushed when you press Push, or automatically the first time it is received.
              </div>
            )}
            {po.qbo_push_error && (
              <div style={{ fontSize: 10, color: 'var(--rd)', marginTop: 4 }}>QuickBooks push error: {po.qbo_push_error}</div>
            )}
            {po.qbo_skipped_lines && po.qbo_skipped_lines.length > 0 && (
              <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 4 }}>
                {po.qbo_skipped_lines.length} QuickBooks line{po.qbo_skipped_lines.length === 1 ? '' : 's'} not shown here
                (account-based or no item): {po.qbo_skipped_lines.map((s) => s.description || s.detail_type || s.reason).filter(Boolean).join('; ')}
              </div>
            )}
            {po.void_reason && (
              <div style={{ fontSize: 10, color: 'var(--rd)', marginTop: 4 }}>Voided: {po.void_reason}</div>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
            <XIcon size={16} />
          </button>
        </div>

        {po.notes && mode !== 'edit' && (
          <div style={{
            padding: 8, marginBottom: 12,
            background: 'rgba(91,181,240,0.04)', border: '1px solid var(--bd)', borderRadius: 4,
            fontSize: 11, color: 'var(--tx2)', whiteSpace: 'pre-wrap',
          }}>
            {po.notes}
          </div>
        )}

        {lastReceive && (
          <div style={{
            padding: 8, marginBottom: 12, borderRadius: 4, fontSize: 11,
            background: lastReceive.ok ? 'rgba(46,184,114,0.08)' : 'rgba(239,68,68,0.08)',
            border: '1px solid ' + (lastReceive.ok ? 'rgba(46,184,114,0.35)' : 'rgba(239,68,68,0.35)'),
            color: lastReceive.ok ? 'var(--gn)' : 'var(--rd)',
          }}>{lastReceive.text}</div>
        )}

        {/* ── lines ──────────────────────────────────────────────────────── */}
        <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
          {mode === 'receive' ? 'Receiving — what arrived today' : mode === 'edit' ? 'Editing lines' : 'Lines'}
        </div>

        {lines === null ? (
          <div className="ld">Loading…</div>
        ) : mode === 'edit' ? (
          <EditLinesTable
            lines={editLines} setLines={setEditLines} componentItems={componentItems} itemName={itemName}
            expected={editExpected} setExpected={setEditExpected} notes={editNotes} setNotes={setEditNotes} total={editTotal}
          />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                <th style={th}>Item</th>
                <th style={{ ...th, textAlign: 'right', width: 90 }}>Ordered</th>
                <th style={{ ...th, textAlign: 'right', width: 90 }}>Received</th>
                <th style={{ ...th, textAlign: 'right', width: 90 }}>Unit cost</th>
                <th style={{ ...th, textAlign: 'right', width: 100 }}>Extended</th>
                {mode === 'receive' && <th style={{ ...th, textAlign: 'right', width: 130 }}>Receiving now</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((ln) => {
                const remaining = Number(ln.qty_ordered) - Number(ln.qty_received);
                const fullyReceived = remaining <= 0;
                const isReceivable = ln.receivable !== false;
                return (
                  <tr key={ln.id} style={{ borderBottom: '1px solid var(--bd)' }}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{itemName(ln.qbo_item_id)}</div>
                      {ln.description && <div style={{ fontSize: 10, color: 'var(--mt)' }}>{ln.description}</div>}
                      {!isReceivable && <div style={{ fontSize: 9.5, color: 'var(--mt)' }}>service · nothing arrives</div>}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(ln.qty_ordered))}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)',
                      color: fullyReceived ? 'var(--gn)' : (Number(ln.qty_received) > 0 ? 'var(--am)' : 'var(--mt)') }}>
                      {fmtNum(Number(ln.qty_received))}
                      {fullyReceived && isReceivable && <CheckCircle2 size={11} style={{ marginLeft: 4, verticalAlign: -1 }} />}
                    </td>
                    {/* 4 dp — a can body is $0.328; whole dollars would print $0 */}
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{'$' + Number(ln.unit_cost).toFixed(4)}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)', fontWeight: 600 }}>
                      {fm(Number(ln.qty_ordered) * Number(ln.unit_cost))}
                    </td>
                    {mode === 'receive' && (
                      <td style={{ ...td, textAlign: 'right' }}>
                        {!isReceivable || fullyReceived ? (
                          <span style={{ fontSize: 10, color: 'var(--mt)' }}>{fullyReceived ? 'complete' : '—'}</span>
                        ) : (
                          <input
                            type="number" min={0} max={remaining} step="any"
                            style={{ ...inp(), width: 100, textAlign: 'right' }}
                            value={recvQty[ln.id] ?? ''}
                            onChange={(e) => setRecvQty((cur) => ({ ...cur, [ln.id]: e.target.value }))}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* ── receive form ───────────────────────────────────────────────── */}
        {mode === 'receive' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 10, marginBottom: 12 }}>
            <LField label="Vendor invoice # (if in hand)">
              <input style={inp()} value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="leave blank — the bill waits for it" />
            </LField>
            <LField label="Invoice date">
              <input style={inp()} type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </LField>
            <LField label="Receiving notes">
              <input style={inp()} value={recvNotes} onChange={(e) => setRecvNotes(e.target.value)} placeholder="damage, short ship, who signed…" />
            </LField>
            <div style={{ gridColumn: '1 / -1', fontSize: 10.5, color: 'var(--mt)', lineHeight: 1.6 }}>
              Receiving posts the stock into the ledger, creates the QuickBooks Bill for <strong style={{ color: 'var(--tx)' }}>{fm(receiveTotal)}</strong> linked
              to this PO (QuickBooks closes the received lines itself), and files it in Brixpense as <em>Posted</em>
              {invoiceNo.trim() ? ' with that invoice number.' : ' awaiting the vendor invoice — when it arrives, Brixpense matches it to this bill instead of posting a second one.'}
            </div>
          </div>
        )}

        {/* ── receipts ───────────────────────────────────────────────────── */}
        {receipts.length > 0 && mode === 'view' && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>Receipts</div>
            {receipts.map((r) => (
              <div key={r.id} style={{
                display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, padding: '6px 8px',
                border: '1px solid var(--bd)', borderRadius: 4, marginBottom: 4,
                borderLeft: '3px solid ' + (r.qbo_bill_id ? 'var(--gn)' : 'var(--rd)'),
              }}>
                <span style={{ fontFamily: 'var(--ff-mono)' }}>{new Date(r.received_at).toLocaleString()}</span>
                <span style={{ color: 'var(--mt)' }}>{r.received_by_email ?? ''}</span>
                <span>{r.lines.length} line{r.lines.length === 1 ? '' : 's'} · <strong>{fm(Number(r.total_amount))}</strong></span>
                {r.vendor_invoice_number && <span style={{ color: 'var(--mt)' }}>invoice {r.vendor_invoice_number}</span>}
                {r.qbo_bill_id ? (
                  <span style={{ color: 'var(--gn)', fontWeight: 600 }}>
                    <CheckCircle2 size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
                    QuickBooks Bill {r.qbo_bill_doc_number ? '#' + r.qbo_bill_doc_number : r.qbo_bill_id} · in Brixpense
                  </span>
                ) : (
                  <>
                    <span style={{ color: 'var(--rd)' }}>
                      <AlertTriangle size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
                      bill not in QuickBooks{r.qbo_error ? ': ' + r.qbo_error : ''}
                    </span>
                    <button onClick={() => doRetry(r)} disabled={busy} style={{ ...btnSecondary(), padding: '3px 8px' }}>Retry bill</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── actions ────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, paddingTop: 8, borderTop: '1px solid var(--bd)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {mode === 'view' && (
              <>
                <button onClick={() => openDocPdf({ kind: 'po', id: poId }).catch((e) => toast.error(errMsg(e)))}
                  style={btnSecondary()} title="The branded purchase order as a PDF">
                  <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> View PDF
                </button>
                <button onClick={() => setEmailOpen(true)} style={btnSecondary()} title="Email the PDF to the vendor">
                  <Mail size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Email…
                </button>
                {inQbo && (
                  <button onClick={doReload} disabled={busy} style={btnSecondary()} title="Re-read this PO from QuickBooks now">
                    <RefreshCw size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Reload from QuickBooks
                  </button>
                )}
                {canVoid && <button onClick={doVoid} disabled={busy} style={btnDanger()}>Void</button>}
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {mode === 'view' && (
              <>
                <button onClick={onClose} style={btnSecondary()}>Close</button>
                {canEdit && (
                  <button onClick={startEdit} disabled={busy} style={btnSecondary()}>
                    <Pencil size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Edit
                  </button>
                )}
                {(po.qbo_dirty || !inQbo) && po.status !== 'void' && (
                  <button onClick={doPush} disabled={busy} style={btnSecondary()} title={inQbo ? 'Push the edits made here onto the QuickBooks PO' : 'Create this PO in QuickBooks'}>
                    {inQbo ? 'Push edits to QuickBooks →' : 'Push to QuickBooks →'}
                  </button>
                )}
                {canReceive && receivable.length > 0 && (
                  <button onClick={startReceive} disabled={busy} style={btnPrimary()}>
                    <Truck size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Receive…
                  </button>
                )}
                {canClose && <button onClick={doClose} disabled={busy} style={btnSecondary()}>Close PO</button>}
              </>
            )}
            {mode === 'receive' && (
              <>
                <button onClick={() => setMode('view')} disabled={busy} style={btnSecondary()}>Cancel</button>
                <button onClick={doReceive} disabled={busy || receiveTotal <= 0} style={btnPrimary()}>
                  <Truck size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
                  {busy ? 'Receiving…' : 'Receive & create the bill'}
                </button>
              </>
            )}
            {mode === 'edit' && (
              <>
                <button onClick={() => setMode('view')} disabled={busy} style={btnSecondary()}>Cancel</button>
                <button onClick={() => doSaveEdit(false)} disabled={busy} style={btnPrimary()}>
                  {busy ? 'Saving…' : inQbo ? 'Save & push to QuickBooks' : 'Save'}
                </button>
              </>
            )}
          </div>
        </div>
        {emailOpen && (
          <EmailDocModal ref={{ kind: 'po', id: poId }} title={'purchase order ' + po.po_number} onClose={() => setEmailOpen(false)} />
        )}
      </div>
    </div>
  );
}

function EditLinesTable({
  lines, setLines, componentItems, itemName, expected, setExpected, notes, setNotes, total,
}: {
  lines: EditLine[];
  setLines: (f: (cur: EditLine[]) => EditLine[]) => void;
  componentItems: { id: string; label: string }[];
  itemName: (id: string) => string;
  expected: string; setExpected: (v: string) => void;
  notes: string; setNotes: (v: string) => void;
  total: number;
}) {
  const upd = (i: number, patch: Partial<EditLine>) => setLines((cur) => cur.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div style={{ marginBottom: 12 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bd)' }}>
            <th style={th}>Item</th>
            <th style={th}>Description</th>
            <th style={{ ...th, textAlign: 'right', width: 100 }}>Qty</th>
            <th style={{ ...th, textAlign: 'right', width: 110 }}>Unit cost</th>
            <th style={{ ...th, textAlign: 'right', width: 100 }}>Extended</th>
            <th style={{ ...th, width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id ?? 'new-' + i} style={{ borderBottom: '1px solid var(--bd)' }}>
              <td style={td}>
                {l.id ? (
                  <div style={{ fontWeight: 600 }}>{itemName(l.qbo_item_id)}
                    {l.qty_received > 0 && <div style={{ fontSize: 9.5, color: 'var(--mt)' }}>{fmtNum(l.qty_received)} already received</div>}
                  </div>
                ) : (
                  <SearchSelect value={l.qbo_item_id} onChange={(id) => upd(i, { qbo_item_id: id })} options={componentItems} placeholder="Type an item…" />
                )}
              </td>
              <td style={td}><input style={{ ...inp(), width: '100%' }} value={l.description} onChange={(e) => upd(i, { description: e.target.value })} /></td>
              <td style={td}><input type="number" min={l.qty_received || 0.0001} step="any" style={{ ...inp(), width: 90, textAlign: 'right' }} value={l.qty_ordered} onChange={(e) => upd(i, { qty_ordered: e.target.value })} /></td>
              <td style={td}><input type="number" min={0} step="any" style={{ ...inp(), width: 100, textAlign: 'right' }} value={l.unit_cost} onChange={(e) => upd(i, { unit_cost: e.target.value })} /></td>
              <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fm((Number(l.qty_ordered) || 0) * (Number(l.unit_cost) || 0))}</td>
              <td style={td}>
                {l.qty_received > 0 ? (
                  <span title="stock already arrived on this line — it cannot be removed" style={{ color: 'var(--mt)' }}>·</span>
                ) : (
                  <button onClick={() => setLines((cur) => cur.filter((_, j) => j !== i))} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--rd)' }} title="Remove line">
                    <Trash2 size={12} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={4} style={{ ...td, textAlign: 'right', color: 'var(--mt)' }}>Subtotal</td>
            <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)', fontWeight: 700 }}>{fm(total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
      <button onClick={() => setLines((cur) => [...cur, { id: null, qbo_item_id: '', description: '', qty_ordered: '1', unit_cost: '0', qty_received: 0 }])}
        style={{ ...btnSecondary(), marginBottom: 10 }}>
        <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Add line
      </button>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 3fr', gap: 10 }}>
        <LField label="Expected date"><input style={inp()} type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></LField>
        <LField label="Notes (QuickBooks memo)"><input style={inp()} value={notes} onChange={(e) => setNotes(e.target.value)} /></LField>
      </div>
    </div>
  );
}

export function OriginBadge({ origin }: { origin: 'brix' | 'qbo' | undefined }) {
  const qbo = origin === 'qbo';
  return (
    <span style={pill(qbo ? 'var(--gn)' : 'var(--ac)')} title={qbo ? 'Created in QuickBooks, mirrored here every 15 minutes' : 'Created in Refractor'}>
      {qbo ? 'QuickBooks PO' : 'Refractor PO'}
    </span>
  );
}

function pill(color: string): React.CSSProperties {
  return {
    display: 'inline-block', padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700,
    letterSpacing: 0.5, color, border: '1px solid ' + color, background: 'rgba(255,255,255,0.04)', textTransform: 'uppercase',
  };
}

function LField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div>
    <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
    {children}
  </div>;
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '7px 8px', fontSize: 10, fontWeight: 600,
  letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)',
};
const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'middle' };
