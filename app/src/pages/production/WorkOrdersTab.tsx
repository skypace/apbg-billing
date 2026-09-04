import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Plus, X as XIcon, FileText, Check, Truck, Factory, PackageCheck, ShoppingCart, Scale, Mail, Tag } from 'lucide-react';
import {
  ProductBom, ProductBomLine, WorkOrderCosts, WorkOrderStatus, WorkOrderView,
  WorkOrderMaterial, WorkOrderEvent, WoAdvanceAction, WorkOrderLot,
  advanceWorkOrder, createWorkOrderPipeline, fetchBomLines,
  fetchWorkOrderCosts, fetchWorkOrderEvents, fetchWorkOrderMaterials, fetchWorkOrderLots,
  generateWoPurchaseOrders, setWoMaterialVendor, setWorkOrderLots, reopenWorkOrder,
} from '../../lib/production';
import {
  ProductFormula, FormulaIngredient, fetchFormulaIngredients, scaleFormulaBatch,
} from '../../lib/formulas';
import {
  BatchPlan, BomPreflight, ProductionItem, createProductionPo, fetchBatchPlan, fetchBomPreflight,
  fetchProductionItems,
} from '../../lib/rawMaterials';
import { componentOrderQty, componentUnitCost, componentVendorId, masterIndex } from '../../lib/componentSourcing';
import { openDocPdf } from '../../lib/productionDocs';
import { EmailDocModal } from './EmailDocModal';
import { QboVendor } from '../../lib/purchasing';
import { InventoryLocation } from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { fmtNum, fm } from '../../lib/formatters';
import { GRID_SX, GRID_DEFAULTS } from '../stock/stockStyles';
import type { ProductionItemLookup } from './ProductionPage';
import { RecordYieldDialog, ShipDialog, LotsDialog } from './WorkOrderDialogs';
import { Meta, Kv, LField, cellTh, cellTd } from './productionUi';
import { StatusBuckets } from '../../components/StatusBuckets';
import { BulkActionBar } from '../../components/BulkActionBar';
import { ReasonDialog } from '../../components/ReasonDialog';
import { BulkEditDialog } from '../../components/BulkEditDialog';
import { useGridSelection } from '../../lib/useGridSelection';
import { countBuckets, rowBucket, type Bucket } from '../../lib/lifecycleBuckets';
import { deleteDrafts, reopenDocs, summarizeBulk, updateDocs, voidDocs, type BulkResult } from '../../lib/bulkActions';

// ── Pipeline metadata ────────────────────────────────────────────────────

const PIPELINE: { status: WorkOrderStatus; label: string; short: string }[] = [
  { status: 'draft',          label: 'Draft',            short: 'Draft' },
  { status: 'ordered',        label: 'POs issued',       short: 'Ordered' },
  { status: 'at_copacker',    label: 'Materials at co-packer', short: 'At co-packer' },
  { status: 'in_production',  label: 'In production',    short: 'Producing' },
  { status: 'yield_recorded', label: 'Yield recorded',   short: 'Yield' },
  { status: 'in_transit',     label: 'Shipping to us',   short: 'In transit' },
  { status: 'received',       label: 'Received to inventory', short: 'Received' },
  { status: 'closed',         label: 'Closed',           short: 'Closed' },
];

const STATUS_COLOR: Record<string, string> = {
  draft:          'var(--mt)',
  ordered:        'var(--ac)',
  at_copacker:    'var(--ac)',
  in_production:  'var(--am)',
  yield_recorded: 'var(--am)',
  in_transit:     'var(--ac)',
  received:       'var(--gn)',
  closed:         'var(--gn)',
  void:           '#64748b',
  consumed:       '#64748b',
};

const STATUS_LABEL: Record<string, string> = Object.fromEntries(
  PIPELINE.map((s) => [s.status, s.short]),
);
STATUS_LABEL.void = 'Void';
STATUS_LABEL.consumed = 'Consumed (legacy)';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

interface Props {
  workOrders: WorkOrderView[] | null;
  boms: ProductBom[];
  formulas: ProductFormula[] | null;
  vendors: QboVendor[] | null;
  locations: InventoryLocation[];
  itemLookup: ProductionItemLookup;
  /** Open this work order's detail on mount / when it changes (a click-through from a production order). */
  initialWoId?: string | null;
  onChanged: () => void;
}

export function WorkOrdersTab({
  workOrders, boms, formulas, vendors, locations, itemLookup, initialWoId = null, onChanged,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(initialWoId);
  useEffect(() => { if (initialWoId) setOpenId(initialWoId); }, [initialWoId]);
  const toast = useToast();
  const [bucket, setBucket] = useState<Bucket>('open');
  const [stage, setStage] = useState<'all' | WorkOrderStatus>('all');
  const [bulk, setBulk] = useState<'void' | 'delete' | 'edit' | 'reopen' | null>(null);
  const [busy, setBusy] = useState(false);
  const sel = useGridSelection([bucket, stage]);

  const counts = useMemo(() => countBuckets('work_order', workOrders ?? []), [workOrders]);
  const filtered = useMemo(() => {
    const list = (workOrders ?? []).filter((w) => rowBucket('work_order', w) === bucket);
    return bucket === 'open' && stage !== 'all' ? list.filter((w) => w.status === stage) : list;
  }, [workOrders, bucket, stage]);
  const selectedRows = useMemo(
    () => filtered.filter((w) => sel.selected.includes(w.id)),
    [filtered, sel.selected], // eslint-disable-line react-hooks/exhaustive-deps
  );

  async function runBulk(verb: string, fn: () => Promise<BulkResult>) {
    setBusy(true);
    try {
      const r = await fn();
      (r.skipped.length ? toast.info : toast.success)(summarizeBulk(r, verb));
      setBulk(null); sel.clear(); onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }
  const VOIDABLE = ['draft', 'ordered', 'at_copacker'];
  const voidItems = selectedRows.map((w) => ({
    id: w.id, number: w.batch_code, eligible: VOIDABLE.includes(w.status) && !w.run_id,
    why: w.run_id ? `part of ${w.run_number ?? 'a production order'} — void the order`
      : w.status === 'void' ? 'already void'
      : ['closed', 'consumed'].includes(w.status) ? 'closed — nothing to void'
      : 'production has started — close it out instead',
  }));
  const reopenItems = selectedRows.map((w) => ({
    id: w.id, number: w.batch_code, eligible: w.status === 'closed', why: 'not closed',
  }));
  const deleteItems = selectedRows.map((w) => ({
    id: w.id, number: w.batch_code, eligible: w.status === 'draft' && !(Number(w.po_count ?? 0) > 0) && !w.run_id,
    why: w.run_id ? `part of ${w.run_number ?? 'a production order'} — remove it there` : w.status !== 'draft' ? 'not a draft — void it instead' : 'has purchase orders — void it instead',
  }));

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'batch_code', headerName: 'WO #', width: 140,
      renderCell: (p) => (
        <button onClick={() => setOpenId(String(p.row.id))} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontWeight: 600, padding: 0, fontSize: 12,
        }}>{String(p.value ?? '')}</button>
      ),
    },
    {
      field: 'status', headerName: 'Stage', width: 130,
      renderCell: (p) => {
        const v = String(p.value ?? '');
        const c = STATUS_COLOR[v] ?? 'var(--mt)';
        return <span style={{
          background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
          padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
        }}>{(STATUS_LABEL[v] ?? v).toUpperCase()}</span>;
      },
    },
    {
      field: 'run_number', headerName: 'Order', width: 130,
      renderCell: (p) => p.value
        ? <span title="Part of a production order — POs, shipping and void are managed there" style={{
            fontFamily: 'var(--ff-mono)', fontSize: 10.5, color: 'var(--ac)', border: '1px solid var(--bd)', borderRadius: 4, padding: '1px 6px',
          }}>{String(p.value)}</span>
        : <span style={{ color: 'var(--mt)' }}>—</span>,
    },
    { field: 'finished_item_name', headerName: 'Product', flex: 1, minWidth: 190,
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{String(p.value ?? p.row.finished_qbo_item_id)}</span> },
    { field: 'formula_name', headerName: 'Formula', width: 165,
      valueFormatter: (v) => v ? String(v) : '—' },
    { field: 'qty_to_produce', headerName: 'Qty ordered', width: 100, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v)) },
    {
      field: 'actual_yield_qty', headerName: 'Yield', width: 110, cellClassName: 'mn',
      renderCell: (p) => p.row.actual_yield_qty == null
        ? <span style={{ color: 'var(--mt)' }}>—</span>
        : <span>
            {fmtNum(Number(p.row.actual_yield_qty))}
            {p.row.yield_pct != null && (
              <span style={{ marginLeft: 5, fontSize: 10, color: Number(p.row.yield_pct) < 100 ? 'var(--am)' : 'var(--gn)' }}>
                {Number(p.row.yield_pct).toFixed(1)}%
              </span>
            )}
          </span>,
    },
    { field: 'copacker_vendor_name', headerName: 'Co-packer', width: 150,
      valueFormatter: (v) => v ? String(v) : '—' },
    {
      field: 'po_count', headerName: 'POs', width: 75, cellClassName: 'mn',
      renderCell: (p) => Number(p.value ?? 0) === 0
        ? <span style={{ color: 'var(--mt)' }}>—</span>
        : <span>{Number(p.value)}{Number(p.row.po_open_count) > 0 && <span style={{ color: 'var(--am)' }}> ({p.row.po_open_count} open)</span>}</span>,
    },
    { field: 'ship_bol_number', headerName: 'BOL', width: 130, cellClassName: 'mn',
      valueFormatter: (v) => v ? String(v) : '—' },
    { field: 'unit_cost', headerName: '$/unit', width: 90, cellClassName: 'mn',
      valueFormatter: (v) => v == null ? '—' : '$' + Number(v).toFixed(4) },
    { field: 'created_at', headerName: 'Created', width: 150,
      valueFormatter: (v) => v ? new Date(String(v)).toLocaleString() : '—' },
  ], []);

  const activeBoms = boms.filter((b) => b.is_active);
  const openWo = (workOrders ?? []).find((w) => w.id === openId) ?? null;

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <StatusBuckets kind="work_order" value={bucket} counts={counts} onChange={setBucket}>
            {bucket === 'open' && (
              <select value={stage} onChange={(e) => setStage(e.target.value as typeof stage)} style={inp()} aria-label="Stage">
                <option value="all">Every stage</option>
                {PIPELINE.filter((s) => !['draft', 'closed'].includes(s.status))
                  .map((s) => <option key={s.status} value={s.status}>{s.label}</option>)}
              </select>
            )}
          </StatusBuckets>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button onClick={() => setCreating(true)} style={btnPrimary()} disabled={activeBoms.length === 0}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> New Work Order
          </button>
        </div>
      </div>

      {activeBoms.length === 0 && (
        <div style={{
          padding: 10, marginBottom: 14,
          background: 'rgba(239,191,65,0.08)', border: '1px solid rgba(239,191,65,0.30)',
          borderRadius: 4, fontSize: 11, color: 'var(--am)',
        }}>
          No active BOMs. Create one in the <strong>Bills of Materials</strong> tab before launching a work order.
        </div>
      )}

      {creating && (
        <CreatePipelineForm
          boms={activeBoms}
          formulas={formulas ?? []}
          vendors={vendors ?? []}
          locations={locations}
          itemLookup={itemLookup}
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); onChanged(); }}
        />
      )}

      <div className="cd" style={{ padding: 0 }}>
        <DataGridPro
          rows={filtered}
          columns={columns}
          {...GRID_DEFAULTS}
          sx={GRID_SX}
          density="compact"
          loading={workOrders === null}
          initialState={{ sorting: { sortModel: [{ field: 'created_at', sort: 'desc' }] } }}
          {...sel.gridProps}
        />
      </div>

      <BulkActionBar count={sel.selected.length} noun="work order" onClear={sel.clear}>
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
        <ReasonDialog title="Void work orders" verb={`Void ${voidItems.filter((i) => i.eligible).length} work order${voidItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={voidItems} busy={busy}
          note="A voided work order voids its open purchase orders too (refused if one already carries receipts). Nothing is deleted — the reason stays on every row."
          onCancel={() => setBulk(null)}
          onConfirm={(reason, ids) => runBulk('voided', () => voidDocs('work_order', ids, reason))} />
      )}
      {bulk === 'delete' && (
        <ReasonDialog title="Delete draft work orders" verb={`Delete ${deleteItems.filter((i) => i.eligible).length} draft${deleteItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={deleteItems} needReason={false} busy={busy}
          note="Only a draft with no purchase orders can be deleted. This is permanent — anything further along is voided instead, which keeps the record."
          onCancel={() => setBulk(null)}
          onConfirm={(_reason, ids) => runBulk('deleted', () => deleteDrafts('work_order', ids))} />
      )}
      {bulk === 'reopen' && (
        <ReasonDialog title="Reopen work orders" verb={`Reopen ${reopenItems.filter((i) => i.eligible).length} work order${reopenItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={reopenItems} busy={busy}
          note="A closed run goes back to Received, so its receipt can be corrected and it can be closed again."
          onCancel={() => setBulk(null)}
          onConfirm={(reason, ids) => runBulk('reopened', () => reopenDocs('work_order', ids, reason))} />
      )}
      {bulk === 'edit' && (
        <BulkEditDialog title="Edit work orders" count={sel.selected.length} busy={busy}
          fields={[{ key: 'scheduled_date', label: 'Scheduled date', type: 'date' }, { key: 'notes', label: 'Notes', type: 'textarea' }]}
          onCancel={() => setBulk(null)}
          onConfirm={(patch) => runBulk('edited', () => updateDocs('work_order', sel.selected, patch))} />
      )}

      {openWo && (
        <PipelineDetailModal
          wo={openWo}
          formulas={formulas ?? []}
          vendors={vendors ?? []}
          onClose={() => setOpenId(null)}
          onChanged={() => { onChanged(); }}
        />
      )}
    </div>
  );
}

// ── Create form ──────────────────────────────────────────────────────────

function CreatePipelineForm({ boms, formulas, vendors, locations, itemLookup, onCancel, onCreated }: {
  boms: ProductBom[];
  formulas: ProductFormula[];
  vendors: QboVendor[];
  locations: InventoryLocation[];
  itemLookup: ProductionItemLookup;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [bomId, setBomId] = useState('');
  const [qty, setQty] = useState('');
  const [copackerVendor, setCopackerVendor] = useState('');
  const [copackerLoc, setCopackerLoc] = useState('');
  const [destLoc, setDestLoc] = useState('');
  const [batchGal, setBatchGal] = useState('');
  const [batchGalTouched, setBatchGalTouched] = useState(false);
  const [scheduled, setScheduled] = useState('');
  const [notes, setNotes] = useState('');
  const [bomLines, setBomLines] = useState<ProductBomLine[] | null>(null);
  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [preflight, setPreflight] = useState<BomPreflight | null>(null);
  const [masterItems, setMasterItems] = useState<ProductionItem[]>([]);
  const [saving, setSaving] = useState(false);

  const bom = boms.find((b) => b.id === bomId) ?? null;
  const formula = bom?.formula_id ? formulas.find((f) => f.id === bom.formula_id) ?? null : null;

  const copackerLocs = useMemo(
    () => [...locations].filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment')
      .sort((a, b) => (a.kind === 'co_packer' ? 0 : 1) - (b.kind === 'co_packer' ? 0 : 1) || a.code.localeCompare(b.code)),
    [locations],
  );
  const warehouses = useMemo(
    () => locations.filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment'),
    [locations],
  );

  useEffect(() => {
    let alive = true;
    setBomLines(null);
    if (bomId) {
      fetchBomLines(bomId).then((r) => alive && setBomLines(r)).catch(() => alive && setBomLines([]));
    }
    return () => { alive = false; };
  }, [bomId]);

  // Suggested batch gallons from the formula geometry: units × cans × oz ÷ 128.
  useEffect(() => {
    if (batchGalTouched || !bom || !(Number(qty) > 0)) return;
    const gal = Number(qty) * Number(bom.cans_per_case || 24) * Number(bom.oz_per_can || 12) / 128;
    setBatchGal(gal > 0 ? String(Math.round(gal * 100) / 100) : '');
  }, [qty, bom, batchGalTouched]);

  // Default the co-packer location when one exists.
  useEffect(() => {
    if (!copackerLoc) {
      const cp = copackerLocs.find((l) => l.kind === 'co_packer');
      if (cp) setCopackerLoc(cp.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copackerLocs]);

  // Tank / MOQ plan. Debounced because it re-runs on every keystroke in the
  // quantity box, and it is a round trip.
  useEffect(() => {
    const cases = Number(qty);
    if (!bomId || !(cases > 0)) { setPlan(null); return; }
    let alive = true;
    const h = setTimeout(() => {
      fetchBatchPlan(bomId, cases)
        .then((p) => { if (alive) setPlan(p); })
        .catch(() => { if (alive) setPlan(null); });
    }, 250);
    return () => { alive = false; clearTimeout(h); };
  }, [bomId, qty]);

  // The Materials & Pricing master — the vendor and price for any component
  // whose BOM line does not override them.
  useEffect(() => {
    let alive = true;
    fetchProductionItems().then((r) => { if (alive) setMasterItems(r); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  // Which vendors this run will raise a PO for, and anything that would stop
  // one reaching QuickBooks. Not debounced -- it depends on the BOM, not the
  // quantity, so it runs once when the flavour is picked.
  useEffect(() => {
    if (!bomId) { setPreflight(null); return; }
    let alive = true;
    fetchBomPreflight(bomId)
      .then((p) => { if (alive) setPreflight(p); })
      .catch(() => { if (alive) setPreflight(null); });
    return () => { alive = false; };
  }, [bomId]);

  // What the server will snapshot onto the work order. Three rules have to match
  // fn_wo_create_pipeline exactly or this preview quietly disagrees with the POs
  // it is previewing: stocked components only, per_run is a flat charge, and the
  // vendor and price fall back to the Materials & Pricing master.
  const masters = useMemo(() => masterIndex(masterItems), [masterItems]);
  const materialsPreview = useMemo(() => {
    if (!bomLines || !(Number(qty) > 0)) return [];
    return bomLines
      // A recipe line has no item of its own and never becomes a PO line — it
      // rides under the flavour's gallon as detail. It also has no name here, so
      // including it renders a row of question marks.
      .filter((l) => l.line_type === 'component' && l.component_qbo_item_id)
      .map((l) => {
        const item = itemLookup.byId.get(l.component_qbo_item_id ?? '');
        const oq = componentOrderQty(l, Number(qty), masters);
        const required = oq.ordered;
        const cost = componentUnitCost(l, masters, item?.purchase_cost ?? null);
        const vendorId = componentVendorId(l, masters);
        const vendor = vendors.find((v) => v.qbo_vendor_id === vendorId);
        return {
          id: l.id,
          label: item?.item_name ?? l.component_qbo_item_id ?? '?',
          required, demand: oq.demand, surplus: oq.surplus, liftReason: oq.reason, uom: l.qty_uom || 'each',
          cost, ext: cost != null ? required * Number(cost) : null,
          vendor: vendor?.display_name ?? vendorId,
        };
      });
  }, [bomLines, qty, itemLookup, vendors, masters]);
  const previewTotal = materialsPreview.reduce((s, m) => s + (m.ext ?? 0), 0);
  const missingVendorCount = materialsPreview.filter((m) => !m.vendor).length;

  const canSave = !!bomId && Number(qty) > 0 && !!copackerLoc && !!destLoc;

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      await createWorkOrderPipeline({
        bom_id: bomId,
        qty_to_produce: Number(qty),
        copacker_qbo_vendor_id: copackerVendor || null,
        copacker_location_id: copackerLoc,
        destination_location_id: destLoc,
        scheduled_date: scheduled || null,
        batch_size_gal: batchGal ? Number(batchGal) : null,
        notes: notes || null,
      });
      toast.success('Work order created — materials calculated');
      onCreated();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="cd" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
          New Work Order — how many finished units do we want made?
        </div>
        <button onClick={onCancel} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
          <XIcon size={14} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        <LField label="BOM (sellable item)">
          <select style={inp()} value={bomId} onChange={(e) => setBomId(e.target.value)}>
            <option value="">—</option>
            {boms.map((b) => {
              const it = itemLookup.byId.get(b.finished_qbo_item_id);
              return <option key={b.id} value={b.id}>
                {it?.item_name ?? b.finished_qbo_item_id}{b.name ? ` · ${b.name}` : ''} · v{b.version}
              </option>;
            })}
          </select>
        </LField>
        <LField label="Qty to make (finished units)">
          <input type="number" min={1} step="any" style={inp()} value={qty} onChange={(e) => setQty(e.target.value)} />
        </LField>
        <LField label="Batch size (gal) — from formula">
          <input type="number" min={0} step="any" style={inp()} value={batchGal}
            onChange={(e) => { setBatchGal(e.target.value); setBatchGalTouched(true); }} />
        </LField>
        <LField label="Co-packer (vendor)">
          <select style={inp()} value={copackerVendor} onChange={(e) => setCopackerVendor(e.target.value)}>
            <option value="">—</option>
            {vendors.map((v) => <option key={v.qbo_vendor_id} value={v.qbo_vendor_id}>{v.display_name}</option>)}
          </select>
        </LField>
        <LField label="Co-packer location (materials ship here)">
          <select style={inp()} value={copackerLoc} onChange={(e) => setCopackerLoc(e.target.value)}>
            <option value="">—</option>
            {copackerLocs.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
          </select>
        </LField>
        <LField label="Receive finished goods at">
          <select style={inp()} value={destLoc} onChange={(e) => setDestLoc(e.target.value)}>
            <option value="">—</option>
            {warehouses.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
          </select>
        </LField>
        <LField label="Scheduled date">
          <input type="date" style={inp()} value={scheduled} onChange={(e) => setScheduled(e.target.value)} />
        </LField>
      </div>

      {formula && (
        <div style={{
          marginTop: 12, padding: 10, fontSize: 11,
          background: 'rgba(91,181,240,0.05)', border: '1px solid var(--bd)', borderRadius: 4, color: 'var(--mt)',
        }}>
          Formula: <strong style={{ color: 'var(--tx)' }}>{formula.name}</strong> rev {formula.doc_rev}
          {formula.density_lbs_per_gal != null && <> · density {formula.density_lbs_per_gal} lbs/gal</>}
          {Number(batchGal) > 0 && formula.density_lbs_per_gal != null && (
            <> · batch weight ≈ <strong style={{ color: 'var(--tx)' }}>
              {(Number(batchGal) * Number(formula.density_lbs_per_gal)).toLocaleString(undefined, { maximumFractionDigits: 0 })} lbs
            </strong></>
          )}
        </div>
      )}
      {bom && !formula && (
        <div style={{
          marginTop: 12, padding: 10, fontSize: 11,
          background: 'rgba(239,191,65,0.08)', border: '1px solid rgba(239,191,65,0.30)', borderRadius: 4, color: 'var(--am)',
        }}>
          This BOM has no formula / spec sheet linked. Link one in the BOMs tab so the batching sheet can drive production.
        </div>
      )}

      {preflight && (
        <div style={{
          marginTop: 12, padding: 10, border: '1px solid var(--bd)', borderRadius: 5,
          background: 'rgba(255,255,255,0.02)', fontSize: 11, lineHeight: 1.7,
        }}>
          <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
            This run raises {preflight.po_count} purchase order{preflight.po_count === 1 ? '' : 's'}
          </div>
          {preflight.vendors.map((v) => (
            <div key={v.qbo_vendor_id ?? 'none'}>
              <strong style={{ color: v.qbo_vendor_id ? 'var(--tx)' : 'var(--am)' }}>{v.vendor_name}</strong>
              <span style={{ color: 'var(--mt)' }}> — {v.items.join(' · ')}</span>
            </div>
          ))}
          {preflight.blockers.length > 0 && (
            <div style={{
              marginTop: 7, padding: 8, borderRadius: 4,
              background: 'rgba(245,158,11,0.10)', border: '1px solid var(--am)',
            }}>
              <strong style={{ color: 'var(--am)' }}>
                Fix before pushing to QuickBooks
              </strong>
              {preflight.blockers.map((b) => (
                <div key={b.qbo_item_id} style={{ marginTop: 3, color: 'var(--mt)' }}>
                  <span style={{ color: 'var(--tx)' }}>{b.item_name}</span> — {b.detail}
                </div>
              ))}
            </div>
          )}
          {(preflight.warnings ?? []).length > 0 && (
            <div style={{
              marginTop: 7, padding: 8, borderRadius: 4,
              background: 'rgba(255,255,255,0.03)', border: '1px dashed var(--bd)',
            }}>
              <strong style={{ color: 'var(--tx)' }}>Worth a look — this will still post</strong>
              {preflight.warnings.map((w) => (
                <div key={w.qbo_item_id} style={{ marginTop: 3, color: 'var(--mt)' }}>
                  <span style={{ color: 'var(--tx)' }}>{w.item_name}</span> — {w.detail}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {plan && (
        <div style={{
          marginTop: 12, padding: 12, border: '1px solid var(--bd)', borderRadius: 5,
          background: 'rgba(255,255,255,0.02)',
        }}>
          <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 }}>
            Batch plan — filling the tank
          </div>
          <div style={{ fontSize: 12, marginBottom: 10, lineHeight: 1.7 }}>
            {fmtNum(plan.cases_requested)} cases × {plan.gal_per_case} gal ={' '}
            <strong>{fmtNum(plan.finished_gal)} gal</strong> of finished soda
            {plan.yield_pct < 1 && (
              <> — at a {(plan.yield_pct * 100).toFixed(1)}% yield that means{' '}
              <strong>{fmtNum(plan.gal_to_batch)} gal</strong> into the tank</>
            )}.
            {plan.dilution_ratio > 0 && (
              <div style={{ color: 'var(--mt)' }}>
                The tank is finished product — the co-packer dilutes and carbonates. At{' '}
                {plan.dilution_ratio}:1 that run needs{' '}
                <strong style={{ color: 'var(--tx)' }}>{fmtNum(plan.concentrate_gal)} gal of concentrate</strong>{' '}
                delivered, which is what the ingredient purchase order orders.
              </div>
            )}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                <th style={cellTh}>Tank</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>A full tank makes</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>Add to fill it</th>
                <th style={cellTh}></th>
              </tr>
            </thead>
            <tbody>
              {plan.tanks.map((tk) => (
                <tr key={tk.tank_gal} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={cellTd}>
                    <strong>{fmtNum(tk.tank_gal)} gal</strong>
                    {plan.recommended_tank === tk.tank_gal && (
                      <span style={{
                        marginLeft: 8, fontSize: 9, fontWeight: 700, color: 'var(--gn)',
                        border: '1px solid var(--gn)', borderRadius: 12, padding: '1px 7px',
                      }}>SMALLEST THAT HOLDS THIS RUN</span>
                    )}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                    {fmtNum(tk.cases_from_tank)} cases
                    {plan.dilution_ratio > 0 && (
                      <div style={{ color: 'var(--mt)', fontSize: 10 }}>
                        {fmtNum(tk.concentrate_gal)} gal conc.
                      </div>
                    )}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                    {tk.fits && tk.extra_cases > 0
                      ? (
                        <button
                          onClick={() => setQty(String(tk.cases_from_tank))}
                          style={{
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            color: 'var(--ac)', fontWeight: 700, fontFamily: 'var(--ff-mono)', padding: 0,
                          }}
                          title={'Set the order to ' + tk.cases_from_tank + ' cases'}
                        >+{fmtNum(tk.extra_cases)}</button>
                      )
                      : <span style={{ color: 'var(--mt)' }}>—</span>}
                  </td>
                  <td style={{ ...cellTd, color: 'var(--mt)', fontSize: 11 }}>
                    {tk.fits
                      ? fmtNum(tk.unused_gal) + ' gal of capacity unused as ordered'
                      : 'too small — over by ' + fmtNum(tk.over_by_gal) + ' gal'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8, fontSize: 10, color: 'var(--mt)', lineHeight: 1.6 }}>
            Tank sizes come from the formula, so a flavour that cannot run in a given tank simply does not
            list it. Clicking a <span style={{ color: 'var(--ac)' }}>+n</span> sets the order to a full tank.
          </div>
        </div>
      )}

      {materialsPreview.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
            Materials that will be calculated onto this work order
            {missingVendorCount > 0 && (
              <span style={{ color: 'var(--am)', textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>
                {missingVendorCount} without a vendor — set one under Materials &amp; Pricing, or on the BOM, before generating POs
              </span>
            )}
          </div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginBottom: 6 }}>
            <strong>Needed</strong> is what the batch uses. <strong>Ordered</strong> is what the purchase order will carry once the
            vendor's MOQ and order multiple (Materials &amp; Pricing) are applied; a <span style={{ color: 'var(--am)' }}>+n</span> is
            the surplus, which lands at the co-packer as stock for the next run and is not charged to this batch.
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                <th style={cellTh}>Sub-item</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>Needed</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>Ordered</th>
                <th style={cellTh}>Vendor</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>Est unit $</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>Est ext $</th>
              </tr>
            </thead>
            <tbody>
              {materialsPreview.map((m) => (
                <tr key={m.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={cellTd}><strong>{m.label}</strong></td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                    {fmtNum(m.demand)} {m.uom}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                    {fmtNum(m.required)}
                    {m.surplus > 0 && (
                      <span style={{ color: 'var(--am)', marginLeft: 6, fontSize: 10 }}
                        title={m.liftReason === 'moq' ? 'Lifted to the vendor\'s minimum order' : 'Rounded up to the order multiple'}>
                        +{fmtNum(m.surplus)} {m.liftReason === 'moq' ? 'MOQ' : 'pack'}
                      </span>
                    )}
                  </td>
                  <td style={cellTd}>{m.vendor ?? <span style={{ color: 'var(--am)' }}>unassigned</span>}</td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                    {m.cost == null ? '—' : '$' + Number(m.cost).toFixed(4)}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                    {m.ext == null ? '—' : fm(m.ext)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} style={{ ...cellTd, textAlign: 'right', fontWeight: 700 }}>Estimated materials</td>
                <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', fontWeight: 700 }}>{fm(previewTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <LField label="Notes">
          <textarea rows={2} style={{ ...inp(), width: '100%', resize: 'vertical', minHeight: 36 }}
            value={notes} onChange={(e) => setNotes(e.target.value)} />
        </LField>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button onClick={onCancel} style={btnSecondary()}>Cancel</button>
        <button onClick={submit} disabled={!canSave || saving} style={btnPrimary()}>
          {saving ? 'Creating…' : 'Create work order'}
        </button>
      </div>
    </div>
  );
}

// ── Detail modal (pipeline) ──────────────────────────────────────────────

type ActionDialog = 'record_yield' | 'ship' | 'lots' | null;

function PipelineDetailModal({ wo, formulas, vendors, onClose, onChanged }: {
  wo: WorkOrderView;
  formulas: ProductFormula[];
  vendors: QboVendor[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [materials, setMaterials] = useState<WorkOrderMaterial[] | null>(null);
  const [events, setEvents] = useState<WorkOrderEvent[] | null>(null);
  const [costs, setCosts] = useState<WorkOrderCosts | null>(null);
  const [ingredients, setIngredients] = useState<FormulaIngredient[] | null>(null);
  const [lots, setLots] = useState<WorkOrderLot[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<ActionDialog>(null);
  const [voidAsk, setVoidAsk] = useState(false);
  const [reopenAsk, setReopenAsk] = useState(false);

  const formula = wo.formula_id ? formulas.find((f) => f.id === wo.formula_id) ?? null : null;

  function reload() {
    fetchWorkOrderMaterials(wo.id).then(setMaterials).catch(() => setMaterials([]));
    fetchWorkOrderEvents(wo.id).then(setEvents).catch(() => setEvents([]));
    fetchWorkOrderCosts(wo.id).then(setCosts).catch(() => setCosts(null));
    fetchWorkOrderLots(wo.id).then(setLots).catch(() => setLots([]));
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wo.id, wo.status]);
  useEffect(() => {
    let alive = true;
    if (formula) {
      fetchFormulaIngredients(formula.id).then((r) => alive && setIngredients(r)).catch(() => alive && setIngredients([]));
    }
    return () => { alive = false; };
  }, [formula?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const stageIdx = PIPELINE.findIndex((s) => s.status === wo.status);

  async function run(label: string, fn: () => Promise<unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    try {
      await fn();
      toast.success(label);
      onChanged();
      reload();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  const doGeneratePos = () => run('Purchase orders generated', async () => {
    const res = await generateWoPurchaseOrders(wo.id);
    toast.info(res.pos.map((p) => p.po_number).join(', ') + ' created'
      + (res.recipe_detail.attached
        ? ' · ' + res.recipe_detail.attached + ' ingredient line'
          + (res.recipe_detail.attached === 1 ? '' : 's') + ' filed under the gallon'
        : ''));
    for (const o of res.recipe_detail.orphans) toast.error(o.reason);
  }, `Generate purchase orders for ${wo.batch_code}?\n\nOne PO per vendor will be created for the total of every sub-item, shipping to ${wo.copacker_location_label ?? 'the co-packer'}.`);

  // The other end of the run: the finished cases coming back IN from ALAMEDA
  // SODA COMPANY PRODUCTION, priced at the cost the material POs and the
  // co-pack fee actually came to. The RPC refuses before a yield is recorded —
  // until then there is no measured per-case cost, only an estimate nobody
  // weighed — and refuses a second one, so no client-side guard is needed.
  const [emailSheet, setEmailSheet] = useState(false);

  const doCreateProductionPo = () => run('Production PO created', async () => {
    const res = await createProductionPo(wo.id);
    toast.info('Production PO ' + res.po_number + ' — ' + fmtNum(res.qty)
      + ' cases at ' + fm(res.unit_cost) + ' each · ' + fm(res.subtotal));
  }, 'Create the purchase order for the finished cases from ALAMEDA SODA COMPANY PRODUCTION?'
   + '\n\nIt is priced at the per-case cost this work order measured, and pushing it from the '
   + 'Purchase Orders tab is what puts a real cost per case into QuickBooks.');

  const advance = (action: WoAdvanceAction, label: string, payload: Record<string, unknown> = {}, confirmText?: string) =>
    run(label, () => advanceWorkOrder(wo.id, action, payload), confirmText);

  const materialsMissingVendor = (materials ?? []).filter((m) => !m.qbo_vendor_id && !m.po_id).length;
  const canEditLots = ['in_production', 'yield_recorded'].includes(wo.status);
  const batchGal = Number(wo.batch_size_gal ?? 0);
  const batchLines = formula && ingredients && batchGal > 0
    ? scaleFormulaBatch(formula, ingredients, batchGal)
    : [];

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
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
              Work Order · {(STATUS_LABEL[wo.status] ?? wo.status).toUpperCase()}
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 22, fontFamily: 'var(--ff-mono)', color: 'var(--ac)' }}>
              {wo.batch_code}
            </h2>
            <div style={{ marginTop: 4, color: 'var(--tx)', fontSize: 13 }}>
              {wo.finished_item_name ?? wo.finished_qbo_item_id}
              {formula && <span style={{ color: 'var(--mt)' }}> · formula {formula.name} rev {formula.doc_rev}</span>}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
            <XIcon size={18} />
          </button>
        </div>

        {/* Pipeline stepper */}
        {wo.status !== 'void' && wo.status !== 'consumed' && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
            {PIPELINE.map((s, i) => {
              const done = stageIdx > i || wo.status === 'closed';
              const current = stageIdx === i && wo.status !== 'closed';
              const c = done ? 'var(--gn)' : current ? 'var(--ac)' : 'var(--bd)';
              return (
                <div key={s.status} style={{
                  flex: 1, minWidth: 88, padding: '6px 8px', borderRadius: 4,
                  border: `1px solid ${c}`,
                  background: current ? 'rgba(91,181,240,0.10)' : done ? 'rgba(125,238,164,0.05)' : 'transparent',
                }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
                    color: done ? 'var(--gn)' : current ? 'var(--ac)' : 'var(--mt)' }}>
                    {done && <Check size={9} style={{ verticalAlign: -1, marginRight: 3 }} />}{s.label}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--mt)', marginTop: 2 }}>
                    {stageTimestamp(wo, s.status) ?? (current ? 'now' : '—')}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {wo.run_id && (
          <div style={{ marginBottom: 12, padding: 8, fontSize: 11, border: '1px solid var(--bd)', borderRadius: 4, background: 'rgba(91,181,240,0.05)' }}>
            Part of production order <strong style={{ fontFamily: 'var(--ff-mono)', color: 'var(--ac)' }}>{wo.run_number ?? wo.run_id}</strong>.
            Purchase orders, materials-at-co-packer, start, shipping (one BOL for the truck), receipt, close and void are done on the <strong>Production Orders</strong> tab for every flavour together; yield and lots are recorded here or there, per flavour.
          </div>
        )}
        {/* Meta */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, fontSize: 12, marginBottom: 14 }}>
          <Meta label="Qty ordered" value={`${fmtNum(Number(wo.qty_to_produce))} units`} />
          <Meta label="Actual yield" value={wo.actual_yield_qty == null ? '—'
            : `${fmtNum(Number(wo.actual_yield_qty))} units${wo.yield_pct != null ? ` (${Number(wo.yield_pct).toFixed(1)}%)` : ''}`} />
          <Meta label="Batch size" value={batchGal > 0 ? `${fmtNum(batchGal)} gal` : '—'} />
          <Meta label="Co-packer" value={wo.copacker_vendor_name ?? wo.copacker_location_label ?? '—'} />
          <Meta label="Materials ship to" value={wo.copacker_location_label ?? '—'} />
          <Meta label="Finished goods to" value={wo.destination_location_label ?? '—'} />
          <Meta label="Shipping" value={wo.ship_bol_number
            ? `BOL ${wo.ship_bol_number}${wo.ship_carrier ? ` · ${wo.ship_carrier}` : ''}${wo.ship_tracking ? ` · ${wo.ship_tracking}` : ''}`
            : '—'} />
          <Meta label="Scheduled" value={wo.scheduled_date ?? '—'} />
        </div>

        {/* Lots — the co-packer's lot codes and born-on dates, for QC and the BOL */}
        {(canEditLots || (lots && lots.length > 0)) && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
                <Tag size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                Lots from the co-packer — lot code · born on · best by (one BOL line per lot)
              </div>
              {canEditLots && (
                <button disabled={busy} style={btnSecondary()} onClick={() => setDialog('lots')}>
                  {lots && lots.length ? 'Edit lots' : 'Enter lots'}
                </button>
              )}
            </div>
            {lots && lots.length > 0 ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--bd)', color: 'var(--mt)', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Lot</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Born on</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Best by</th>
                    <th style={{ textAlign: 'right', padding: '4px 6px' }}>Cases</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {lots.map((l) => (
                    <tr key={l.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ padding: '4px 6px', fontFamily: 'var(--ff-mono)', fontWeight: 600 }}>{l.lot_code}</td>
                      <td style={{ padding: '4px 6px' }}>{l.born_on_date ?? '—'}</td>
                      <td style={{ padding: '4px 6px' }}>{l.best_by_date ?? '—'}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(l.qty))}</td>
                      <td style={{ padding: '4px 6px', color: 'var(--mt)' }}>{l.notes ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--mt)' }}>
                No lots recorded yet. Enter them with the yield, or before shipping — the finished-goods BOL prints one line per lot so the dock and a recall can both read which cases came from which batch.
              </div>
            )}
          </div>
        )}

        {/* Materials — the calc lives here, listed out per vendor */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
            <ShoppingCart size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
            Materials on this work order (totals for {fmtNum(Number(wo.qty_to_produce))} units, by vendor)
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                <th style={cellTh}>Sub-item</th>
                <th style={{ ...cellTh, textAlign: 'right' }} title="What the batch uses — consumed at start of production and costed into the run">Needed</th>
                <th style={{ ...cellTh, textAlign: 'right' }} title="What the purchase order carries — MOQ and order multiple applied; the surplus stays at the co-packer">Ordered</th>
                <th style={cellTh}>Vendor</th>
                <th style={cellTh}>PO</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>Est unit $</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>Est ext $</th>
              </tr>
            </thead>
            <tbody>
              {(materials ?? []).map((m) => (
                <tr key={m.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={cellTd}><strong>{m.item_name ?? m.component_qbo_item_id}</strong></td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                    {fmtNum(Number(m.demand_qty ?? m.required_qty))} {m.uom}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                    {fmtNum(Number(m.required_qty))}
                    {m.demand_qty != null && Number(m.required_qty) - Number(m.demand_qty) > 0.000001 && (
                      <span style={{ color: 'var(--am)', marginLeft: 6, fontSize: 10 }} title="Surplus — lands at the co-packer as stock for the next run">
                        +{fmtNum(Number(m.required_qty) - Number(m.demand_qty))}
                      </span>
                    )}
                  </td>
                  <td style={cellTd}>
                    {m.po_id
                      ? (m.vendor_name ?? m.qbo_vendor_id)
                      : ['draft', 'ordered'].includes(wo.status)
                        ? <select style={{ ...inp(), fontSize: 11, padding: '2px 6px' }} value={m.qbo_vendor_id ?? ''}
                            onChange={(e) => run('Vendor updated', () => setWoMaterialVendor(m.id, e.target.value || null))}>
                            <option value="">— vendor —</option>
                            {vendors.map((v) => <option key={v.qbo_vendor_id} value={v.qbo_vendor_id}>{v.display_name}</option>)}
                          </select>
                        : (m.vendor_name ?? <span style={{ color: 'var(--mt)' }}>—</span>)}
                  </td>
                  <td style={{ ...cellTd, fontFamily: 'var(--ff-mono)', fontSize: 10.5 }}>
                    {m.po_id
                      ? <span style={{ color: 'var(--gn)' }}>✓ on PO</span>
                      : <span style={{ color: 'var(--mt)' }}>—</span>}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                    {m.unit_cost_est == null ? '—' : '$' + Number(m.unit_cost_est).toFixed(4)}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                    {m.unit_cost_est == null ? '—' : fm(Number(m.required_qty) * Number(m.unit_cost_est))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {wo.po_count != null && wo.po_count > 0 && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--mt)' }}>
              {wo.po_count} purchase order{wo.po_count === 1 ? '' : 's'} linked
              {Number(wo.po_open_count) > 0 && <> · {wo.po_open_count} still open — receive them in the Purchase Orders tab as materials arrive at the co-packer</>}
            </div>
          )}
        </div>

        {/* Batching sheet from the formula */}
        {formula && batchLines.length > 0 && (
          <div style={{ marginBottom: 14, padding: 12, background: 'rgba(91,181,240,0.04)', border: '1px solid var(--bd)', borderRadius: 4 }}>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
              <Scale size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
              Batching sheet · {formula.name} rev {formula.doc_rev} @ {fmtNum(batchGal)} gal
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <tbody>
                {batchLines.map((b, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={cellTd}>{b.ingredient_name}</td>
                    <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                      {(b.pct_by_weight * 100).toFixed(4)}%
                    </td>
                    <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                      {b.target_weight_lbs.toLocaleString(undefined, { maximumFractionDigits: 2 })} {b.uom}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {Object.keys(formula.qc_specs ?? {}).length > 0 && (
              <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--mt)' }}>
                QC: {Object.entries(formula.qc_specs).map(([k, v]) => `${k} ${v}`).join(' · ')}
              </div>
            )}
          </div>
        )}

        {/* Cost snapshot */}
        {costs && (
          <div style={{
            marginBottom: 14, padding: 12,
            background: 'rgba(125,238,164,0.06)', border: '1px solid rgba(125,238,164,0.20)', borderRadius: 4,
          }}>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 }}>
              Cost rollup · computed on the work order · {new Date(costs.computed_at).toLocaleString()}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 13 }}>
              <Kv label="Materials" value={fm(Number(costs.components_cost))} />
              <Kv label="Services + fees" value={fm(Number(costs.services_cost))} />
              <Kv label="Total" value={fm(Number(costs.total_cost))} bold />
              <Kv label="Unit cost" value={costs.unit_cost == null ? '—' : '$' + Number(costs.unit_cost).toFixed(4)} bold accent />
            </div>
            {(costs.per_can != null || costs.per_oz != null || costs.per_gal_finished != null) && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 12, marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--bd)' }}>
                {costs.per_case != null && <Kv label="$ / case" value={'$' + Number(costs.per_case).toFixed(4)} />}
                {costs.per_can != null && <Kv label="$ / can" value={'$' + Number(costs.per_can).toFixed(4)} />}
                {costs.per_oz != null && <Kv label="$ / oz" value={'$' + Number(costs.per_oz).toFixed(5)} />}
                {costs.per_gal_finished != null && <Kv label="$ / gal" value={'$' + Number(costs.per_gal_finished).toFixed(4)} />}
              </div>
            )}
            {costs.actual_yield_pct != null && (
              <div style={{ marginTop: 8, fontSize: 11, color: Number(costs.actual_yield_pct) < 100 ? 'var(--am)' : 'var(--gn)' }}>
                Yield: <strong>{Number(costs.actual_yield_pct).toFixed(1)}%</strong>
                {Number(costs.yield_loss_dollars ?? 0) > 0 && (
                  <> · missed-yield loss: <strong>${Number(costs.yield_loss_dollars).toFixed(2)}</strong></>
                )}
              </div>
            )}
          </div>
        )}

        {/* Events */}
        {(events ?? []).length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
              Timeline
            </div>
            {(events ?? []).map((e) => (
              <div key={e.id} style={{ display: 'flex', gap: 10, fontSize: 11, padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                <span style={{ color: 'var(--mt)', fontFamily: 'var(--ff-mono)', whiteSpace: 'nowrap' }}>
                  {new Date(e.created_at).toLocaleString()}
                </span>
                <span>{e.note ?? e.event_type}</span>
              </div>
            ))}
          </div>
        )}

        {wo.notes && (
          <div style={{ marginBottom: 12, fontSize: 11, color: 'var(--mt)' }}>
            <div style={{ fontSize: 9, letterSpacing: 0.6, textTransform: 'uppercase' }}>Notes</div>
            {wo.notes}
          </div>
        )}

        {/* Inline action dialogs */}
        {dialog === 'record_yield' && (
          <RecordYieldDialog wo={wo} busy={busy}
            onCancel={() => setDialog(null)}
            onSubmit={(payload) => { setDialog(null); void advance('record_yield', 'Yield recorded — costs locked', payload); }} />
        )}
        {dialog === 'ship' && (
          <ShipDialog wo={wo} busy={busy} lots={lots ?? []}
            onCancel={() => setDialog(null)}
            onSubmit={(payload) => { setDialog(null); void advance('ship', 'Shipping record created', payload); }} />
        )}
        {dialog === 'lots' && (
          <LotsDialog wo={wo} busy={busy} lots={lots ?? []}
            onCancel={() => setDialog(null)}
            onSubmit={(payload) => { setDialog(null); void run('Lots recorded', () => setWorkOrderLots(wo.id, payload)); }} />
        )}

        {/* Actions */}
        {voidAsk && (
          <ReasonDialog title={'Void ' + wo.batch_code} verb="Void work order"
            items={[{ id: wo.id, number: wo.batch_code, eligible: true }]} busy={busy}
            note="Open purchase orders without receipts are voided with it. Nothing is deleted."
            onCancel={() => setVoidAsk(false)}
            onConfirm={(reason) => { setVoidAsk(false); void advance('void', 'Work order voided', { reason }); }} />
        )}
        {reopenAsk && (
          <ReasonDialog title={'Reopen ' + wo.batch_code} verb="Reopen work order"
            items={[{ id: wo.id, number: wo.batch_code, eligible: true }]} busy={busy}
            note="The run goes back to Received. Its costs and lots stay as recorded; close it again when the correction is made."
            onCancel={() => setReopenAsk(false)}
            onConfirm={(reason) => { setReopenAsk(false); void run('Work order reopened — back to Received', () => reopenWorkOrder(wo.id, reason).then(() => undefined)); }} />
        )}
        {emailSheet && (
          <EmailDocModal ref={{ kind: 'batch_sheet', wo_id: wo.id }}
            title={'batching sheet · ' + wo.batch_code} onClose={() => setEmailSheet(false)} />
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button disabled={busy} style={btnSecondary()} title="Batching sheet PDF sized to this run"
            onClick={() => openDocPdf({ kind: 'batch_sheet', wo_id: wo.id }).catch((e) => toast.error(errMsg(e)))}>
            <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Batching sheet
          </button>
          <button disabled={busy} style={btnSecondary()} title="Email the batching sheet to the co-packer" onClick={() => setEmailSheet(true)}>
            <Mail size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Email sheet…
          </button>
          {['draft', 'ordered', 'at_copacker'].includes(wo.status) && !wo.run_id && (
            <button disabled={busy} style={btnDanger()} onClick={() => setVoidAsk(true)}>Void</button>
          )}
          {wo.status === 'closed' && (
            <button disabled={busy} style={btnSecondary()} onClick={() => setReopenAsk(true)} title="Back to Received so the receipt can be corrected">Reopen</button>
          )}
          {['draft', 'ordered'].includes(wo.status) && !wo.run_id && (
            <button disabled={busy || materialsMissingVendor > 0} style={btnPrimary()} onClick={doGeneratePos}
              title={materialsMissingVendor > 0 ? 'Assign a vendor to every material first' : 'One PO per vendor for all sub-items'}>
              <ShoppingCart size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
              Generate POs per vendor →
            </button>
          )}
          {wo.status === 'ordered' && !wo.run_id && (
            <button disabled={busy} style={btnSecondary()} onClick={() =>
              advance('materials_at_copacker', 'Marked at co-packer', {},
                'Mark raw materials as arrived at the co-packer? (Receive the POs in the Purchase Orders tab to keep on-hand accurate.)')}>
              <Truck size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Materials at co-packer
            </button>
          )}
          {['ordered', 'at_copacker'].includes(wo.status) && !wo.run_id && (
            <button disabled={busy} style={btnPrimary()} onClick={() =>
              advance('start_production', 'Production started', {},
                `Start production for ${wo.batch_code}?\n\nThis consumes every material quantity from ${wo.copacker_location_label ?? 'the co-packer location'}.`)}>
              <Factory size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Start production →
            </button>
          )}
          {wo.status === 'in_production' && (
            <button disabled={busy} style={btnPrimary()} onClick={() => setDialog('record_yield')}>
              <Scale size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Record yield →
            </button>
          )}
          {wo.status === 'yield_recorded' && !wo.run_id && (
            <button disabled={busy} style={btnPrimary()} onClick={() => setDialog('ship')}>
              <Truck size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Create shipping record →
            </button>
          )}
          {['yield_recorded', 'in_transit', 'received', 'closed'].includes(wo.status) && !wo.run_id && (
            <button disabled={busy} style={btnSecondary()} onClick={doCreateProductionPo}>
              <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Create production PO →
            </button>
          )}
          {wo.status === 'in_transit' && !wo.run_id && (
            <button disabled={busy} style={btnPrimary()} onClick={() =>
              advance('receive', 'Finished goods received into inventory', {},
                `Receive ${fmtNum(Number(wo.qty_produced_actual ?? 0))} finished units into ${wo.destination_location_label ?? 'the warehouse'}?`)}>
              <PackageCheck size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Receive into inventory →
            </button>
          )}
          {wo.status === 'received' && !wo.run_id && (
            <button disabled={busy} style={btnPrimary()} onClick={() => advance('close', 'Work order closed')}>
              <Check size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Close work order
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function stageTimestamp(wo: WorkOrderView, status: WorkOrderStatus): string | null {
  const map: Partial<Record<WorkOrderStatus, string | null>> = {
    draft: wo.created_at,
    ordered: wo.ordered_at,
    at_copacker: wo.materials_at_copacker_at,
    in_production: wo.production_started_at,
    yield_recorded: wo.yield_recorded_at,
    in_transit: wo.shipped_at,
    received: wo.received_at,
    closed: wo.closed_at,
  };
  const v = map[status];
  return v ? new Date(v).toLocaleDateString() : null;
}

