import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Plus, X as XIcon, FileText, Check, Truck, Factory, PackageCheck, ShoppingCart, Scale } from 'lucide-react';
import {
  ProductBom, ProductBomLine, WorkOrderCosts, WorkOrderStatus, WorkOrderView,
  WorkOrderMaterial, WorkOrderEvent, WoAdvanceAction,
  advanceWorkOrder, createWorkOrderPipeline, fetchBomLines,
  fetchWorkOrderCosts, fetchWorkOrderEvents, fetchWorkOrderMaterials,
  generateWoPurchaseOrders, setWoMaterialVendor,
} from '../../lib/production';
import {
  ProductFormula, FormulaIngredient, fetchFormulaIngredients, scaleFormulaBatch,
} from '../../lib/formulas';
import { BatchPlan, BomPreflight, createProductionPo, fetchBatchPlan, fetchBomPreflight } from '../../lib/rawMaterials';
import { QboVendor } from '../../lib/purchasing';
import { InventoryLocation } from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { fmtNum, fm } from '../../lib/formatters';
import { GRID_SX, GRID_DEFAULTS } from '../stock/stockStyles';
import type { ProductionItemLookup } from './ProductionPage';

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
  onChanged: () => void;
}

export function WorkOrdersTab({
  workOrders, boms, formulas, vendors, locations, itemLookup, onChanged,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | WorkOrderStatus>('open');

  const filtered = useMemo(() => {
    const list = workOrders ?? [];
    if (statusFilter === 'all') return list;
    if (statusFilter === 'open') return list.filter((w) => !['closed', 'void', 'consumed'].includes(w.status));
    return list.filter((w) => w.status === statusFilter);
  }, [workOrders, statusFilter]);

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
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="toolbar-label">Stage</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} style={inp()}>
              <option value="open">All open</option>
              <option value="all">Everything</option>
              {PIPELINE.map((s) => <option key={s.status} value={s.status}>{s.label}</option>)}
              <option value="void">Void</option>
            </select>
          </div>
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
          disableRowSelectionOnClick
        />
      </div>

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

  const materialsPreview = useMemo(() => {
    if (!bomLines || !(Number(qty) > 0)) return [];
    return bomLines.filter((l) => l.line_type === 'component').map((l) => {
      const required = Number(qty) * Number(l.qty_per) * (1 + Number(l.scrap_pct || 0));
      const item = itemLookup.byId.get(l.component_qbo_item_id ?? '');
      const cost = l.default_cost ?? item?.purchase_cost ?? null;
      const vendor = vendors.find((v) => v.qbo_vendor_id === l.preferred_qbo_vendor_id);
      return {
        id: l.id,
        label: item?.item_name ?? l.component_qbo_item_id ?? '?',
        required, uom: l.qty_uom || 'each',
        cost, ext: cost != null ? required * Number(cost) : null,
        vendor: vendor?.display_name ?? (l.preferred_qbo_vendor_id ? l.preferred_qbo_vendor_id : null),
      };
    });
  }, [bomLines, qty, itemLookup, vendors]);
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
                {missingVendorCount} without a vendor — assign on the BOM or on the WO before generating POs
              </span>
            )}
          </div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginBottom: 6 }}>
            Quantities are the recipe's own units. Where a material has a pack size on file the work order
            converts these to whole vendor packs — you cannot buy 0.4 of a bag — so the ordered figure on the
            purchase order rounds up from what is shown here.
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                <th style={cellTh}>Sub-item</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>Required</th>
                <th style={cellTh}>Vendor</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>Est unit $</th>
                <th style={{ ...cellTh, textAlign: 'right' }}>Est ext $</th>
              </tr>
            </thead>
            <tbody>
              {materialsPreview.map((m) => (
                <tr key={m.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={cellTd}><strong>{m.label}</strong></td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                    {fmtNum(m.required)} {m.uom}
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
                <td colSpan={4} style={{ ...cellTd, textAlign: 'right', fontWeight: 700 }}>Estimated materials</td>
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

type ActionDialog = 'record_yield' | 'ship' | null;

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
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<ActionDialog>(null);

  const formula = wo.formula_id ? formulas.find((f) => f.id === wo.formula_id) ?? null : null;

  function reload() {
    fetchWorkOrderMaterials(wo.id).then(setMaterials).catch(() => setMaterials([]));
    fetchWorkOrderEvents(wo.id).then(setEvents).catch(() => setEvents([]));
    fetchWorkOrderCosts(wo.id).then(setCosts).catch(() => setCosts(null));
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
                <th style={{ ...cellTh, textAlign: 'right' }}>Required</th>
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
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                    {fmtNum(Number(m.required_qty))} {m.uom}
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
          <ShipDialog wo={wo} busy={busy}
            onCancel={() => setDialog(null)}
            onSubmit={(payload) => { setDialog(null); void advance('ship', 'Shipping record created', payload); }} />
        )}

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {['draft', 'ordered', 'at_copacker'].includes(wo.status) && (
            <button disabled={busy} style={btnDanger()} onClick={() => {
              const reason = prompt('Void reason? (Open POs without receipts will be voided with it.)');
              if (reason) void advance('void', 'Work order voided', { reason });
            }}>Void</button>
          )}
          {['draft', 'ordered'].includes(wo.status) && (
            <button disabled={busy || materialsMissingVendor > 0} style={btnPrimary()} onClick={doGeneratePos}
              title={materialsMissingVendor > 0 ? 'Assign a vendor to every material first' : 'One PO per vendor for all sub-items'}>
              <ShoppingCart size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
              Generate POs per vendor →
            </button>
          )}
          {wo.status === 'ordered' && (
            <button disabled={busy} style={btnSecondary()} onClick={() =>
              advance('materials_at_copacker', 'Marked at co-packer', {},
                'Mark raw materials as arrived at the co-packer? (Receive the POs in the Purchase Orders tab to keep on-hand accurate.)')}>
              <Truck size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Materials at co-packer
            </button>
          )}
          {['ordered', 'at_copacker'].includes(wo.status) && (
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
          {wo.status === 'yield_recorded' && (
            <button disabled={busy} style={btnPrimary()} onClick={() => setDialog('ship')}>
              <Truck size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Create shipping record →
            </button>
          )}
          {['yield_recorded', 'in_transit', 'received', 'closed'].includes(wo.status) && (
            <button disabled={busy} style={btnSecondary()} onClick={doCreateProductionPo}>
              <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Create production PO →
            </button>
          )}
          {wo.status === 'in_transit' && (
            <button disabled={busy} style={btnPrimary()} onClick={() =>
              advance('receive', 'Finished goods received into inventory', {},
                `Receive ${fmtNum(Number(wo.qty_produced_actual ?? 0))} finished units into ${wo.destination_location_label ?? 'the warehouse'}?`)}>
              <PackageCheck size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Receive into inventory →
            </button>
          )}
          {wo.status === 'received' && (
            <button disabled={busy} style={btnPrimary()} onClick={() => advance('close', 'Work order closed')}>
              <Check size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Close work order
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Action dialogs ───────────────────────────────────────────────────────

function RecordYieldDialog({ wo, busy, onCancel, onSubmit }: {
  wo: WorkOrderView; busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
}) {
  const [actual, setActual] = useState(String(wo.qty_to_produce));
  const [copackFee, setCopackFee] = useState('');
  const [freight, setFreight] = useState('');
  const [other, setOther] = useState('');
  const [date, setDate] = useState('');
  const pct = Number(wo.expected_units) > 0 ? (Number(actual) / Number(wo.expected_units)) * 100 : null;
  return (
    <div className="cd" style={{ padding: 12, marginTop: 12, border: '1px solid var(--ac)' }}>
      <div style={{ fontSize: 10.5, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
        Record yield — what did the co-packer actually produce?
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <LField label={`Actual yield (units, of ${fmtNum(Number(wo.qty_to_produce))} planned)`}>
          <input type="number" min={0.01} step="any" style={inp()} value={actual} onChange={(e) => setActual(e.target.value)} />
          {pct != null && Number(actual) > 0 && (
            <div style={{ fontSize: 10, marginTop: 3, color: pct < 100 ? 'var(--am)' : 'var(--gn)' }}>{pct.toFixed(1)}% of plan</div>
          )}
        </LField>
        <LField label="Co-pack fee $"><input type="number" min={0} step="any" style={inp()} value={copackFee} onChange={(e) => setCopackFee(e.target.value)} /></LField>
        <LField label="Freight $"><input type="number" min={0} step="any" style={inp()} value={freight} onChange={(e) => setFreight(e.target.value)} /></LField>
        <LField label="Other landed $"><input type="number" min={0} step="any" style={inp()} value={other} onChange={(e) => setOther(e.target.value)} /></LField>
        <LField label="Yield date"><input type="date" style={inp()} value={date} onChange={(e) => setDate(e.target.value)} /></LField>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button style={btnSecondary()} onClick={onCancel}>Cancel</button>
        <button style={btnPrimary()} disabled={busy || !(Number(actual) > 0)} onClick={() => onSubmit({
          actual_yield_qty: Number(actual),
          copack_fee: copackFee ? Number(copackFee) : 0,
          freight_cost: freight ? Number(freight) : 0,
          other_cost: other ? Number(other) : 0,
          yield_date: date || null,
        })}>Record yield + lock costs</button>
      </div>
    </div>
  );
}

function ShipDialog({ wo, busy, onCancel, onSubmit }: {
  wo: WorkOrderView; busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
}) {
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [proNumber, setProNumber] = useState('');
  const [date, setDate] = useState('');
  return (
    <div className="cd" style={{ padding: 12, marginTop: 12, border: '1px solid var(--ac)' }}>
      <div style={{ fontSize: 10.5, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
        Shipping record — {fmtNum(Number(wo.qty_produced_actual ?? 0))} finished units, {wo.copacker_location_label ?? 'co-packer'} → {wo.destination_location_label ?? 'warehouse'} (creates a BOL transfer)
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <LField label="Carrier"><input style={inp()} value={carrier} onChange={(e) => setCarrier(e.target.value)} /></LField>
        <LField label="Tracking #"><input style={inp()} value={tracking} onChange={(e) => setTracking(e.target.value)} /></LField>
        <LField label="PRO #"><input style={inp()} value={proNumber} onChange={(e) => setProNumber(e.target.value)} /></LField>
        <LField label="Ship date"><input type="date" style={inp()} value={date} onChange={(e) => setDate(e.target.value)} /></LField>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button style={btnSecondary()} onClick={onCancel}>Cancel</button>
        <button style={btnPrimary()} disabled={busy} onClick={() => onSubmit({
          carrier: carrier || null,
          tracking: tracking || null,
          pro_number: proNumber || null,
          ship_date: date || null,
        })}>
          <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Ship it
        </button>
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

const cellTh: React.CSSProperties = { textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600,
  letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)' };
const cellTd: React.CSSProperties = { padding: '6px 10px', verticalAlign: 'middle' };
