import { useEffect, useMemo, useState } from 'react';
import { PrintableTable } from '../../components/PrintableTable';
import { SearchSelect } from '../../components/SearchSelect';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { X as XIcon, FileText, Check, Truck, Factory, PackageCheck, ShoppingCart, Scale, Mail, Tag } from 'lucide-react';
import { ProductBom, WorkOrderCosts, WorkOrderStatus, WorkOrderView, WorkOrderMaterial, WorkOrderEvent, WorkOrderPoLink, WoAdvanceAction, WorkOrderLot, advanceWorkOrder, fetchWorkOrderPos, fetchWorkOrderCosts, fetchWorkOrderEvents, fetchWorkOrderMaterials, fetchWorkOrderLots, generateWoPurchaseOrders, setWoMaterialVendor, setWorkOrderLots, reopenWorkOrder, rescaleWorkOrder } from '../../lib/production';
import { ProductFormula, FormulaIngredient, fetchFormulaIngredients, scaleFormulaBatch } from '../../lib/formulas';
import { createProductionPo } from '../../lib/rawMaterials';
import { openDocPdf } from '../../lib/productionDocs';
import { adoptWorkOrdersIntoRun } from '../../lib/runs';
import { EmailDocModal } from './EmailDocModal';
import { QboVendor } from '../../lib/purchasing';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { fmtNum, fm } from '../../lib/formatters';
import { GRID_SX, GRID_DEFAULTS } from '../stock/stockStyles';
import { RecordYieldDialog, ShipDialog, LotsDialog, RescaleDialog } from './WorkOrderDialogs';
import { Meta, Kv, cellTh, cellTd } from './productionUi';
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
  formulas: ProductFormula[] | null;
  vendors: QboVendor[] | null;
  /** Open this work order's detail on mount / when it changes (a click-through from a production order). */
  initialWoId?: string | null;
  onChanged: () => void;
  /** Open a purchase order's detail (the Purchase Orders tab) — a PO number on the work order is a link, not text (20260912a). */
  onOpenPo?: (poId: string) => void;
}

// A run is raised on Production → Production Orders (Sky, 2026-09-11: the order is
// the ONLY door — a one-flavour run is still an order). This tab lists the work
// orders those orders create and opens a flavour's own record; it creates nothing.

export function WorkOrdersTab({
  workOrders, formulas, vendors, initialWoId = null, onChanged, onOpenPo,
}: Props) {
  const [openId, setOpenId] = useState<string | null>(initialWoId);
  useEffect(() => { if (initialWoId) setOpenId(initialWoId); }, [initialWoId]);
  const toast = useToast();
  const [bucket, setBucket] = useState<Bucket>('open');
  const [stage, setStage] = useState<'all' | WorkOrderStatus>('all');
  const [bulk, setBulk] = useState<'void' | 'delete' | 'edit' | 'reopen' | 'group' | null>(null);
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
  const groupItems = selectedRows.map((w) => ({
    id: w.id, number: w.batch_code, eligible: w.status !== 'void' && !w.run_id,
    why: w.run_id ? `already on ${w.run_number ?? 'a production order'}` : w.status === 'void' ? 'void' : undefined,
  }));
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
          <span style={{ fontSize: 11, color: 'var(--mt)' }}>
            A run is raised on <strong>Production Orders</strong> — one order, one or more flavours, one PO per vendor. Each flavour becomes a work order here.
          </span>
        </div>
      </div>

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
          <button type="button" className="tb-btn" disabled={busy} title="Put these flavours on ONE production order — the POs they already raised come along, unchanged" onClick={() => setBulk('group')}>Group into a production order…</button>
        )}
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
      {bulk === 'group' && (
        <ReasonDialog title="Group into a production order" verb={`Group ${groupItems.filter((i) => i.eligible).length} work order${groupItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={groupItems} needReason={false} busy={busy}
          note="One production order is created and these flavours are attached to it, with the purchase orders they already raised. Nothing is merged or voided — the POs stay as the record of what was sent. The order's actions (ship the run, receive, close) then work across every flavour. Every flavour must be at the same co-packer and ship to the same warehouse."
          onCancel={() => setBulk(null)}
          onConfirm={(_reason, ids) => { setBusy(true); adoptWorkOrdersIntoRun(ids, null)
            .then((r) => { toast.success(`${r.run_number} created — ${r.work_orders}` + (r.purchase_orders ? ` · POs ${r.purchase_orders}` : '')); setBulk(null); sel.clear(); onChanged(); })
            .catch((e) => toast.error(errMsg(e))).finally(() => setBusy(false)); }} />
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
          onOpenPo={onOpenPo}
        />
      )}
    </div>
  );
}

// ── Detail modal (pipeline) ──────────────────────────────────────────────

type ActionDialog = 'record_yield' | 'ship' | 'lots' | 'rescale' | 'edit' | null;

function PipelineDetailModal({ wo, formulas, vendors, onClose, onChanged, onOpenPo }: {
  wo: WorkOrderView;
  formulas: ProductFormula[];
  vendors: QboVendor[];
  onClose: () => void;
  onChanged: () => void;
  onOpenPo?: (poId: string) => void;
}) {
  const toast = useToast();
  const [materials, setMaterials] = useState<WorkOrderMaterial[] | null>(null);
  const [events, setEvents] = useState<WorkOrderEvent[] | null>(null);
  const [costs, setCosts] = useState<WorkOrderCosts | null>(null);
  const [ingredients, setIngredients] = useState<FormulaIngredient[] | null>(null);
  const [lots, setLots] = useState<WorkOrderLot[] | null>(null);
  const [poLinks, setPoLinks] = useState<WorkOrderPoLink[] | null>(null);
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
    fetchWorkOrderPos(wo.id).then(setPoLinks).catch(() => setPoLinks([]));
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
  // 20260911d — the plan quantity is editable until the yield is recorded; a run WO's lines are the run's.
  const canRescale = ['draft', 'ordered', 'at_copacker', 'in_production'].includes(wo.status) && !wo.run_id && wo.actual_yield_qty == null;
  const canEditDetails = !['void', 'closed', 'consumed'].includes(wo.status);
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

        {/* Purchase orders — the POs behind this flavour, each a link to its own record (20260912a).
            A run PO covers several flavours; `via` says whether this PO was raised for this work
            order alone or for the whole production order. */}
        {poLinks !== null && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
              Purchase orders
            </div>
            {poLinks.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--mt)' }}>
                None yet — {wo.run_id ? 'the production order raises one PO per vendor for every flavour on it.' : wo.status === 'draft' ? 'Generate POs on this work order to raise one per vendor.' : 'no purchase order is linked to this work order.'}
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead><tr>{['PO', 'Vendor', 'Status', 'Closes', 'Subtotal', 'Covers'].map((h) => <th key={h} style={cellTh}>{h}</th>)}</tr></thead>
                <tbody>
                  {poLinks.map((l) => (
                    <tr key={l.po_id}>
                      <td style={cellTd}>
                        {onOpenPo ? (
                          <button type="button" onClick={() => onOpenPo(l.po_id)} title="Open this purchase order"
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontWeight: 600, padding: 0, fontSize: 11 }}>
                            {l.po_number}
                          </button>
                        ) : <span style={{ fontFamily: 'var(--ff-mono)', fontWeight: 600 }}>{l.po_number}</span>}
                        {l.qbo_purchase_order_id && <span style={{ marginLeft: 6, fontSize: 9.5, color: 'var(--mt)' }}>in QuickBooks</span>}
                      </td>
                      <td style={cellTd}>{l.vendor_name ?? l.qbo_vendor_id}</td>
                      <td style={cellTd}>{l.po_status}</td>
                      <td style={{ ...cellTd, color: 'var(--mt)' }}>{l.close_rule === 'on_run_yield' ? 'when the run ships' : 'on receipt'}</td>
                      <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{l.subtotal == null ? '—' : fm(Number(l.subtotal))}</td>
                      <td style={{ ...cellTd, color: 'var(--mt)' }}>{l.via === 'run' ? 'every flavour on the production order' : 'this work order'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

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
              <PrintableTable>
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
              </PrintableTable>
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
          <PrintableTable>
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
                          ? <SearchSelect value={m.qbo_vendor_id ?? ''} placeholder="Type a vendor…" style={{ minWidth: 180 }}
                              options={vendors.map((v) => ({ id: v.qbo_vendor_id, label: v.display_name }))}
                              onChange={(id) => run('Vendor updated', () => setWoMaterialVendor(m.id, id || null))} />
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
          </PrintableTable>
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
            <PrintableTable>
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
            </PrintableTable>
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
                <span style={{ color: 'var(--mt)', whiteSpace: 'nowrap', minWidth: 90 }} title={e.created_by_email ?? undefined}>
                  {e.created_by_name ?? (e.created_by ? 'unknown user' : 'system')}
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
        {dialog === 'rescale' && (
          <RescaleDialog wo={wo} busy={busy}
            onCancel={() => setDialog(null)}
            onSubmit={(qty, reason) => { setDialog(null); void run('Plan quantity changed', async () => {
              const r = await rescaleWorkOrder(wo.id, qty, reason || null);
              toast.info(`${r.batch_code}: ${fmtNum(r.from)} → ${fmtNum(r.to)} units · ${r.po_lines} PO line${r.po_lines === 1 ? '' : 's'} rescaled`
                + (r.movements ? ` · ${r.movements} ledger correction${r.movements === 1 ? '' : 's'} posted` : '')
                + (r.purchase_orders.length ? ' · ' + r.purchase_orders.map((p) => `${p.po_number} ${fm(Number(p.subtotal))}`).join(', ') : ''));
            }); }} />
        )}
        {dialog === 'edit' && (
          <BulkEditDialog title={'Edit ' + wo.batch_code} count={1} busy={busy}
            fields={[{ key: 'scheduled_date', label: 'Scheduled date', type: 'date' }, { key: 'notes', label: 'Notes (e.g. "part 2 of the June canning run")', type: 'textarea' }]}
            onCancel={() => setDialog(null)}
            onConfirm={(patch) => { setDialog(null); void run('Work order updated', async () => {
              const r = await updateDocs('work_order', [wo.id], patch);
              if (r.skipped.length) throw new Error(r.skipped[0].reason);
            }); }} />
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
          {canEditDetails && (
            <button disabled={busy} style={btnSecondary()} title="Scheduled date and notes" onClick={() => setDialog(dialog === 'edit' ? null : 'edit')}>Edit details…</button>
          )}
          {canRescale && (
            <button disabled={busy} style={btnSecondary()} title="Change the planned quantity — materials, PO lines and any posted consumption follow" onClick={() => setDialog(dialog === 'rescale' ? null : 'rescale')}>
              <Scale size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Change quantity…
            </button>
          )}
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

