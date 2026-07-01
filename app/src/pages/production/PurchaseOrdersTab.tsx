import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Plus, X as XIcon, Truck, CheckCircle2 } from 'lucide-react';
import {
  PoStatus, PurchaseOrderLine, PurchaseOrderRow, QboVendor,
  closePurchaseOrder, createPurchaseOrder, fetchPoLines,
  pushPoToQbo, receivePurchaseOrderLine, voidPurchaseOrder,
} from '../../lib/purchasing';
import { InventoryLocation } from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { fmtNum, fm } from '../../lib/formatters';
import { GRID_SX, GRID_DEFAULTS } from '../stock/stockStyles';
import type { ProductionItemLookup } from './ProductionPage';
import { OpenPOsTab } from '../inventory/OpenPOsTab';

const STATUS_COLOR: Record<PoStatus, string> = {
  draft:    'var(--mt)',
  open:     'var(--ac)',
  partial:  'var(--am)',
  received: 'var(--gn)',
  closed:   '#64748b',
  void:     '#64748b',
};

interface Props {
  vendors: QboVendor[] | null;
  purchaseOrders: PurchaseOrderRow[] | null;
  locations: InventoryLocation[];
  locById: Map<string, InventoryLocation>;
  itemLookup: ProductionItemLookup;
  onChanged: () => void;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

interface PoPrefillLine {
  qbo_item_id: string;
  item_name: string;
  qty_ordered: number;
  unit_cost: number;
}
interface PoPrefillState {
  source: string;
  generated_at: string;
  lines: PoPrefillLine[];
}

function readPrefill(): PoPrefillState | null {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem('brix.po.prefill');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PoPrefillState;
    if (!parsed || !Array.isArray(parsed.lines) || parsed.lines.length === 0) return null;
    return parsed;
  } catch { return null; }
}

export function PurchaseOrdersTab({
  vendors, purchaseOrders, locations, locById, itemLookup, onChanged,
}: Props) {
  // Prefill comes from Inventory → Reorder ("Create PO"). When present, we
  // open the Create form on mount and seed its lines.
  const [prefill] = useState<PoPrefillState | null>(() => readPrefill());
  const [creating, setCreating] = useState(prefill !== null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | PoStatus>('all');

  // One-shot: clear sessionStorage so refreshing doesn't keep opening the form.
  useEffect(() => {
    if (prefill && typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('brix.po.prefill');
    }
  }, [prefill]);

  const physicalLocs = useMemo(
    () => locations.filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment'),
    [locations],
  );
  const activeVendors = useMemo(
    () => (vendors ?? []).filter((v) => v.active).sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [vendors],
  );

  const filtered = useMemo(() => {
    const list = purchaseOrders ?? [];
    if (statusFilter === 'all') return list;
    return list.filter((p) => p.status === statusFilter);
  }, [purchaseOrders, statusFilter]);

  const enriched = useMemo(() => filtered.map((p) => ({ ...p, id: p.id })), [filtered]);

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'po_number', headerName: 'PO #', width: 160,
      renderCell: (p) => (
        <button onClick={() => setOpenId(String(p.row.id))} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontWeight: 600, padding: 0, fontSize: 12,
        }}>{String(p.value ?? '')}</button>
      ),
    },
    {
      field: 'status', headerName: 'Status', width: 110,
      renderCell: (p) => {
        const v = String(p.value ?? '') as PoStatus;
        const c = STATUS_COLOR[v] ?? 'var(--mt)';
        return <span style={{
          background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
          padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
        }}>{v.toUpperCase()}</span>;
      },
    },
    { field: 'vendor_name', headerName: 'Vendor', flex: 1, minWidth: 200,
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{String(p.value ?? '—')}</span> },
    { field: 'location_label', headerName: 'Destination', width: 140,
      valueFormatter: (v) => String(v ?? '—') },
    { field: 'line_count', headerName: 'Lines', type: 'number', width: 80, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)) },
    {
      field: 'qty_received_total', headerName: 'Received / Ordered', width: 160, cellClassName: 'mn',
      renderCell: (p) => {
        const recv = Number(p.row.qty_received_total ?? 0);
        const ord  = Number(p.row.qty_ordered_total ?? 0);
        const pct  = ord > 0 ? Math.round((recv / ord) * 100) : 0;
        return <span>{fmtNum(recv)} / {fmtNum(ord)} <span style={{ color: 'var(--mt)' }}>({pct}%)</span></span>;
      },
    },
    { field: 'subtotal', headerName: 'Subtotal', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => fm(Number(v ?? 0)) },
    { field: 'expected_date', headerName: 'Expected', width: 110,
      valueFormatter: (v) => v ? String(v) : '—' },
    {
      field: 'qbo_purchase_order_id', headerName: 'QBO', width: 80,
      renderCell: (p) => p.value
        ? <span style={{ color: 'var(--gn)', fontWeight: 700, fontSize: 10 }}>#{String(p.value)}</span>
        : <span style={{ color: 'var(--mt)' }}>—</span>,
    },
    { field: 'created_at', headerName: 'Created', width: 160,
      valueFormatter: (v) => v ? new Date(String(v)).toLocaleString() : '—' },
  ], []);

  const componentItems = itemLookup.componentOptions;

  return (
    <div>
      {/* ── Unified view: all open POs (BRIX + QBO imported) ────────────
          Same component the Inventory page uses. Sync buttons live there
          now, not here. */}
      <div style={{ marginBottom: 18 }}>
        <div style={{
          fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6,
          textTransform: 'uppercase', marginBottom: 8, fontWeight: 700,
        }}>
          All Open Purchase Orders (BRIX-native + QBO imports)
        </div>
        <OpenPOsTab onChanged={onChanged} />
      </div>

      <div style={{
        fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6,
        textTransform: 'uppercase', marginTop: 24, marginBottom: 8, fontWeight: 700,
      }}>
        Manage BRIX-native POs (create · receive · push to QBO · void)
      </div>

      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="toolbar-section" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="toolbar-label">Status</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | PoStatus)} style={inp()}>
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="partial">Partial</option>
              <option value="received">Received</option>
              <option value="closed">Closed</option>
              <option value="void">Void</option>
            </select>
          </div>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button
            onClick={() => setCreating(true)}
            style={btnPrimary()}
            disabled={activeVendors.length === 0 || physicalLocs.length === 0}
          >
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> New PO
          </button>
        </div>
      </div>

      {activeVendors.length === 0 && (
        <div style={{
          padding: 10, marginBottom: 14,
          background: 'rgba(239,191,65,0.08)', border: '1px solid rgba(239,191,65,0.30)',
          borderRadius: 4, fontSize: 11, color: 'var(--am)',
        }}>
          No vendors loaded yet. Go to <strong>Inventory → Purchase Orders</strong> and click <strong>Pull Vendors from QBO</strong> first.
        </div>
      )}

      {creating && (
        <CreatePoForm
          vendors={activeVendors}
          locations={physicalLocs}
          componentItems={componentItems}
          itemLookup={itemLookup}
          prefill={prefill}
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); onChanged(); }}
        />
      )}

      <div className="cd" style={{ padding: 0 }}>
        <DataGridPro
          rows={enriched}
          columns={columns}
          {...GRID_DEFAULTS}
          sx={GRID_SX}
          density="compact"
          loading={purchaseOrders === null}
          initialState={{ sorting: { sortModel: [{ field: 'created_at', sort: 'desc' }] } }}
          disableRowSelectionOnClick
        />
      </div>

      {openId && (
        <PoDetailModal
          poId={openId}
          po={(purchaseOrders ?? []).find((p) => p.id === openId) ?? null}
          itemLookup={itemLookup}
          locById={locById}
          onClose={() => setOpenId(null)}
          onChanged={() => { setOpenId(null); onChanged(); }}
        />
      )}
    </div>
  );
}

// ── Create form ────────────────────────────────────────────────────────

interface DraftLine {
  qbo_item_id: string;
  qty_ordered: string;
  unit_cost: string;
  description: string;
}

function newDraftLine(): DraftLine {
  return { qbo_item_id: '', qty_ordered: '', unit_cost: '', description: '' };
}

function CreatePoForm({
  vendors, locations, componentItems, itemLookup, prefill, onCancel, onCreated,
}: {
  vendors: QboVendor[];
  locations: InventoryLocation[];
  componentItems: { id: string; label: string }[];
  itemLookup: ProductionItemLookup;
  prefill: PoPrefillState | null;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [vendorId, setVendorId] = useState('');
  const [locId, setLocId] = useState('');
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState(prefill ? 'Generated from inventory reorder list' : '');
  const [lines, setLines] = useState<DraftLine[]>(
    prefill && prefill.lines.length > 0
      ? prefill.lines.map((p) => ({
          qbo_item_id: p.qbo_item_id,
          qty_ordered: String(p.qty_ordered),
          unit_cost: p.unit_cost > 0 ? String(p.unit_cost) : '',
          description: '',
        }))
      : [newDraftLine()],
  );
  const [saving, setSaving] = useState(false);

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((cur) => cur.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }
  function addLine() { setLines((cur) => [...cur, newDraftLine()]); }
  function removeLine(idx: number) { setLines((cur) => cur.filter((_, i) => i !== idx)); }

  const subtotal = useMemo(() => lines.reduce((s, l) => {
    const q = Number(l.qty_ordered || 0);
    const c = Number(l.unit_cost || 0);
    return s + (q * c);
  }, 0), [lines]);

  const validLines = lines.filter((l) => l.qbo_item_id && Number(l.qty_ordered) > 0);
  const canSave = !!vendorId && !!locId && validLines.length > 0;

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      await createPurchaseOrder({
        qbo_vendor_id: vendorId,
        destination_location_id: locId,
        expected_date: expected || null,
        notes: notes || null,
        lines: validLines.map((l) => ({
          qbo_item_id: l.qbo_item_id,
          qty_ordered: Number(l.qty_ordered),
          unit_cost: Number(l.unit_cost || 0),
          description: l.description || null,
        })),
      });
      toast.success('Purchase order created');
      onCreated();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="cd" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
          New Purchase Order
        </div>
        <button onClick={onCancel} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
          <XIcon size={14} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginBottom: 12 }}>
        <LField label="Vendor">
          <select style={inp()} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">—</option>
            {vendors.map((v) => <option key={v.qbo_vendor_id} value={v.qbo_vendor_id}>{v.display_name}</option>)}
          </select>
        </LField>
        <LField label="Destination location">
          <select style={inp()} value={locId} onChange={(e) => setLocId(e.target.value)}>
            <option value="">—</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
          </select>
        </LField>
        <LField label="Expected date">
          <input type="date" style={inp()} value={expected} onChange={(e) => setExpected(e.target.value)} />
        </LField>
      </div>

      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
        Lines
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bd)' }}>
            <th style={th}>Item</th>
            <th style={{ ...th, width: 100, textAlign: 'right' }}>Qty</th>
            <th style={{ ...th, width: 110, textAlign: 'right' }}>Unit cost</th>
            <th style={{ ...th, width: 110, textAlign: 'right' }}>Extended</th>
            <th style={{ ...th, width: 200 }}>Description</th>
            <th style={{ ...th, width: 28 }} />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const qty = Number(l.qty_ordered || 0);
            const cost = Number(l.unit_cost || 0);
            return (
              <tr key={i} style={{ borderBottom: '1px solid var(--bd)' }}>
                <td style={td}>
                  <select style={{ ...inp(), width: '100%' }} value={l.qbo_item_id}
                    onChange={(e) => {
                      const id = e.target.value;
                      const it = id ? itemLookup.byId.get(id) : null;
                      updateLine(i, {
                        qbo_item_id: id,
                        unit_cost: l.unit_cost || (it?.purchase_cost ? String(it.purchase_cost) : ''),
                      });
                    }}>
                    <option value="">—</option>
                    {componentItems.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <input type="number" min={0.0001} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }}
                    value={l.qty_ordered} onChange={(e) => updateLine(i, { qty_ordered: e.target.value })} />
                </td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <input type="number" min={0} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }}
                    value={l.unit_cost} onChange={(e) => updateLine(i, { unit_cost: e.target.value })} />
                </td>
                <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fm(qty * cost)}</td>
                <td style={td}>
                  <input type="text" style={{ ...inp(), width: '100%' }} placeholder="—"
                    value={l.description} onChange={(e) => updateLine(i, { description: e.target.value })} />
                </td>
                <td style={{ ...td, textAlign: 'center' }}>
                  {lines.length > 1 && (
                    <button onClick={() => removeLine(i)} title="Remove" style={{
                      background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)', padding: 2,
                    }}>
                      <XIcon size={13} />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ ...td, fontSize: 10, color: 'var(--mt)' }}>
              <button onClick={addLine} style={{
                background: 'transparent', border: '1px dashed var(--bd)', cursor: 'pointer',
                color: 'var(--mt)', padding: '4px 10px', borderRadius: 4, fontSize: 10,
              }}>
                <Plus size={11} style={{ marginRight: 4, verticalAlign: -1 }} /> add line
              </button>
            </td>
            <td colSpan={2} style={{ ...td, textAlign: 'right', color: 'var(--mt)', fontSize: 10 }}>Subtotal</td>
            <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)', fontWeight: 700, color: 'var(--tx)' }}>{fm(subtotal)}</td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>

      <LField label="Notes">
        <textarea rows={2} style={{ ...inp(), width: '100%', resize: 'vertical', minHeight: 36 }}
          value={notes} onChange={(e) => setNotes(e.target.value)} />
      </LField>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button onClick={onCancel} style={btnSecondary()}>Cancel</button>
        <button onClick={submit} disabled={!canSave || saving} style={btnPrimary()}>
          {saving ? 'Creating…' : 'Create as Open'}
        </button>
      </div>
    </div>
  );
}

// ── Detail modal ───────────────────────────────────────────────────────

function PoDetailModal({
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
  const [busy, setBusy] = useState(false);
  const [receiving, setReceiving] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    fetchPoLines(poId).then((ls) => alive && setLines(ls)).catch(() => alive && setLines([]));
    return () => { alive = false; };
  }, [poId]);

  if (!po) return null;
  const destLabel = locById.get(po.destination_location_id)?.name ?? po.location_label ?? '—';

  async function doReceive(line: PurchaseOrderLine) {
    const qtyStr = receiving[line.id] ?? '';
    const qty = Number(qtyStr);
    if (!qty || qty <= 0) {
      toast.error('Enter a positive qty to receive');
      return;
    }
    setBusy(true);
    try {
      await receivePurchaseOrderLine({ po_line_id: line.id, qty_received: qty });
      toast.success('Received ' + fmtNum(qty) + ' · ' + line.qbo_item_id);
      setReceiving((cur) => { const n = { ...cur }; delete n[line.id]; return n; });
      const refreshed = await fetchPoLines(poId);
      setLines(refreshed);
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doClose() {
    if (!confirm('Mark PO ' + po!.po_number + ' as closed? Any unreceived lines will be force-closed.')) return;
    setBusy(true);
    try {
      await closePurchaseOrder(poId);
      toast.success('PO closed');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doVoid() {
    const reason = prompt('Void reason:');
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      await voidPurchaseOrder(poId, reason.trim());
      toast.success('PO voided');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doPushToQbo() {
    if (!confirm('Push PO ' + po!.po_number + ' to QuickBooks as a PurchaseOrder?')) return;
    setBusy(true);
    try {
      const r = await pushPoToQbo(poId);
      if (r.no_change) toast.info(r.message ?? 'Already pushed');
      else toast.success('Pushed to QBO as PO #' + r.qbo_purchase_order_id);
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  const canReceive = po.status === 'open' || po.status === 'partial';
  const canClose   = po.status === 'received' || po.status === 'partial';
  const canVoid    = po.status === 'draft' || po.status === 'open';
  const canPush    = !po.qbo_purchase_order_id && po.status !== 'void';

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
        maxWidth: 920, width: '100%', maxHeight: '90vh', overflow: 'auto', padding: 18,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
              Purchase Order · {po.status}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--ff-mono)', color: 'var(--tx)' }}>
              {po.po_number}
            </div>
            <div style={{ fontSize: 11, color: 'var(--mt)' }}>
              {po.vendor_name ?? po.qbo_vendor_id} · destination {destLabel}
              {po.expected_date && ' · expected ' + po.expected_date}
            </div>
            {po.qbo_purchase_order_id && (
              <div style={{ fontSize: 10, color: 'var(--gn)', marginTop: 4, fontWeight: 600 }}>
                ✓ Synced to QBO as PurchaseOrder #{po.qbo_purchase_order_id}
                {po.qbo_pushed_at && ' · ' + new Date(po.qbo_pushed_at).toLocaleString()}
              </div>
            )}
            {po.qbo_push_error && (
              <div style={{ fontSize: 10, color: 'var(--rd)', marginTop: 4 }}>QBO push error: {po.qbo_push_error}</div>
            )}
            {po.void_reason && (
              <div style={{ fontSize: 10, color: 'var(--rd)', marginTop: 4 }}>Voided: {po.void_reason}</div>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
            <XIcon size={16} />
          </button>
        </div>

        {po.notes && (
          <div style={{
            padding: 8, marginBottom: 12,
            background: 'rgba(91,181,240,0.04)', border: '1px solid var(--bd)', borderRadius: 4,
            fontSize: 11, color: 'var(--tx2)',
          }}>
            {po.notes}
          </div>
        )}

        <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
          Lines
        </div>
        {lines === null ? (
          <div className="ld">Loading…</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                <th style={th}>Item</th>
                <th style={{ ...th, textAlign: 'right', width: 100 }}>Ordered</th>
                <th style={{ ...th, textAlign: 'right', width: 100 }}>Received</th>
                <th style={{ ...th, textAlign: 'right', width: 90 }}>Unit cost</th>
                <th style={{ ...th, textAlign: 'right', width: 100 }}>Extended</th>
                {canReceive && <th style={{ ...th, width: 200 }}>Receive</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((ln) => {
                const itemName = itemLookup.byId.get(ln.qbo_item_id)?.item_name ?? ln.qbo_item_id;
                const remaining = Number(ln.qty_ordered) - Number(ln.qty_received);
                const fullyReceived = remaining <= 0;
                return (
                  <tr key={ln.id} style={{ borderBottom: '1px solid var(--bd)' }}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{itemName}</div>
                      {ln.description && <div style={{ fontSize: 10, color: 'var(--mt)' }}>{ln.description}</div>}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(ln.qty_ordered))}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)',
                      color: fullyReceived ? 'var(--gn)' : (Number(ln.qty_received) > 0 ? 'var(--am)' : 'var(--mt)') }}>
                      {fmtNum(Number(ln.qty_received))}
                      {fullyReceived && <CheckCircle2 size={11} style={{ marginLeft: 4, verticalAlign: -1 }} />}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fm(Number(ln.unit_cost))}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--ff-mono)', fontWeight: 600 }}>
                      {fm(Number(ln.qty_ordered) * Number(ln.unit_cost))}
                    </td>
                    {canReceive && (
                      <td style={td}>
                        {fullyReceived ? (
                          <span style={{ fontSize: 10, color: 'var(--mt)' }}>complete</span>
                        ) : (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <input
                              type="number" min={0.0001} max={remaining} step="any"
                              style={{ ...inp(), width: 80, textAlign: 'right' }}
                              placeholder={fmtNum(remaining)}
                              value={receiving[ln.id] ?? ''}
                              onChange={(e) => setReceiving((cur) => ({ ...cur, [ln.id]: e.target.value }))}
                            />
                            <button onClick={() => doReceive(ln)} disabled={busy} style={{
                              ...btnSecondary(), padding: '4px 9px',
                            }} title="Receive this qty">
                              <Truck size={12} />
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, paddingTop: 8, borderTop: '1px solid var(--bd)' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {canVoid && (
              <button onClick={doVoid} disabled={busy} style={btnDanger()}>Void</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={btnSecondary()}>Close</button>
            {canPush && (
              <button onClick={doPushToQbo} disabled={busy} style={btnSecondary()} title="Send this PO to QuickBooks">
                Push to QBO →
              </button>
            )}
            {canClose && (
              <button onClick={doClose} disabled={busy} style={btnPrimary()}>Close PO</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────

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
