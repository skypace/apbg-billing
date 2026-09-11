// The production order in full: its flavours (child work orders), the purchase
// orders it raised (one per vendor), the raw-material stock it reserved, and
// the run-level actions — generate POs, materials at co-packer, start, record
// each flavour's yield, ONE bill of lading for the truck, receive, close, reopen,
// and the master void that takes every work order and PO with it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { X as XIcon, Check, Truck, Factory, PackageCheck, ShoppingCart, Scale, FileText, Plus, Tag } from 'lucide-react';
import type { ProductBom, WorkOrderView } from '../../lib/production';
import { advanceWorkOrder } from '../../lib/production';
import type { QboVendor, PurchaseOrderRow } from '../../lib/purchasing';
import { closeRuleCopy } from '../../lib/purchasing';
import {
  type ProductionRun, type Reservation, RUN_STAGES,
  addRunLine, advanceRun, closeRun, createRunProductionPo, fetchRunPurchaseOrders, fetchRunReservations,
  fetchRunWorkOrders, generateRunPos, receiveRun, removeRunLine, reopenRun, shipRun, voidRun,
} from '../../lib/runs';
import { deleteDrafts } from '../../lib/bulkActions';
import { openDocPdf } from '../../lib/productionDocs';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { fmtNum, fm } from '../../lib/formatters';
import { ReasonDialog } from '../../components/ReasonDialog';
import type { ProductionItemLookup } from './ProductionPage';
import { RecordYieldDialog } from './WorkOrderDialogs';
import { RunBillsSection } from './BillsPanel';
import { Meta, LField, StageChip, cellTh, cellTd, sectionLabel, errMsg } from './productionUi';

const RUN_COLOR: Record<string, string> = { draft: 'var(--mt)', ordered: 'var(--ac)', in_progress: 'var(--am)', closed: 'var(--gn)', void: '#64748b' };
const RUN_LABEL: Record<string, string> = { draft: 'Draft', ordered: 'POs issued', in_progress: 'In progress', closed: 'Closed', void: 'Void' };
export function runStageChip(status: string) { return <StageChip status={status} color={RUN_COLOR[status]} label={RUN_LABEL[status] ?? status} />; }

export function RunDetailModal({ run, boms, vendors, itemLookup, onClose, onChanged, onOpenPo, onOpenWo }: {
  run: ProductionRun;
  boms: ProductBom[];
  vendors: QboVendor[];
  itemLookup: ProductionItemLookup;
  onClose: () => void;
  onChanged: () => void;
  onOpenPo: (poId: string) => void;
  onOpenWo: (woId: string) => void;
}) {
  const toast = useToast();
  const [wos, setWos] = useState<WorkOrderView[] | null>(null);
  const [pos, setPos] = useState<PurchaseOrderRow[] | null>(null);
  const [reservations, setReservations] = useState<Reservation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [yieldFor, setYieldFor] = useState<WorkOrderView | null>(null);
  const [shipOpen, setShipOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [ask, setAsk] = useState<'void' | 'reopen' | 'delete' | null>(null);

  const reload = useCallback(() => {
    fetchRunWorkOrders(run.id).then(setWos).catch(() => setWos([]));
    fetchRunPurchaseOrders(run.id).then(setPos).catch(() => setPos([]));
    fetchRunReservations(run.id).then(setReservations).catch(() => setReservations([]));
  }, [run.id]);
  useEffect(() => { reload(); }, [reload, run.status, run.wo_count, run.po_count]);

  const live = useMemo(() => (wos ?? []).filter((w) => w.status !== 'void'), [wos]);
  const has = (...statuses: string[]) => live.some((w) => statuses.includes(w.status));
  const every = (...statuses: string[]) => live.length > 0 && live.every((w) => statuses.includes(w.status));
  const materialsUnordered = live.some((w) => ['draft', 'ordered'].includes(w.status) && !(Number(w.po_count ?? 0) > 0));
  const canGeneratePos = ['draft', 'ordered'].includes(run.status) && (materialsUnordered || live.some((w) => w.status === 'draft'));
  const canShip = has('yield_recorded') && every('yield_recorded', 'in_transit', 'received', 'closed');
  const shipLaggards = live.filter((w) => !['yield_recorded', 'in_transit', 'received', 'closed'].includes(w.status));
  const canClose = every('received', 'closed') && run.status !== 'closed';
  const canProductionPo = live.length > 0 && live.every((w) => w.total_cost != null) && !(pos ?? []).some((p) => p.po_kind === 'production' && p.status !== 'void');
  const stageIdx = RUN_STAGES.findIndex((s) => s.status === run.status);

  async function act(label: string, fn: () => Promise<unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    try { await fn(); toast.success(label); onChanged(); reload(); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }
  function reportSkips(r: { done: unknown[]; skipped: { number: string; reason: string }[] }) {
    for (const s of r.skipped) toast.error(`${s.number}: ${s.reason}`);
  }

  const doGeneratePos = () => act('Purchase orders generated', async () => {
    const r = await generateRunPos(run.id);
    toast.info(r.pos.map((p) => `${p.po_number} · ${p.close_rule === 'on_run_yield' ? 'closes when the run ships' : 'closes on receipt'}`).join(' — ')
      + (r.reservations ? ` · ${r.reservations} item${r.reservations === 1 ? '' : 's'} covered from stock at the co-packer` : ''));
  }, `Generate purchase orders for ${run.run_number}?\n\nOne PO per vendor for every flavour on the order, netted against stock already at ${run.copacker_location_label ?? 'the co-packer'} and lifted to each item's MOQ.`);

  const doAdvance = (action: 'materials_at_copacker' | 'start_production' | 'receive' | 'close', label: string, confirmText?: string) =>
    act(label, async () => { reportSkips(await advanceRun(run.id, action)); }, confirmText);

  const doReceive = () => act('Finished goods received into inventory', async () => { await receiveRun(run.id); },
    `Receive the truck for ${run.run_number} into ${run.destination_location_label ?? 'the warehouse'}? Every in-transit flavour lands.`);
  const doClose = () => act('Production order closed', async () => {
    const r = await closeRun(run.id);
    if (r.short_closed_pos.length) toast.info('Short-closed: ' + r.short_closed_pos.join(', '));
  });
  const doProductionPo = () => act('Production PO created', async () => {
    const r = await createRunProductionPo(run.id);
    toast.info(`${r.po_number} — ${r.lines} line${r.lines === 1 ? '' : 's'} · ${fm(r.subtotal)}`);
  }, 'Create the purchase order for the finished cases from ALAMEDA SODA COMPANY PRODUCTION?\n\nOne PO, one line per flavour, priced at the per-case cost each work order measured.');

  const voidItems = live.map((w) => ({
    id: w.id, number: w.batch_code, eligible: ['draft', 'ordered', 'at_copacker'].includes(w.status),
    why: 'production has started — close the run out instead',
  }));
  const voidable = run.status !== 'void' && run.status !== 'closed' && voidItems.every((i) => i.eligible);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '90px 20px 20px', overflowY: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={run.run_number} style={{
        background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
        maxWidth: 1040, width: '100%', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto', padding: 20 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
              Production order · {(RUN_LABEL[run.status] ?? run.status).toUpperCase()}
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 22, fontFamily: 'var(--ff-mono)', color: 'var(--ac)' }}>{run.run_number}</h2>
            <div style={{ marginTop: 4, color: 'var(--tx)', fontSize: 13 }}>
              {run.flavours ?? 'no flavours yet'}
              <span style={{ color: 'var(--mt)' }}> · {fmtNum(run.cases_planned)} cases planned{run.cases_produced != null ? ` · ${fmtNum(run.cases_produced)} produced` : ''}</span>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}><XIcon size={18} /></button>
        </div>

        {run.status !== 'void' && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
            {RUN_STAGES.map((s, i) => {
              const done = stageIdx > i || run.status === 'closed';
              const current = stageIdx === i && run.status !== 'closed';
              const c = done ? 'var(--gn)' : current ? 'var(--ac)' : 'var(--bd)';
              return (
                <div key={s.status} style={{ flex: 1, minWidth: 110, padding: '6px 8px', borderRadius: 4, border: `1px solid ${c}`,
                  background: current ? 'rgba(91,181,240,0.10)' : done ? 'rgba(125,238,164,0.05)' : 'transparent' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: done ? 'var(--gn)' : current ? 'var(--ac)' : 'var(--mt)' }}>
                    {done && <Check size={9} style={{ verticalAlign: -1, marginRight: 3 }} />}{s.label}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--mt)', marginTop: 2 }}>{stageStamp(run, s.status) ?? (current ? 'now' : '—')}</div>
                </div>
              );
            })}
          </div>
        )}
        {run.status === 'void' && (
          <div style={{ marginBottom: 14, padding: 10, fontSize: 11, border: '1px solid var(--bd)', borderRadius: 4, color: 'var(--mt)' }}>
            Voided {run.voided_at ? new Date(run.voided_at).toLocaleString() : ''} — {run.void_reason}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, fontSize: 12, marginBottom: 14 }}>
          <Meta label="Co-packer" value={run.copacker_vendor_name ?? run.copacker_qbo_vendor_id} />
          <Meta label="Materials ship to" value={run.copacker_location_label ?? '—'} />
          <Meta label="Finished goods to" value={run.destination_location_label ?? '—'} />
          <Meta label="Scheduled" value={run.scheduled_date ?? '—'} />
          <Meta label="Tank" value={run.tank_size_gal != null ? `${fmtNum(run.tank_size_gal)} gal` : '—'} />
          <Meta label="Purchase orders" value={run.po_count ? `${run.po_count} · ${fm(run.po_total)}${run.po_open_count ? ` · ${run.po_open_count} open` : ''}` : '—'} />
          <Meta label="Measured cost" value={run.total_cost != null ? fm(run.total_cost) : '—'} />
          <Meta label="Stock netting" value={run.net_against_stock ? 'uses stock at the co-packer' : 'orders everything'} />
        </div>
        {run.reopened_at && (
          <div style={{ marginBottom: 12, fontSize: 11, color: 'var(--am)' }}>Reopened {new Date(run.reopened_at).toLocaleString()} — {run.reopen_reason}</div>
        )}

        {/* Flavours / work orders */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ ...sectionLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span><Factory size={11} style={{ verticalAlign: -1, marginRight: 4 }} /> Flavours on this order — each is a work order</span>
            {run.status === 'draft' && <button style={btnSecondary()} disabled={busy} onClick={() => setAddOpen((v) => !v)}><Plus size={11} style={{ verticalAlign: -1, marginRight: 3 }} /> Add flavour</button>}
          </div>
          {addOpen && run.status === 'draft' && (
            <AddLineForm boms={boms} itemLookup={itemLookup} busy={busy} onCancel={() => setAddOpen(false)}
              onAdd={(bomId, qty) => { setAddOpen(false); void act('Flavour added', () => addRunLine(run.id, bomId, qty)); }} />
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                <th style={cellTh}>Work order</th><th style={cellTh}>Flavour</th><th style={cellTh}>Stage</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>Planned</th><th style={{ ...cellTh, textAlign: 'right' }}>Yield</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>$/case</th><th style={cellTh}>Lots</th><th style={cellTh} />
              </tr>
            </thead>
            <tbody>
              {(wos ?? []).map((w) => (
                <tr key={w.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: w.status === 'void' ? 0.5 : 1 }}>
                  <td style={cellTd}>
                    <button onClick={() => onOpenWo(w.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontWeight: 600, padding: 0, fontSize: 11.5 }}>{w.batch_code}</button>
                  </td>
                  <td style={cellTd}><strong>{w.finished_item_name ?? w.bom_name ?? w.finished_qbo_item_id}</strong></td>
                  <td style={cellTd}><StageChip status={w.status} /></td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(w.qty_to_produce))}</td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                    {w.actual_yield_qty == null ? <span style={{ color: 'var(--mt)' }}>—</span>
                      : <>{fmtNum(Number(w.actual_yield_qty))}{w.yield_pct != null && <span style={{ marginLeft: 5, fontSize: 10, color: Number(w.yield_pct) < 100 ? 'var(--am)' : 'var(--gn)' }}>{Number(w.yield_pct).toFixed(1)}%</span>}</>}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{w.unit_cost == null ? '—' : '$' + Number(w.unit_cost).toFixed(4)}</td>
                  <td style={{ ...cellTd, fontSize: 10.5, color: 'var(--mt)' }}>{w.ship_bol_number ? <><Tag size={10} style={{ verticalAlign: -1, marginRight: 3 }} />{w.ship_bol_number}</> : '—'}</td>
                  <td style={{ ...cellTd, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {w.status === 'in_production' && <button style={btnPrimary()} disabled={busy} onClick={() => setYieldFor(w)}><Scale size={11} style={{ verticalAlign: -1, marginRight: 3 }} /> Record yield</button>}
                    {run.status === 'draft' && w.status === 'draft' && live.length > 1 && (
                      <button style={btnDanger()} disabled={busy} title="Remove this flavour from the order" onClick={() => act('Flavour removed', () => removeRunLine(run.id, w.id, 'removed from ' + run.run_number))}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
              {wos && wos.length === 0 && <tr><td colSpan={8} style={{ ...cellTd, color: 'var(--mt)' }}>No flavours on this order.</td></tr>}
            </tbody>
          </table>
        </div>

        {yieldFor && (
          <RecordYieldDialog wo={yieldFor} busy={busy} onCancel={() => setYieldFor(null)}
            onSubmit={(payload) => { const w = yieldFor; setYieldFor(null); void act(`Yield recorded for ${w.batch_code} — costs locked`, () => advanceWorkOrder(w.id, 'record_yield', payload)); }} />
        )}

        {/* Purchase orders */}
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}><ShoppingCart size={11} style={{ verticalAlign: -1, marginRight: 4 }} /> Purchase orders — one per vendor, for every flavour together</div>
          {(pos ?? []).length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--mt)' }}>None yet. Generate them once the flavours are right; the preview on the New order form shows what each vendor will carry.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                  <th style={cellTh}>PO</th><th style={cellTh}>Vendor</th><th style={cellTh}>Status</th><th style={cellTh}>Closes</th>
                  <th style={{ ...cellTh, textAlign: 'right' }}>Received / ordered</th><th style={{ ...cellTh, textAlign: 'right' }}>Surplus</th>
                  <th style={{ ...cellTh, textAlign: 'right' }}>Subtotal</th><th style={cellTh}>QBO</th>
                </tr>
              </thead>
              <tbody>
                {(pos ?? []).map((p) => {
                  const rule = closeRuleCopy(p);
                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: p.status === 'void' ? 0.5 : 1 }}>
                      <td style={cellTd}>
                        <button onClick={() => onOpenPo(p.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontWeight: 600, padding: 0, fontSize: 11.5 }}>{p.po_number}</button>
                        {p.po_kind === 'production' && <span style={{ marginLeft: 6, fontSize: 9.5, color: 'var(--mt)' }}>finished cases</span>}
                      </td>
                      <td style={cellTd}>{p.vendor_name ?? p.qbo_vendor_id}</td>
                      <td style={cellTd}><StageChip status={p.status} color={p.status === 'closed' ? 'var(--gn)' : p.status === 'void' ? '#64748b' : 'var(--ac)'} label={p.status}/>{p.closed_reason && <span style={{ marginLeft: 6, fontSize: 9.5, color: 'var(--mt)' }}>{p.closed_reason.replace(/_/g, ' ')}</span>}</td>
                      <td style={{ ...cellTd, fontSize: 10.5, color: 'var(--mt)' }} title={rule.detail}>{rule.label}</td>
                      <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                        {p.close_rule === 'on_run_yield' ? <span style={{ color: 'var(--mt)' }}>not received</span> : `${fmtNum(p.qty_received_total, 2)} / ${fmtNum(p.qty_ordered_total, 2)}`}
                      </td>
                      <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--am)' }}>{Number(p.qty_surplus_total ?? 0) > 0.000001 ? '+' + fmtNum(Number(p.qty_surplus_total), 2) : <span style={{ color: 'var(--mt)' }}>—</span>}</td>
                      <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fm(p.subtotal)}</td>
                      <td style={{ ...cellTd, fontSize: 10.5 }}>{p.qbo_purchase_order_id ? <span style={{ color: 'var(--gn)' }}>✓ pushed</span> : <span style={{ color: 'var(--mt)' }}>—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Reservations */}
        {(reservations ?? []).length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={sectionLabel}><PackageCheck size={11} style={{ verticalAlign: -1, marginRight: 4 }} /> Raw materials taken from stock at the co-packer instead of ordered</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--bd)' }}><th style={cellTh}>Item</th><th style={{ ...cellTh, textAlign: 'right' }}>Qty</th><th style={cellTh}>Status</th><th style={cellTh}>Note</th></tr></thead>
              <tbody>
                {(reservations ?? []).map((r) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={cellTd}>{itemLookup.byId.get(r.qbo_item_id)?.item_name ?? r.qbo_item_id}</td>
                    <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(r.qty), 2)}</td>
                    <td style={cellTd}><StageChip status={r.status} color={r.status === 'active' ? 'var(--ac)' : r.status === 'consumed' ? 'var(--gn)' : '#64748b'} label={r.status === 'active' ? 'reserved' : r.status} /></td>
                    <td style={{ ...cellTd, color: 'var(--mt)', fontSize: 10.5 }}>{r.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Bills — deposit + final (P7) */}
        <RunBillsSection run={run} vendors={vendors} onChanged={onChanged} />

        {run.notes && <div style={{ marginBottom: 12, fontSize: 11, color: 'var(--mt)' }}><div style={{ fontSize: 9, letterSpacing: 0.6, textTransform: 'uppercase' }}>Notes</div>{run.notes}</div>}

        {shipOpen && (
          <RunShipDialog run={run} wos={live} busy={busy} onCancel={() => setShipOpen(false)}
            onSubmit={(payload) => { setShipOpen(false); void act('One bill of lading created for the truck', async () => {
              const r = await shipRun(run.id, payload);
              toast.info(`BOL ${r.bol_number} · ${r.work_orders.join(', ')}${r.closed_pos.length ? ` · closed ${r.closed_pos.join(', ')}` : ''}`);
            }); }} />
        )}
        {ask === 'void' && (
          <ReasonDialog title={'Void ' + run.run_number} verb="Void production order" items={voidItems} busy={busy}
            note="Every work order on the order is voided; its purchase orders are voided too, or short-closed where goods were already received (those stay on hand). Reserved stock is released. A PO already pushed to QuickBooks is listed back so it can be closed there by hand."
            onCancel={() => setAsk(null)}
            onConfirm={(reason) => { setAsk(null); void act('Production order voided', async () => {
              const r = await voidRun(run.id, reason);
              if (r.qbo_pos_to_close.length) toast.info('Close in QuickBooks by hand: ' + r.qbo_pos_to_close.map((p) => p.po_number).join(', '));
            }); }} />
        )}
        {ask === 'reopen' && (
          <ReasonDialog title={'Reopen ' + run.run_number} verb="Reopen production order"
            items={[{ id: run.id, number: run.run_number, eligible: run.status === 'closed', why: 'not closed' }]} busy={busy}
            note="Every closed work order on it goes back to Received so a receipt can be corrected; close the order again afterwards."
            onCancel={() => setAsk(null)}
            onConfirm={(reason) => { setAsk(null); void act('Production order reopened', () => reopenRun(run.id, reason)); }} />
        )}
        {ask === 'delete' && (
          <ReasonDialog title={'Delete draft ' + run.run_number} verb="Delete draft" needReason={false}
            items={[{ id: run.id, number: run.run_number, eligible: run.status === 'draft' && run.po_count === 0, why: run.status !== 'draft' ? 'not a draft — void it instead' : 'has purchase orders — void it instead' }]} busy={busy}
            note="Only a draft with no purchase orders can be deleted. This is permanent; anything further along is voided instead, which keeps the record."
            onCancel={() => setAsk(null)}
            onConfirm={() => { setAsk(null); void act('Draft deleted', async () => {
              const r = await deleteDrafts('run', [run.id]);
              if (r.skipped.length) throw new Error(r.skipped[0].reason ?? 'refused');
              onClose();
            }); }} />
        )}

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {live.some((w) => w.transfer_id) && (
            <button disabled={busy} style={btnSecondary()} title="The bill of lading for the truck"
              onClick={() => openDocPdf({ kind: 'bol', id: live.find((w) => w.transfer_id)!.transfer_id! }).catch((e) => toast.error(errMsg(e)))}>
              <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> BOL PDF
            </button>
          )}
          {run.status === 'draft' && <button disabled={busy} style={btnDanger()} onClick={() => setAsk('delete')}>Delete draft</button>}
          {voidable && <button disabled={busy} style={btnDanger()} onClick={() => setAsk('void')}>Void order</button>}
          {run.status === 'closed' && <button disabled={busy} style={btnSecondary()} onClick={() => setAsk('reopen')}>Reopen</button>}
          {canGeneratePos && (
            <button disabled={busy || live.length === 0} style={btnPrimary()} onClick={doGeneratePos}>
              <ShoppingCart size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Generate POs per vendor →
            </button>
          )}
          {run.status === 'ordered' && has('ordered') && (
            <button disabled={busy} style={btnSecondary()} onClick={() => doAdvance('materials_at_copacker', 'Marked at co-packer', 'Mark raw materials as arrived at the co-packer for every flavour? (Receiving the Calderoni PO does this by itself.)')}>
              <Truck size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Materials at co-packer
            </button>
          )}
          {has('ordered', 'at_copacker') && run.status !== 'draft' && (
            <button disabled={busy} style={btnPrimary()} onClick={() => doAdvance('start_production', 'Production started', `Start production for ${run.run_number}?\n\nThe co-packer's own materials land at ${run.copacker_location_label ?? 'the co-packer'} and every flavour's demand is consumed from there.`)}>
              <Factory size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Start production →
            </button>
          )}
          {has('yield_recorded') && (
            <button disabled={busy || !canShip} style={btnPrimary()} onClick={() => setShipOpen(true)}
              title={canShip ? 'One BOL for every flavour on the truck' : 'Record the yield on ' + shipLaggards.map((w) => w.batch_code).join(', ') + ' first'}>
              <Truck size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Ship the run →
            </button>
          )}
          {has('in_transit') && (
            <button disabled={busy} style={btnPrimary()} onClick={doReceive}><PackageCheck size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Receive into inventory →</button>
          )}
          {canProductionPo && (
            <button disabled={busy} style={btnSecondary()} onClick={doProductionPo}><FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Create production PO →</button>
          )}
          {canClose && (
            <button disabled={busy} style={btnPrimary()} onClick={doClose}><Check size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Close order</button>
          )}
        </div>
      </div>
    </div>
  );
}

function AddLineForm({ boms, itemLookup, busy, onCancel, onAdd }: {
  boms: ProductBom[]; itemLookup: ProductionItemLookup; busy: boolean; onCancel: () => void; onAdd: (bomId: string, qty: number) => void;
}) {
  const [bomId, setBomId] = useState(''); const [qty, setQty] = useState('');
  return (
    <div className="cd" style={{ padding: 10, marginBottom: 8, border: '1px solid var(--ac)', display: 'grid', gridTemplateColumns: '1fr 120px auto auto', gap: 8, alignItems: 'end' }}>
      <LField label="Bill of materials">
        <select style={inp()} value={bomId} onChange={(e) => setBomId(e.target.value)}>
          <option value="">—</option>
          {boms.map((b) => <option key={b.id} value={b.id}>{itemLookup.byId.get(b.finished_qbo_item_id)?.item_name ?? b.finished_qbo_item_id}{b.name ? ` · ${b.name}` : ''}</option>)}
        </select>
      </LField>
      <LField label="Cases"><input type="number" min={1} step="any" style={inp()} value={qty} onChange={(e) => setQty(e.target.value)} /></LField>
      <button style={btnSecondary()} onClick={onCancel}>Cancel</button>
      <button style={btnPrimary()} disabled={busy || !bomId || !(Number(qty) > 0)} onClick={() => onAdd(bomId, Number(qty))}>Add</button>
    </div>
  );
}

function RunShipDialog({ run, wos, busy, onCancel, onSubmit }: {
  run: ProductionRun; wos: WorkOrderView[]; busy: boolean; onCancel: () => void; onSubmit: (payload: Record<string, unknown>) => void;
}) {
  const [carrier, setCarrier] = useState(''); const [tracking, setTracking] = useState(''); const [pro, setPro] = useState('');
  const [date, setDate] = useState(''); const [pallets, setPallets] = useState(''); const [weight, setWeight] = useState(''); const [instr, setInstr] = useState('');
  const shipping = wos.filter((w) => w.status === 'yield_recorded');
  const cases = shipping.reduce((t, w) => t + Number(w.qty_produced_actual ?? 0), 0);
  return (
    <div className="cd" style={{ padding: 12, marginTop: 12, border: '1px solid var(--ac)' }}>
      <div style={{ fontSize: 10.5, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
        One bill of lading — {fmtNum(cases)} cases across {shipping.length} flavour{shipping.length === 1 ? '' : 's'}, {run.copacker_location_label ?? 'co-packer'} → {run.destination_location_label ?? 'warehouse'}
      </div>
      <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 10 }}>
        {shipping.map((w) => `${w.batch_code} ${fmtNum(Number(w.qty_produced_actual ?? 0))}`).join(' · ')}. Lots entered on each work order print one BOL line per lot; a flavour with no lots ships as one line. The co-packer's purchase order closes when this ships.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <LField label="Carrier"><input style={inp()} value={carrier} onChange={(e) => setCarrier(e.target.value)} /></LField>
        <LField label="Tracking #"><input style={inp()} value={tracking} onChange={(e) => setTracking(e.target.value)} /></LField>
        <LField label="PRO #"><input style={inp()} value={pro} onChange={(e) => setPro(e.target.value)} /></LField>
        <LField label="Ship date"><input type="date" style={inp()} value={date} onChange={(e) => setDate(e.target.value)} /></LField>
        <LField label="Pallets"><input type="number" min={0} step="any" style={inp()} value={pallets} onChange={(e) => setPallets(e.target.value)} /></LField>
        <LField label="Total weight (lbs)"><input type="number" min={0} step="any" style={inp()} value={weight} onChange={(e) => setWeight(e.target.value)} /></LField>
        <LField label="Special instructions"><input style={inp()} value={instr} onChange={(e) => setInstr(e.target.value)} /></LField>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button style={btnSecondary()} onClick={onCancel}>Cancel</button>
        <button style={btnPrimary()} disabled={busy} onClick={() => onSubmit({
          carrier: carrier || null, tracking: tracking || null, pro_number: pro || null, ship_date: date || null,
          total_pallets: pallets || null, total_weight_lbs: weight || null, special_instructions: instr || null,
        })}><FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Ship it — one BOL</button>
      </div>
    </div>
  );
}

function stageStamp(run: ProductionRun, status: string): string | null {
  const map: Record<string, string | null | undefined> = { draft: run.created_at, ordered: run.ordered_at, in_progress: run.started_at, closed: run.closed_at };
  const v = map[status];
  return v ? new Date(v).toLocaleDateString() : null;
}
