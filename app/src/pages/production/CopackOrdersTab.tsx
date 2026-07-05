import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { CheckCircle2, FileText, Plus, Send, X as XIcon } from 'lucide-react';
import {
  CopackOrderCosts, CopackOrderRow, CopackOrderStatus, ProductBom, ProductBomLine,
  closeCopackOrder, createCopackOrder, fetchBomLines, fetchCopackOrderCosts,
  receiveCopackOrder, sendCopackOrder, voidCopackOrder,
} from '../../lib/production';
import type { QboVendor } from '../../lib/purchasing';
import type { InventoryLocation } from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { fm, fmtNum } from '../../lib/formatters';
import { GRID_DEFAULTS, GRID_SX } from '../stock/stockStyles';
import { fmtQty, scaleBom, UOM_OPTIONS } from '../../lib/uom';
import type { ProductionItemLookup } from './ProductionPage';
import { ProductionUnitConverter } from './ProductionUnitConverter';
import { MaterialRequirementsPanel } from './MaterialRequirementsPanel';

const STATUS_COLOR: Record<CopackOrderStatus, string> = {
  draft: 'var(--mt)',
  sent: 'var(--ac)',
  received: 'var(--gn)',
  closed: '#64748b',
  void: '#64748b',
};

const TANK_SIZES_GAL = [500, 1500, 2000, 2500];

interface Props {
  orders: CopackOrderRow[] | null;
  boms: ProductBom[];
  bomById: Map<string, ProductBom>;
  vendors: QboVendor[] | null;
  locations: InventoryLocation[];
  locById: Map<string, InventoryLocation>;
  itemLookup: ProductionItemLookup;
  onChanged: () => void;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function CopackOrdersTab({
  orders, boms, bomById, vendors, locations, locById, itemLookup, onChanged,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | CopackOrderStatus>('all');

  const activeBoms = useMemo(() => boms.filter((b) => b.is_active), [boms]);
  const activeVendors = useMemo(
    () => (vendors ?? []).filter((v) => v.active).sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [vendors],
  );
  const physicalLocs = useMemo(
    () => locations.filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment'),
    [locations],
  );

  const filtered = useMemo(() => {
    const list = orders ?? [];
    if (statusFilter === 'all') return list;
    return list.filter((o) => o.status === statusFilter);
  }, [orders, statusFilter]);

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'order_number', headerName: 'Order #', width: 145,
      renderCell: (p) => (
        <button onClick={() => setOpenId(String(p.row.id))} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontWeight: 600, padding: 0, fontSize: 12,
        }}>{String(p.value ?? '')}</button>
      ),
    },
    {
      field: 'status', headerName: 'Status', width: 105,
      renderCell: (p) => {
        const v = String(p.value ?? '') as CopackOrderStatus;
        const c = STATUS_COLOR[v] ?? 'var(--mt)';
        return <span style={{
          background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
          padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
        }}>{v.toUpperCase()}</span>;
      },
    },
    { field: 'vendor_name', headerName: 'Co-packer', width: 180,
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{String(p.value ?? p.row.qbo_vendor_id ?? '—')}</span> },
    { field: 'finished_item_name', headerName: 'Finished SKU', flex: 1, minWidth: 210,
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{String(p.value ?? p.row.finished_qbo_item_id)}</span> },
    {
      field: 'qty_ordered', headerName: 'Ordered', width: 115, cellClassName: 'mn',
      renderCell: (p) => fmtQty(Number(p.row.qty_ordered ?? 0), String(p.row.target_uom ?? 'gal')),
    },
    {
      field: 'actual_yield_qty', headerName: 'Received', width: 125, cellClassName: 'mn',
      renderCell: (p) => p.row.actual_yield_qty == null
        ? <span style={{ color: 'var(--mt)' }}>—</span>
        : fmtQty(Number(p.row.actual_yield_qty), String(p.row.actual_yield_uom ?? p.row.target_uom ?? 'gal')),
    },
    { field: 'finished_units_received', headerName: 'Finished Units', width: 120, cellClassName: 'mn',
      valueFormatter: (v) => v == null ? '—' : fmtNum(Number(v)) },
    { field: 'unit_cost', headerName: 'Landed $/unit', type: 'number', width: 125, cellClassName: 'mn',
      valueFormatter: (v) => v == null ? '—' : `$${Number(v).toFixed(4)}` },
    { field: 'total_cost', headerName: 'Total COGS', type: 'number', width: 115, cellClassName: 'mn',
      valueFormatter: (v) => Number(v ?? 0) > 0 ? fm(Number(v)) : '—' },
    { field: 'expected_date', headerName: 'Expected', width: 110,
      valueFormatter: (v) => v ? String(v) : '—' },
  ], []);

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="toolbar-section" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="toolbar-label">Status</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | CopackOrderStatus)} style={inp()}>
              <option value="all">All</option>
              <option value="draft">Draft</option>
              <option value="sent">Sent</option>
              <option value="received">Received</option>
              <option value="closed">Closed</option>
              <option value="void">Void</option>
            </select>
          </div>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button onClick={() => setCreating(true)} style={btnPrimary()}
            disabled={activeBoms.length === 0 || activeVendors.length === 0 || physicalLocs.length === 0}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> New Co-Pack Order
          </button>
        </div>
      </div>

      {(activeBoms.length === 0 || activeVendors.length === 0) && (
        <div style={{
          padding: 10, marginBottom: 14,
          background: 'rgba(239,191,65,0.08)', border: '1px solid rgba(239,191,65,0.30)',
          borderRadius: 4, fontSize: 11, color: 'var(--am)',
        }}>
          Co-pack orders need an active BOM and an active QBO vendor.
        </div>
      )}

      {creating && (
        <CreateCopackOrderForm
          boms={activeBoms}
          vendors={activeVendors}
          locations={physicalLocs}
          itemLookup={itemLookup}
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); onChanged(); }}
        />
      )}

      <div className="cd" style={{ padding: 0 }}>
        <DataGridPro
          rows={filtered.map((o) => ({ ...o, id: o.id }))}
          columns={columns}
          {...GRID_DEFAULTS}
          sx={GRID_SX}
          density="compact"
          loading={orders === null}
          initialState={{ sorting: { sortModel: [{ field: 'created_at', sort: 'desc' }] } }}
          disableRowSelectionOnClick
        />
      </div>

      {openId && (
        <CopackOrderDetailModal
          orderId={openId}
          order={(orders ?? []).find((o) => o.id === openId) ?? null}
          bomById={bomById}
          locById={locById}
          itemLookup={itemLookup}
          onClose={() => setOpenId(null)}
          onChanged={() => { setOpenId(null); onChanged(); }}
        />
      )}
    </div>
  );
}

function CreateCopackOrderForm({
  boms, vendors, locations, itemLookup, onCancel, onCreated,
}: {
  boms: ProductBom[];
  vendors: QboVendor[];
  locations: InventoryLocation[];
  itemLookup: ProductionItemLookup;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [bomId, setBomId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [locId, setLocId] = useState('');
  const [qty, setQty] = useState('500');
  const [targetUom, setTargetUom] = useState('gal');
  const [expected, setExpected] = useState('');
  const [coPackFee, setCoPackFee] = useState('');
  const [freight, setFreight] = useState('');
  const [otherCost, setOtherCost] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const selectedBom = boms.find((b) => b.id === bomId);
  const selectedFinished = selectedBom ? itemLookup.byId.get(selectedBom.finished_qbo_item_id) : null;
  const canSave = !!bomId && !!vendorId && !!locId && Number(qty) > 0;

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      await createCopackOrder({
        bom_id: bomId,
        qbo_vendor_id: vendorId,
        destination_location_id: locId,
        qty_ordered: Number(qty),
        target_uom: targetUom,
        expected_date: expected || null,
        co_pack_fee: Number(coPackFee || 0),
        freight_cost: Number(freight || 0),
        other_landed_cost: Number(otherCost || 0),
        notes: notes || null,
      });
      toast.success('Co-pack order created');
      onCreated();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="cd" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
          New Co-Pack Order
        </div>
        <button onClick={onCancel} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
          <XIcon size={14} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginBottom: 12 }}>
        <LField label="BOM">
          <select style={inp()} value={bomId} onChange={(e) => {
            const id = e.target.value;
            const b = boms.find((x) => x.id === id);
            setBomId(id);
            if (b) {
              setTargetUom(b.yield_uom || 'gal');
              setQty(String(b.yield_qty || 500));
            }
          }}>
            <option value="">—</option>
            {boms.map((b) => {
              const it = itemLookup.byId.get(b.finished_qbo_item_id);
              return <option key={b.id} value={b.id}>{it?.item_name ?? b.finished_qbo_item_id} · {fmtQty(Number(b.yield_qty), b.yield_uom || 'gal')}</option>;
            })}
          </select>
        </LField>
        <LField label="Co-packer">
          <select style={inp()} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">—</option>
            {vendors.map((v) => <option key={v.qbo_vendor_id} value={v.qbo_vendor_id}>{v.display_name}</option>)}
          </select>
        </LField>
        <LField label="Receive to">
          <select style={inp()} value={locId} onChange={(e) => setLocId(e.target.value)}>
            <option value="">—</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
          </select>
        </LField>
        <LField label="Expected date">
          <input type="date" style={inp()} value={expected} onChange={(e) => setExpected(e.target.value)} />
        </LField>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
        <LField label="Ordered yield">
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" min={0.0001} step="any" style={{ ...inp(), flex: 1 }}
              value={qty} onChange={(e) => setQty(e.target.value)} />
            <select value={targetUom} onChange={(e) => setTargetUom(e.target.value)} style={{ ...inp(), width: 90 }}>
              {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {targetUom === 'gal' && (
            <div style={{ display: 'flex', gap: 4, marginTop: 5, flexWrap: 'wrap' }}>
              {TANK_SIZES_GAL.map((tank) => (
                <button key={tank} type="button" onClick={() => setQty(String(tank))}
                  style={{ ...btnSecondary(), padding: '3px 7px', fontSize: 10 }}>
                  {tank} gal
                </button>
              ))}
            </div>
          )}
        </LField>
        <LField label="Co-pack fee">
          <input type="number" min={0} step="any" style={inp()} value={coPackFee} onChange={(e) => setCoPackFee(e.target.value)} />
        </LField>
        <LField label="Estimated freight">
          <input type="number" min={0} step="any" style={inp()} value={freight} onChange={(e) => setFreight(e.target.value)} />
        </LField>
        <LField label="Other landed cost">
          <input type="number" min={0} step="any" style={inp()} value={otherCost} onChange={(e) => setOtherCost(e.target.value)} />
        </LField>
      </div>

      {selectedBom && (
        <div style={{ marginBottom: 12 }}>
          <ProductionUnitConverter
            title="Order conversion"
            cansPerFinishedUnit={Number(selectedBom.cans_per_case || 24)}
            ozPerCan={Number(selectedBom.oz_per_can || 12)}
            initialQty={Number(qty) > 0 ? Number(qty) : Number(selectedBom.yield_qty)}
            initialUnit={(targetUom === 'gal' || targetUom === 'fl_oz') ? targetUom : 'gal'}
          />
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--mt)' }}>
            Finished item: <strong style={{ color: 'var(--tx)' }}>{selectedFinished?.item_name ?? selectedBom.finished_qbo_item_id}</strong>
          </div>
        </div>
      )}

      {selectedBom && Number(qty) > 0 && (
        <MaterialRequirementsPanel
          bomId={selectedBom.id}
          targetQty={Number(qty)}
          targetUom={targetUom}
          title="Raw materials to stage for co-packer"
        />
      )}

      <LField label="Notes / instructions for co-packer">
        <textarea rows={2} style={{ ...inp(), width: '100%', resize: 'vertical', minHeight: 36 }}
          value={notes} onChange={(e) => setNotes(e.target.value)} />
      </LField>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button onClick={onCancel} style={btnSecondary()}>Cancel</button>
        <button onClick={submit} disabled={!canSave || saving} style={btnPrimary()}>
          {saving ? 'Creating…' : 'Create Draft'}
        </button>
      </div>
    </div>
  );
}

function CopackOrderDetailModal({
  orderId, order, bomById, locById, itemLookup, onClose, onChanged,
}: {
  orderId: string;
  order: CopackOrderRow | null;
  bomById: Map<string, ProductBom>;
  locById: Map<string, InventoryLocation>;
  itemLookup: ProductionItemLookup;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [bomLines, setBomLines] = useState<ProductBomLine[] | null>(null);
  const [costs, setCosts] = useState<CopackOrderCosts | null>(null);
  const [actualQty, setActualQty] = useState('');
  const [actualUom, setActualUom] = useState('gal');
  const [coPackFee, setCoPackFee] = useState('');
  const [freight, setFreight] = useState('');
  const [otherCost, setOtherCost] = useState('');
  const [receivedAt, setReceivedAt] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    if (order) {
      fetchBomLines(order.bom_id).then((ls) => alive && setBomLines(ls)).catch(() => alive && setBomLines([]));
      fetchCopackOrderCosts(order.id).then((c) => alive && setCosts(c)).catch(() => alive && setCosts(null));
      setActualQty(order.actual_yield_qty == null ? String(order.qty_ordered) : String(order.actual_yield_qty));
      setActualUom(order.actual_yield_uom || order.target_uom || 'gal');
      setCoPackFee(Number(order.co_pack_fee || 0) > 0 ? String(order.co_pack_fee) : '');
      setFreight(Number(order.freight_cost || 0) > 0 ? String(order.freight_cost) : '');
      setOtherCost(Number(order.other_landed_cost || 0) > 0 ? String(order.other_landed_cost) : '');
    }
    return () => { alive = false; };
  }, [orderId, order]);

  if (!order) return null;
  const bom = bomById.get(order.bom_id);
  const loc = locById.get(order.destination_location_id);
  const finished = itemLookup.byId.get(order.finished_qbo_item_id);
  const orderedLabel = fmtQty(Number(order.qty_ordered), order.target_uom || 'gal');
  const receivedLabel = order.actual_yield_qty == null
    ? '—'
    : fmtQty(Number(order.actual_yield_qty), order.actual_yield_uom || order.target_uom || 'gal');
  const planned = bom && bomLines ? scaleBom(
    { qty: Number(order.qty_ordered), uom: order.target_uom || 'gal' },
    {
      qty: Number(bom.yield_qty),
      uom: bom.yield_uom || 'gal',
      finishedVolPerYieldGal: bom.finished_vol_per_yield_gal == null ? undefined : Number(bom.finished_vol_per_yield_gal),
      dilutionRatio: Number(bom.dilution_ratio ?? 0),
    },
    bomLines.map((l, idx) => {
      const it = l.component_qbo_item_id ? itemLookup.byId.get(l.component_qbo_item_id) : null;
      return {
        qty_per: Number(l.qty_per),
        qty_uom: l.qty_uom || 'each',
        scrap_pct: Number(l.scrap_pct ?? 0),
        ref: { idx },
        itemName: it?.item_name ?? l.service_label ?? null,
        itemType: l.line_type === 'service' ? 'Service' : null,
      };
    }),
  ) : null;
  const plannedByIdx = new Map<number, { qty: number; uom: string }>();
  if (planned) for (const line of planned.scaledLines) plannedByIdx.set(line.ref.idx, { qty: line.qty, uom: line.uom });

  async function doSend() {
    setBusy(true);
    try {
      await sendCopackOrder(orderId);
      toast.success('Co-pack order marked sent');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doReceive() {
    const actual = Number(actualQty);
    if (!(actual > 0)) {
      toast.error('Enter actual yield received');
      return;
    }
    if (!confirm(`Receive ${order!.order_number}?\n\nThis will add finished inventory at landed unit cost using BOM cost + co-pack fee + freight.`)) return;
    setBusy(true);
    try {
      await receiveCopackOrder({
        order_id: orderId,
        actual_yield_qty: actual,
        actual_yield_uom: actualUom,
        co_pack_fee: coPackFee === '' ? null : Number(coPackFee),
        freight_cost: freight === '' ? null : Number(freight),
        other_landed_cost: otherCost === '' ? null : Number(otherCost),
        received_at: receivedAt || null,
      });
      toast.success('Received finished goods and locked landed COGS');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doClose() {
    setBusy(true);
    try {
      await closeCopackOrder(orderId);
      toast.success('Co-pack order closed');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doVoid() {
    const reason = prompt('Void reason?');
    if (!reason) return;
    setBusy(true);
    try {
      await voidCopackOrder(orderId, reason);
      toast.success('Co-pack order voided');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  function printOrder() {
    const w = window.open('', '_blank');
    if (!w) return;
    const rows = (bomLines ?? []).map((l, idx) => {
      const itemName = l.line_type === 'component'
        ? itemLookup.byId.get(l.component_qbo_item_id ?? '')?.item_name ?? l.component_qbo_item_id ?? '?'
        : l.service_label ?? '?';
      const scaled = plannedByIdx.get(idx);
      return `<tr>
        <td>${escapeHtml(itemName)}</td>
        <td>${escapeHtml(l.line_type)}</td>
        <td style="text-align:right">${escapeHtml(fmtQty(Number(l.qty_per), l.qty_uom || 'each'))}</td>
        <td style="text-align:right">${escapeHtml(scaled ? fmtQty(scaled.qty, scaled.uom) : '-')}</td>
      </tr>`;
    }).join('');
    w.document.write(`<html><head><title>${escapeHtml(order!.order_number)}</title>
      <style>
        @page{size:letter;margin:0.5in}
        body{font-family:system-ui,sans-serif;color:#0a0e17;font-size:11px;margin:0}
        h1{font-size:20px;border-bottom:3px solid #0a0e17;padding-bottom:6px;margin:0 0 12px}
        .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
        .kv{border:1px solid #0a0e17;padding:6px 8px}
        .lbl{font-size:8px;font-weight:700;letter-spacing:1px;color:#475569;text-transform:uppercase}
        table{width:100%;border-collapse:collapse;font-size:10.5px;border:1px solid #0a0e17;margin-top:10px}
        th{background:#0a0e17;color:#fff;padding:5px 6px;font-size:8.5px;text-align:left;text-transform:uppercase;letter-spacing:1px}
        td{padding:5px 6px;border-bottom:1px solid #e2e8f0}
      </style></head><body>
      <h1>Co-Pack Order · ${escapeHtml(order!.order_number)}</h1>
      <div class="meta">
        <div class="kv"><div class="lbl">Co-packer</div>${escapeHtml(order!.vendor_name ?? order!.qbo_vendor_id)}</div>
        <div class="kv"><div class="lbl">Finished SKU</div>${escapeHtml(finished?.item_name ?? order!.finished_item_name ?? order!.finished_qbo_item_id)}</div>
        <div class="kv"><div class="lbl">Ordered yield</div>${escapeHtml(orderedLabel)}</div>
        <div class="kv"><div class="lbl">Expected</div>${escapeHtml(order!.expected_date ?? '-')}</div>
        <div class="kv"><div class="lbl">Receive to</div>${escapeHtml(loc?.name ?? order!.location_label ?? '-')}</div>
        <div class="kv"><div class="lbl">Instructions</div>${escapeHtml(order!.notes ?? '-')}</div>
      </div>
      <table><thead><tr><th>Item / Service</th><th>Type</th><th style="text-align:right">Qty / Recipe</th><th style="text-align:right">Required</th></tr></thead><tbody>${rows}</tbody></table>
      <script>setTimeout(function(){window.print()},300);</script>
      </body></html>`);
    w.document.close();
  }

  const canSend = order.status === 'draft';
  const canReceive = order.status === 'draft' || order.status === 'sent';
  const canClose = order.status === 'received';
  const canVoid = order.status === 'draft' || order.status === 'sent';

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '90px 20px 20px', overflowY: 'auto',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
        maxWidth: 980, width: '100%', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto', padding: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
              Co-Pack Order · {order.status.toUpperCase()}
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 22, fontFamily: 'var(--ff-mono)', color: 'var(--ac)' }}>
              {order.order_number}
            </h2>
            <div style={{ marginTop: 4, color: 'var(--tx)', fontSize: 13 }}>
              {order.vendor_name ?? order.qbo_vendor_id} · {finished?.item_name ?? order.finished_item_name ?? order.finished_qbo_item_id}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
            <XIcon size={18} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, fontSize: 12, marginBottom: 14 }}>
          <Meta label="Ordered yield" value={orderedLabel} />
          <Meta label="Actual yield" value={receivedLabel} />
          <Meta label="Finished units" value={order.finished_units_received == null ? '—' : fmtNum(Number(order.finished_units_received))} />
          <Meta label="Receive to" value={loc ? `${loc.code} — ${loc.name}` : order.location_label ?? '—'} />
        </div>

        {bom && (
          <div style={{ marginBottom: 14 }}>
            <ProductionUnitConverter
              title="Order conversion"
              cansPerFinishedUnit={Number(bom.cans_per_case || 24)}
              ozPerCan={Number(bom.oz_per_can || 12)}
              initialQty={Number(order.actual_yield_qty ?? order.qty_ordered)}
              initialUnit={(actualUom === 'gal' || actualUom === 'fl_oz') ? actualUom : 'gal'}
            />
          </div>
        )}

        {bom && (
          <MaterialRequirementsPanel
            bomId={bom.id}
            targetQty={Number(order.qty_ordered)}
            targetUom={order.target_uom || 'gal'}
            title="Raw materials to stage for co-packer"
          />
        )}

        {canReceive && (
          <div style={{
            marginBottom: 14, padding: 12,
            border: '1px solid var(--bd)', borderRadius: 4,
            background: 'rgba(91,181,240,0.04)',
          }}>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 }}>
              Receive finished goods and landed cost
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
              <LField label="Actual yield">
                <div style={{ display: 'flex', gap: 6 }}>
                  <input type="number" min={0.0001} step="any" style={{ ...inp(), flex: 1 }} value={actualQty} onChange={(e) => setActualQty(e.target.value)} />
                  <select value={actualUom} onChange={(e) => setActualUom(e.target.value)} style={{ ...inp(), width: 90 }}>
                    {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </LField>
              <LField label="Co-pack fee">
                <input type="number" min={0} step="any" style={inp()} value={coPackFee} onChange={(e) => setCoPackFee(e.target.value)} />
              </LField>
              <LField label="Inbound freight">
                <input type="number" min={0} step="any" style={inp()} value={freight} onChange={(e) => setFreight(e.target.value)} />
              </LField>
              <LField label="Other landed cost">
                <input type="number" min={0} step="any" style={inp()} value={otherCost} onChange={(e) => setOtherCost(e.target.value)} />
              </LField>
              <LField label="Receipt timestamp">
                <input type="datetime-local" style={inp()} value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
              </LField>
            </div>
          </div>
        )}

        {costs && (
          <div style={{
            marginBottom: 14, padding: 12,
            background: 'rgba(125,238,164,0.06)', border: '1px solid rgba(125,238,164,0.20)', borderRadius: 4,
          }}>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 }}>
              Landed COGS · locked {new Date(costs.computed_at).toLocaleString()}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, fontSize: 13 }}>
              <Kv label="BOM components" value={fm(Number(costs.components_cost))} />
              <Kv label="BOM services" value={fm(Number(costs.services_cost))} />
              <Kv label="Co-pack fee" value={fm(Number(costs.co_pack_fee))} />
              <Kv label="Freight" value={fm(Number(costs.freight_cost))} />
              <Kv label="Total" value={fm(Number(costs.total_cost))} bold accent />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 13, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--bd)' }}>
              <Kv label="$ / finished unit" value={costs.unit_cost == null ? '—' : `$${Number(costs.unit_cost).toFixed(4)}`} bold accent />
              <Kv label="$ / can" value={costs.per_can == null ? '—' : `$${Number(costs.per_can).toFixed(4)}`} />
              <Kv label="$ / oz" value={costs.per_oz == null ? '—' : `$${Number(costs.per_oz).toFixed(5)}`} />
              <Kv label="$ / gal" value={costs.per_gal_finished == null ? '—' : `$${Number(costs.per_gal_finished).toFixed(4)}`} />
            </div>
            {costs.detail.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 10 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                    <th style={th}>Cost item</th>
                    <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                    <th style={{ ...th, textAlign: 'right' }}>Unit $</th>
                    <th style={{ ...th, textAlign: 'right' }}>Extended</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.detail.map((d, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={td}>
                        <strong>{d.label}</strong>
                        <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{d.kind}</span>
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtQty(Number(d.qty), d.uom || 'each')}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>{d.unit_cost == null ? '—' : `$${Number(d.unit_cost).toFixed(4)}`}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fm(Number(d.extended_cost))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {bomLines && (
          <>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
              BOM basis for co-packer
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                  <th style={th}>Item / Service</th>
                  <th style={{ ...th, textAlign: 'right' }}>Qty / recipe</th>
                  <th style={{ ...th, textAlign: 'right' }}>Required for order</th>
                  <th style={{ ...th, textAlign: 'right' }}>Unit cost</th>
                </tr>
              </thead>
              <tbody>
                {bomLines.map((l, idx) => {
                  const label = l.line_type === 'component'
                    ? (itemLookup.byId.get(l.component_qbo_item_id ?? '')?.item_name ?? l.component_qbo_item_id ?? '?')
                    : l.service_label ?? '?';
                  const scaled = plannedByIdx.get(idx);
                  const baseCost = l.line_type === 'component'
                    ? (l.default_cost ?? itemLookup.byId.get(l.component_qbo_item_id ?? '')?.purchase_cost ?? null)
                    : l.default_cost;
                  return (
                    <tr key={l.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={td}>
                        <strong>{label}</strong>
                        <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{l.line_type}</span>
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtQty(Number(l.qty_per), l.qty_uom || 'each')}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{scaled ? fmtQty(scaled.qty, scaled.uom) : '—'}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>{baseCost == null ? '—' : `$${Number(baseCost).toFixed(4)}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        {order.notes && (
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--mt)' }}>
            <div style={{ fontSize: 9, letterSpacing: 0.6, textTransform: 'uppercase' }}>Instructions</div>
            {order.notes}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
          <button onClick={printOrder} style={btnSecondary()}>
            <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Print Order
          </button>
          {canVoid && <button onClick={doVoid} disabled={busy} style={btnDanger()}>Void</button>}
          {canSend && <button onClick={doSend} disabled={busy} style={btnPrimary()}><Send size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Mark Sent</button>}
          {canReceive && <button onClick={doReceive} disabled={busy} style={btnPrimary()}><CheckCircle2 size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Receive + Lock COGS</button>}
          {canClose && <button onClick={doClose} disabled={busy} style={btnPrimary()}>Close</button>}
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div>
    <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</div>
    <div style={{ marginTop: 3 }}>{value}</div>
  </div>;
}

function Kv({ label, value, bold, accent }: { label: string; value: string; bold?: boolean; accent?: boolean }) {
  return <div>
    <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</div>
    <div style={{
      marginTop: 3, fontWeight: bold ? 700 : 500,
      color: accent ? 'var(--ac)' : 'var(--tx)',
      fontFamily: 'var(--ff-mono)',
    }}>{value}</div>
  </div>;
}

function LField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div>
    <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
    {children}
  </div>;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600,
  letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)',
};
const td: React.CSSProperties = { padding: '6px 10px', verticalAlign: 'middle' };
