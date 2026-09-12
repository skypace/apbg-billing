import { useEffect, useMemo, useState } from 'react';
import { PrintableTable } from '../../components/PrintableTable';
import { SearchSelect } from '../../components/SearchSelect';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Plus, X as XIcon } from 'lucide-react';
import {
  PoStatus, PurchaseOrderRow, QboVendor,
  createPurchaseOrder,
} from '../../lib/purchasing';
import { PoDetailModal, OriginBadge } from './PoDetailModal';
import { InventoryLocation } from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { fmtNum, fm } from '../../lib/formatters';
import { GRID_SX, GRID_DEFAULTS } from '../stock/stockStyles';
import type { ProductionItemLookup } from './ProductionPage';
import { OpenPOsTab } from '../inventory/OpenPOsTab';
import { INVENTORY_LANE_LABEL, describeLanes, type InventoryLane } from '../../lib/inventoryLane';
import { StatusBuckets } from '../../components/StatusBuckets';
import { BulkActionBar } from '../../components/BulkActionBar';
import { ReasonDialog } from '../../components/ReasonDialog';
import { BulkEditDialog } from '../../components/BulkEditDialog';
import { useGridSelection } from '../../lib/useGridSelection';
import { countBuckets, rowBucket, type Bucket } from '../../lib/lifecycleBuckets';
import { closePurchaseOrders, deleteDrafts, reopenDocs, summarizeBulk, updateDocs, voidDocs, type BulkResult } from '../../lib/bulkActions';

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
  /** Selected lanes (empty = all) — a PO can now carry 24-packs and 3-gallon on one order. */
  lanes: InventoryLane[];
  initialPoId?: string | null;
  onChanged: () => void;
  /** Open a work order's detail (the Work Orders tab) — a work order number on the PO is a link, not text (20260912a). */
  onOpenWo?: (woId: string) => void;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

interface PoPrefillLine {
  qbo_item_id: string;
  item_name: string;
  qty_ordered: number;
  unit_cost: number;
  default_receiving_location_id?: string | null;
}
interface PoPrefillState {
  source: string;
  generated_at: string;
  inventory_lane?: InventoryLane;
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
  vendors, purchaseOrders, locations, locById, itemLookup, lanes, initialPoId = null, onChanged, onOpenWo,
}: Props) {
  // Prefill comes from Inventory → Reorder ("Create PO"). When present, we
  // open the Create form on mount and seed its lines.
  const [prefill] = useState<PoPrefillState | null>(() => readPrefill());
  const [creating, setCreating] = useState(prefill !== null);
  const [openId, setOpenId] = useState<string | null>(initialPoId);
  const toast = useToast();
  const [bucket, setBucket] = useState<Bucket>('open');
  // Receiving is deliberately NOT a bulk action: a receipt creates the QuickBooks
  // Bill (po-receive, 2026-09-04), so it is done per PO from the detail modal.
  const [bulk, setBulk] = useState<'void' | 'delete' | 'edit' | 'close' | 'reopen' | null>(null);
  const [busy, setBusy] = useState(false);
  const sel = useGridSelection([bucket, lanes.join(',')]);

  // One-shot: clear sessionStorage so refreshing doesn't keep opening the form.
  useEffect(() => {
    if (prefill && typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('brix.po.prefill');
    }
  }, [prefill]);

  useEffect(() => {
    if (initialPoId) setOpenId(initialPoId);
  }, [initialPoId]);

  const physicalLocs = useMemo(
    () => locations.filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment'),
    [locations],
  );
  const activeVendors = useMemo(
    () => (vendors ?? []).filter((v) => v.active).sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [vendors],
  );

  const counts = useMemo(() => countBuckets('purchase_order', purchaseOrders ?? []), [purchaseOrders]);
  const filtered = useMemo(
    () => (purchaseOrders ?? []).filter((p) => rowBucket('purchase_order', p) === bucket),
    [purchaseOrders, bucket],
  );
  const selectedRows = useMemo(
    () => filtered.filter((p) => sel.selected.includes(p.id)),
    [filtered, sel.selected], // eslint-disable-line react-hooks/exhaustive-deps
  );

  function finishBulk(r: BulkResult, verb: string) {
    (r.skipped.length ? toast.info : toast.success)(summarizeBulk(r, verb));
    setBulk(null); sel.clear(); onChanged();
  }
  async function runBulk(verb: string, fn: () => Promise<BulkResult>) {
    setBusy(true);
    try { finishBulk(await fn(), verb); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }
  const closeItems = selectedRows.map((p) => ({
    id: p.id, number: p.po_number, eligible: p.status === 'received' || p.status === 'partial',
    why: p.status === 'closed' ? 'already closed' : p.status === 'void' ? 'void' : 'nothing received yet — receive it, or void it',
  }));
  const reopenItems = selectedRows.map((p) => ({
    id: p.id, number: p.po_number, eligible: p.status === 'closed', why: 'not closed',
  }));
  const voidItems = selectedRows.map((p) => ({
    id: p.id, number: p.po_number,
    eligible: (p.status === 'draft' || p.status === 'open') && !(Number(p.qty_received_total) > 0),
    why: p.status === 'void' ? 'already void'
      : Number(p.qty_received_total) > 0 || p.status === 'partial' || p.status === 'received' ? 'has receipts booked — close it out instead'
      : p.status === 'closed' ? 'closed — nothing to void' : 'not voidable from ' + p.status,
    detail: p.qbo_purchase_order_id ? 'Already in QuickBooks as PO ' + p.qbo_purchase_order_id + ' — close it there by hand' : undefined,
  }));
  const deleteItems = selectedRows.map((p) => ({
    id: p.id, number: p.po_number,
    eligible: p.status === 'draft' && !p.qbo_purchase_order_id && !(Number(p.qty_received_total) > 0),
    why: p.status !== 'draft' ? 'not a draft — void it instead'
      : p.qbo_purchase_order_id ? 'already in QuickBooks — void it instead' : 'has receipts',
  }));

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
    {
      field: 'work_order_batch_code', headerName: 'Work Order', width: 150,
      // A run PO carries several work orders: name the order, and the WOs on hover.
      renderCell: (p) => p.value
        ? <span style={{ color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontSize: 11 }}>{String(p.value)}</span>
        : p.row.run_number
          ? <span title={p.row.work_order_batch_codes ? `Work orders ${p.row.work_order_batch_codes}` : 'Production order'}
              style={{ color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontSize: 10.5, border: '1px solid var(--bd)', borderRadius: 4, padding: '1px 6px' }}>{String(p.row.run_number)}</span>
          : <span style={{ color: 'var(--mt)' }}>—</span>,
    },
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
      field: 'origin', headerName: 'Created in', width: 120,
      renderCell: (p) => <OriginBadge origin={p.row.origin} />,
    },
    {
      field: 'qbo_purchase_order_id', headerName: 'QuickBooks', width: 150,
      renderCell: (p) => {
        const row = p.row as PurchaseOrderRow;
        if (!row.qbo_purchase_order_id) return <span style={{ color: 'var(--am)', fontSize: 10 }}>not pushed</span>;
        return (
          <span style={{ fontSize: 10 }}>
            <span style={{ color: 'var(--gn)', fontWeight: 700 }}>#{row.qbo_purchase_order_id}</span>
            {row.qbo_status && <span style={{ color: 'var(--mt)' }}> · {row.qbo_status}</span>}
            {row.qbo_dirty && <span style={{ color: 'var(--am)', fontWeight: 700 }}> · edits to push</span>}
            {row.bills_pending > 0 && <span style={{ color: 'var(--rd)', fontWeight: 700 }}> · bill failed</span>}
          </span>
        );
      },
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
          All Open Purchase Orders (Refractor + QuickBooks, one list)
        </div>
        <OpenPOsTab lanes={lanes} itemLookup={itemLookup} onChanged={onChanged} />
      </div>

      <div style={{
        fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6,
        textTransform: 'uppercase', marginTop: 24, marginBottom: 8, fontWeight: 700,
      }}>
        Manage purchase orders (create · edit · receive → QuickBooks bill · push · void)
      </div>

      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <StatusBuckets kind="purchase_order" value={bucket} counts={counts} onChange={setBucket} />
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
          lanes={lanes}
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
          {...sel.gridProps}
        />
      </div>

      <BulkActionBar count={sel.selected.length} noun="purchase order" onClear={sel.clear}>
        {bucket === 'open' && (
          <button type="button" className="tb-btn tb-btn--primary" disabled={busy} onClick={() => setBulk('close')}>Close…</button>
        )}
        {bucket === 'closed' && (
          <button type="button" className="tb-btn tb-btn--primary" disabled={busy} onClick={() => setBulk('reopen')}>Reopen…</button>
        )}
        {bucket !== 'voided' && <button type="button" className="tb-btn" disabled={busy} onClick={() => setBulk('edit')}>Edit…</button>}
        {(bucket === 'open' || bucket === 'pending') && (
          <button type="button" className="tb-btn" disabled={busy} style={{ color: 'var(--rd)' }} onClick={() => setBulk('void')}>Void…</button>
        )}
        {bucket === 'pending' && (
          <button type="button" className="tb-btn" disabled={busy} style={{ color: 'var(--rd)' }} onClick={() => setBulk('delete')}>Delete drafts…</button>
        )}
      </BulkActionBar>
      {bulk === 'void' && (
        <ReasonDialog title="Void purchase orders" verb={`Void ${voidItems.filter((i) => i.eligible).length} PO${voidItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={voidItems} busy={busy}
          note="A voided PO releases the work-order materials it covered, so Generate POs can raise a replacement. A PO already pushed to QuickBooks is voided here only — close it in QuickBooks by hand."
          onCancel={() => setBulk(null)}
          onConfirm={(reason, ids) => runBulk('voided', () => voidDocs('purchase_order', ids, reason))} />
      )}
      {bulk === 'delete' && (
        <ReasonDialog title="Delete draft purchase orders" verb={`Delete ${deleteItems.filter((i) => i.eligible).length} draft${deleteItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={deleteItems} needReason={false} busy={busy}
          note="Only a draft that is not in QuickBooks and has no receipts can be deleted. This is permanent — anything further along is voided instead."
          onCancel={() => setBulk(null)}
          onConfirm={(_reason, ids) => runBulk('deleted', () => deleteDrafts('purchase_order', ids))} />
      )}
      {bulk === 'close' && (
        <ReasonDialog title="Close purchase orders" verb={`Close ${closeItems.filter((i) => i.eligible).length} PO${closeItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={closeItems} needReason={false} busy={busy}
          note="Closing says nothing more is expected on the PO. Any line still short stays short (the vendor shipped less) — a closed PO can be reopened, and a receipt corrected, from its detail."
          onCancel={() => setBulk(null)}
          onConfirm={(_reason, ids) => runBulk('closed', () => closePurchaseOrders(ids))} />
      )}
      {bulk === 'reopen' && (
        <ReasonDialog title="Reopen purchase orders" verb={`Reopen ${reopenItems.filter((i) => i.eligible).length} PO${reopenItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={reopenItems} busy={busy}
          note="Each PO's status is recomputed from its lines (received, partial or open). The QuickBooks purchase order is not touched."
          onCancel={() => setBulk(null)}
          onConfirm={(reason, ids) => runBulk('reopened', () => reopenDocs('purchase_order', ids, reason))} />
      )}
      {bulk === 'edit' && (
        <BulkEditDialog title="Edit purchase orders" count={sel.selected.length} busy={busy}
          fields={[{ key: 'expected_date', label: 'Expected date', type: 'date' }, { key: 'notes', label: 'Notes', type: 'textarea' }]}
          onCancel={() => setBulk(null)}
          onConfirm={(patch) => runBulk('edited', () => updateDocs('purchase_order', sel.selected, patch))} />
      )}

      {openId && (
        <PoDetailModal
          poId={openId}
          po={(purchaseOrders ?? []).find((p) => p.id === openId) ?? null}
          itemLookup={itemLookup}
          locById={locById}
          onClose={() => setOpenId(null)}
          onChanged={() => { setOpenId(null); onChanged(); }}
          onOpenWo={onOpenWo}
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

function prefillLocationId(prefill: PoPrefillState | null): string {
  if (!prefill) return '';
  const ids = Array.from(new Set(
    prefill.lines
      .map((line) => line.default_receiving_location_id)
      .filter((id): id is string => !!id),
  ));
  return ids.length === 1 ? ids[0] : '';
}

function CreatePoForm({
  vendors, locations, componentItems, itemLookup, prefill, lanes, onCancel, onCreated,
}: {
  vendors: QboVendor[];
  locations: InventoryLocation[];
  componentItems: { id: string; label: string }[];
  itemLookup: ProductionItemLookup;
  prefill: PoPrefillState | null;
  lanes: InventoryLane[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [vendorId, setVendorId] = useState('');
  const [locId, setLocId] = useState(() => prefillLocationId(prefill));
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
          New Purchase Order · {prefill?.inventory_lane ? INVENTORY_LANE_LABEL[prefill.inventory_lane] : describeLanes(lanes)}
        </div>
        <button onClick={onCancel} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
          <XIcon size={14} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginBottom: 12 }}>
        <LField label="Vendor">
          <SearchSelect value={vendorId} onChange={setVendorId} placeholder="Type a vendor…"
            options={vendors.map((v) => ({ id: v.qbo_vendor_id, label: v.display_name }))} />
        </LField>
        <LField label="Destination location">
          <SearchSelect value={locId} onChange={setLocId} placeholder="Type a location…"
            options={locations.map((l) => ({ id: l.id, label: `${l.code} — ${l.name}` }))} />
        </LField>
        <LField label="Expected date">
          <input type="date" style={inp()} value={expected} onChange={(e) => setExpected(e.target.value)} />
        </LField>
      </div>

      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
        Lines
      </div>
      <PrintableTable>
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
                    <SearchSelect style={{ width: '100%' }} value={l.qbo_item_id} options={componentItems} placeholder="Type an item…"
                      onChange={(id) => {
                        const it = id ? itemLookup.byId.get(id) : null;
                        updateLine(i, {
                          qbo_item_id: id,
                          unit_cost: l.unit_cost || (it?.purchase_cost ? String(it.purchase_cost) : ''),
                        });
                      }} />
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
      </PrintableTable>

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
