import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { CheckCircle2, FileText, Plus, Send, Truck, X as XIcon } from 'lucide-react';
import {
  BomLineInput, BomMaterialRequirement, CopackOrderCosts, CopackOrderRow, CopackOrderStatus, ProductBom, ProductBomLine,
  closeCopackOrder, createCopackOrder, fetchBomLines, fetchCopackOrderCosts,
  receiveCopackOrder, sendCopackOrder, voidCopackOrder,
} from '../../lib/production';
import type { CopackMaterialSourceMode, CopackSyrupVarianceStatus } from '../../lib/production';
import type { QboVendor } from '../../lib/purchasing';
import {
  createTransfer,
  type InventoryLocation,
  type InventoryTransferLineInput,
} from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { fm, fmtNum } from '../../lib/formatters';
import { GRID_DEFAULTS, GRID_SX } from '../stock/stockStyles';
import { fmtQty, scaleBom, UOM_OPTIONS } from '../../lib/uom';
import type { ProductionItemLookup } from './ProductionPage';
import { ProductionUnitConverter } from './ProductionUnitConverter';
import { MaterialRequirementsPanel } from './MaterialRequirementsPanel';
import { FormulaReadinessPanel } from './FormulaReadinessPanel';
import { evaluateFormulaReadiness } from './formulaReadiness';

const STATUS_COLOR: Record<CopackOrderStatus, string> = {
  draft: 'var(--mt)',
  sent: 'var(--ac)',
  received: 'var(--gn)',
  closed: '#64748b',
  void: '#64748b',
};

const TANK_SIZES_GAL = [500, 1500, 2000, 2500];

const SOURCE_MODE_LABEL: Record<CopackMaterialSourceMode, string> = {
  raw_materials: 'Raw Materials Co-Pack',
  syrup_by_gallon: 'Syrup Co-Pack',
};

const SYRUP_VARIANCE_LABEL: Record<CopackSyrupVarianceStatus, string> = {
  pending: 'Pending',
  ok: 'OK',
  watch: 'Watch',
  alert: 'Alert',
};

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

type PackEntryUnit = 'finished' | 'can' | 'pack8' | 'pack24';

const PACK_ENTRY_OPTIONS: { value: PackEntryUnit; label: string }[] = [
  { value: 'finished', label: 'finished units' },
  { value: 'can', label: 'cans' },
  { value: 'pack8', label: '8-packs' },
  { value: 'pack24', label: '24-packs' },
];

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
    {
      field: 'material_source_mode', headerName: 'Source', width: 150,
      renderCell: (p) => {
        const v = String(p.value ?? 'raw_materials') as CopackMaterialSourceMode;
        return <span style={{ fontSize: 10, color: 'var(--tx)', fontWeight: 600 }}>
          {SOURCE_MODE_LABEL[v] ?? 'Raw Materials Co-Pack'}
        </span>;
      },
    },
    {
      field: 'syrup_variance_status', headerName: 'Syrup Var', width: 130,
      renderCell: (p) => {
        if (p.row.material_source_mode !== 'syrup_by_gallon') {
          return <span style={{ color: 'var(--mt)' }}>—</span>;
        }
        const status = String(p.value ?? 'pending') as CopackSyrupVarianceStatus;
        const tone = syrupVarianceTone(status);
        const delta = p.row.syrup_cost_variance == null ? null : Number(p.row.syrup_cost_variance);
        return (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            color: tone.color, border: `1px solid ${tone.border}`,
            background: tone.bg, padding: '1px 7px', borderRadius: 10,
            fontSize: 10, fontWeight: 700,
          }}>
            {SYRUP_VARIANCE_LABEL[status] ?? 'Pending'}
            {delta == null ? '' : ` ${fmtDeltaMoney(delta)}`}
          </span>
        );
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
          locations={locations}
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
  const [materialSourceMode, setMaterialSourceMode] = useState<CopackMaterialSourceMode>('raw_materials');
  const [syrupRate, setSyrupRate] = useState('');
  const [selectedBomLines, setSelectedBomLines] = useState<BomLineInput[] | null>(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!bomId) {
      setSelectedBomLines(null);
      return () => { alive = false; };
    }
    setSelectedBomLines(null);
    fetchBomLines(bomId)
      .then((rows) => alive && setSelectedBomLines(rows.map(bomLineToInputForReadiness)))
      .catch(() => alive && setSelectedBomLines([]));
    return () => { alive = false; };
  }, [bomId]);

  const selectedBom = boms.find((b) => b.id === bomId);
  const selectedFinished = selectedBom ? itemLookup.byId.get(selectedBom.finished_qbo_item_id) : null;
  const selectedFormulaReadiness = useMemo(() => selectedBom
    ? evaluateFormulaReadiness({
      bom: selectedBom,
      lines: selectedBomLines,
      itemLookup,
      materialSourceMode,
      syrupUnitCostPerGal: Number(syrupRate || 0),
      requireSyrupRate: materialSourceMode === 'syrup_by_gallon',
    })
    : null,
  [selectedBom, selectedBomLines, itemLookup, materialSourceMode, syrupRate]);
  const readinessAllowsSave = !selectedFormulaReadiness
    || selectedFormulaReadiness.status === 'ready'
    || selectedFormulaReadiness.status === 'watch';
  const canSave = !!bomId && !!vendorId && !!locId && Number(qty) > 0
    && readinessAllowsSave;

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
        material_source_mode: materialSourceMode,
        syrup_unit_cost_per_gal: Number(syrupRate || 0),
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
        <LField label="Material source">
          <select style={inp()} value={materialSourceMode} onChange={(e) => setMaterialSourceMode(e.target.value as CopackMaterialSourceMode)}>
            <option value="raw_materials">Raw Materials Co-Pack</option>
            <option value="syrup_by_gallon">Syrup Co-Pack</option>
          </select>
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
          {selectedBom && (
            <PackEntryHelper
              bom={selectedBom}
              onApply={(nextQty, nextUom) => {
                setQty(formatInputQty(nextQty));
                setTargetUom(nextUom);
              }}
            />
          )}
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
        {materialSourceMode === 'syrup_by_gallon' && (
          <LField label="Syrup $ / gal">
            <input type="number" min={0} step="any" style={inp()} value={syrupRate} onChange={(e) => setSyrupRate(e.target.value)} />
          </LField>
        )}
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

      {selectedFormulaReadiness && (
        <FormulaReadinessPanel
          readiness={selectedFormulaReadiness}
          title="Co-pack readiness"
          compact
        />
      )}

      {selectedBom && Number(qty) > 0 && materialSourceMode === 'raw_materials' && (
        <MaterialRequirementsPanel
          bomId={selectedBom.id}
          targetQty={Number(qty)}
          targetUom={targetUom}
          title="Raw materials to stage for co-packer"
        />
      )}
      {selectedBom && Number(qty) > 0 && materialSourceMode === 'syrup_by_gallon' && (
        <SyrupModeNotice
          syrupGallons={null}
          syrupRate={Number(syrupRate || 0)}
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
  orderId, order, bomById, locations, locById, itemLookup, onClose, onChanged,
}: {
  orderId: string;
  order: CopackOrderRow | null;
  bomById: Map<string, ProductBom>;
  locations: InventoryLocation[];
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
  const [syrupGallonsActual, setSyrupGallonsActual] = useState('');
  const [syrupRateActual, setSyrupRateActual] = useState('');
  const [busy, setBusy] = useState(false);
  const [sourceLocId, setSourceLocId] = useState('');
  const [copackerLocId, setCopackerLocId] = useState('');
  const [materialRows, setMaterialRows] = useState<BomMaterialRequirement[] | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);

  const sourceLocs = useMemo(
    () => locations.filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment' && l.kind !== 'co_packer'),
    [locations],
  );
  const copackerLocs = useMemo(
    () => locations.filter((l) => l.is_active && l.kind === 'co_packer'),
    [locations],
  );

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
      setSyrupGallonsActual(
        order.actual_syrup_gallons == null
          ? (order.syrup_gallons == null ? '' : String(order.syrup_gallons))
          : String(order.actual_syrup_gallons),
      );
      setSyrupRateActual(
        order.actual_syrup_unit_cost_per_gal == null
          ? (Number(order.syrup_unit_cost_per_gal || 0) > 0 ? String(order.syrup_unit_cost_per_gal) : '')
          : String(order.actual_syrup_unit_cost_per_gal),
      );
      setMaterialRows(null);
      setSourceLocId((cur) => sourceLocs.some((l) => l.id === cur) ? cur : (sourceLocs[0]?.id ?? ''));
      setCopackerLocId((cur) => copackerLocs.some((l) => l.id === cur) ? cur : (copackerLocs[0]?.id ?? ''));
    }
    return () => { alive = false; };
  }, [orderId, order, sourceLocs, copackerLocs]);

  if (!order) return null;
  const currentOrder = order;
  const bom = bomById.get(order.bom_id);
  const loc = locById.get(order.destination_location_id);
  const sourceLoc = locById.get(sourceLocId);
  const copackerLoc = locById.get(copackerLocId);
  const finished = itemLookup.byId.get(order.finished_qbo_item_id);
  const materialSourceMode = order.material_source_mode ?? 'raw_materials';
  const isSyrupMode = materialSourceMode === 'syrup_by_gallon';
  const syrupGallons = order.syrup_gallons == null ? null : Number(order.syrup_gallons);
  const syrupRate = Number(order.syrup_unit_cost_per_gal ?? 0);
  const plannedSyrupGallons = order.estimated_syrup_gallons == null ? null : Number(order.estimated_syrup_gallons);
  const plannedSyrupCost = order.estimated_syrup_cost == null ? null : Number(order.estimated_syrup_cost);
  const lockedSyrupGallonsForVariance = order.locked_syrup_gallons == null ? null : Number(order.locked_syrup_gallons);
  const lockedSyrupRateForVariance = order.locked_syrup_unit_cost_per_gal == null ? null : Number(order.locked_syrup_unit_cost_per_gal);
  const lockedSyrupCostForVariance = order.locked_syrup_cost == null ? null : Number(order.locked_syrup_cost);
  const syrupGallonsVariance = order.syrup_gallons_variance == null ? null : Number(order.syrup_gallons_variance);
  const syrupGallonsVariancePct = order.syrup_gallons_variance_pct == null ? null : Number(order.syrup_gallons_variance_pct);
  const syrupCostVariance = order.syrup_cost_variance == null ? null : Number(order.syrup_cost_variance);
  const syrupCostVariancePct = order.syrup_cost_variance_pct == null ? null : Number(order.syrup_cost_variance_pct);
  const enteredSyrupGallons = syrupGallonsActual === '' ? null : Number(syrupGallonsActual);
  const enteredSyrupRate = syrupRateActual === '' ? null : Number(syrupRateActual);
  const savedSyrupRate = order.actual_syrup_unit_cost_per_gal == null
    ? null
    : Number(order.actual_syrup_unit_cost_per_gal);
  const effectiveSyrupGallons = isSyrupMode && enteredSyrupGallons != null && Number.isFinite(enteredSyrupGallons)
    ? enteredSyrupGallons
    : syrupGallons;
  const effectiveSyrupRate = isSyrupMode && enteredSyrupRate != null && Number.isFinite(enteredSyrupRate)
    ? enteredSyrupRate
    : savedSyrupRate ?? syrupRate;
  const syrupInvoiceTotal = effectiveSyrupGallons == null ? null : effectiveSyrupGallons * effectiveSyrupRate;
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
  const estimatedComponentCost = isSyrupMode
    ? Number(effectiveSyrupGallons ?? 0) * effectiveSyrupRate
    : materialRows
    ? materialRows.reduce((sum, r) => sum + Number(r.required_qty || 0) * Number(r.unit_cost ?? 0), 0)
    : (bomLines ?? []).reduce((sum, l, idx) => {
      if (l.line_type !== 'component') return sum;
      const scaled = plannedByIdx.get(idx);
      const unitCost = l.default_cost ?? itemLookup.byId.get(l.component_qbo_item_id ?? '')?.purchase_cost ?? 0;
      return sum + Number(scaled?.qty ?? 0) * Number(unitCost ?? 0);
    }, 0);
  const estimatedServiceCost = (bomLines ?? []).reduce((sum, l, idx) => {
    if (l.line_type !== 'service') return sum;
    const scaled = plannedByIdx.get(idx);
    return sum + Number(scaled?.qty ?? 0) * Number(l.default_cost ?? 0);
  }, 0);
  const estimatedLandedCost = Number(order.co_pack_fee || 0) + Number(order.freight_cost || 0) + Number(order.other_landed_cost || 0);
  const estimatedTotalCost = estimatedComponentCost + estimatedServiceCost + estimatedLandedCost;
  const estimatedFinishedUnits = bom ? estimateFinishedUnits(Number(order.qty_ordered), order.target_uom || 'gal', bom) : null;
  const estimatedUnitCost = estimatedFinishedUnits && estimatedFinishedUnits > 0
    ? estimatedTotalCost / estimatedFinishedUnits
    : null;
  const shortageRows = isSyrupMode ? [] : (materialRows ?? []).filter((r) => Number(r.shortage_qty) > 0);
  const shortageCost = shortageRows.reduce((sum, r) => sum + Number(r.shortage_cost ?? 0), 0);

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
    const syrupGallonsForReceive = isSyrupMode
      ? (enteredSyrupGallons != null && Number.isFinite(enteredSyrupGallons) ? enteredSyrupGallons : syrupGallons)
      : null;
    const syrupRateForReceive = isSyrupMode
      ? (enteredSyrupRate != null && Number.isFinite(enteredSyrupRate) ? enteredSyrupRate : syrupRate)
      : null;
    if (isSyrupMode && !(Number(syrupGallonsForReceive) > 0)) {
      toast.error('Enter vendor invoice syrup gallons');
      return;
    }
    if (isSyrupMode && !(Number(syrupRateForReceive) > 0)) {
      toast.error('Enter vendor invoice syrup $ / gal');
      return;
    }
    const receiveBasis = isSyrupMode
      ? `using invoice syrup ${fmtQty(Number(syrupGallonsForReceive), 'gal')} at $${Number(syrupRateForReceive).toFixed(4)} / gal + services + landed costs`
      : 'using BOM cost + co-pack fee + freight';
    if (!confirm(`Receive ${order!.order_number}?\n\nThis will add finished inventory at landed unit cost ${receiveBasis}.`)) return;
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
        syrup_gallons: syrupGallonsForReceive,
        syrup_unit_cost_per_gal: syrupRateForReceive,
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

  async function doCreateMaterialTransfer() {
    if (isSyrupMode) {
      toast.error('Syrup co-pack orders do not stage APBG raw materials');
      return;
    }
    if (!sourceLocId || !copackerLocId || sourceLocId === copackerLocId) {
      toast.error('Pick a source and co-packer location');
      return;
    }
    const rows = (materialRows ?? []).filter((r) => Number(r.required_qty) > 0);
    if (rows.length === 0) {
      toast.error('No raw material rows are available yet');
      return;
    }
    const shortRows = rows.filter((r) => Number(r.shortage_qty) > 0);
    const shortMsg = shortRows.length > 0
      ? `\n\nWarning: ${sourceLoc?.code ?? 'source'} is short on ${shortRows.length} item${shortRows.length === 1 ? '' : 's'}. The draft transfer will still be a staging packet, but do not ship it until the shortage is resolved.`
      : '';
    if (!confirm(`Create a draft material transfer for ${currentOrder.order_number}?${shortMsg}`)) return;

    const transferLines: InventoryTransferLineInput[] = rows.map((r) => ({
      qbo_item_id: r.component_qbo_item_id,
      qty: Number(r.required_qty),
      unit_cost: r.unit_cost == null ? null : Number(r.unit_cost),
      notes: `${currentOrder.order_number} raw material · required ${fmtQty(Number(r.required_qty), r.required_uom || 'each')}` +
        (Number(r.shortage_qty) > 0 ? ` · source short ${fmtQty(Number(r.shortage_qty), r.required_uom || 'each')}` : ''),
    }));

    setTransferBusy(true);
    try {
      await createTransfer({
        from_location_id: sourceLocId,
        to_location_id: copackerLocId,
        lines: transferLines,
        notes: [
          `Raw materials for co-pack order ${currentOrder.order_number}`,
          `Finished SKU: ${finished?.item_name ?? currentOrder.finished_item_name ?? currentOrder.finished_qbo_item_id}`,
          `Order yield: ${orderedLabel}`,
          `Co-packer: ${currentOrder.vendor_name ?? currentOrder.qbo_vendor_id}`,
        ].join('\n'),
        special_instructions: `Stage and ship raw materials for ${currentOrder.order_number}. Do not mark shipped until source shortages are resolved.`,
      });
      toast.success('Draft raw material transfer created');
    } catch (e) { toast.error(errMsg(e)); }
    finally { setTransferBusy(false); }
  }

  function printOrder() {
    const w = window.open('', '_blank');
    if (!w) return;
    const printSyrupGallons = costs?.syrup_gallons == null
      ? effectiveSyrupGallons
      : Number(costs.syrup_gallons);
    const printSyrupRate = order!.actual_syrup_unit_cost_per_gal == null
      ? effectiveSyrupRate
      : Number(order!.actual_syrup_unit_cost_per_gal);
    const materialRowsHtml = isSyrupMode
      ? `<tr>
          <td>Flavor company syrup</td>
          <td style="text-align:right">${escapeHtml(printSyrupGallons == null ? '-' : fmtQty(printSyrupGallons, 'gal'))}</td>
          <td style="text-align:right">Supplied by vendor</td>
          <td style="text-align:right">-</td>
          <td style="text-align:right">-</td>
          <td style="text-align:right">-</td>
          <td style="text-align:right">${escapeHtml(`$${printSyrupRate.toFixed(4)}`)}</td>
          <td style="text-align:right">${escapeHtml(fm(estimatedComponentCost))}</td>
          <td>SYRUP</td>
        </tr>`
      : materialRows && materialRows.length > 0
      ? materialRows.map((r) => {
        const uom = r.required_uom || 'each';
        const sourceStock = sourceLocId ? Number(r.location_on_hand_qty ?? 0) : Number(r.on_hand_qty ?? 0);
        const status = Number(r.shortage_qty) > 0 ? 'SHORT' : r.status.toUpperCase();
        const extended = Number(r.required_qty || 0) * Number(r.unit_cost ?? 0);
        return `<tr class="${Number(r.shortage_qty) > 0 ? 'warn' : ''}">
          <td>${escapeHtml(r.item_name ?? r.component_qbo_item_id)}</td>
          <td style="text-align:right">${escapeHtml(fmtQty(Number(r.required_qty), uom))}</td>
          <td style="text-align:right">${escapeHtml(fmtQty(sourceStock, uom))}</td>
          <td style="text-align:right">${escapeHtml(fmtQty(Number(r.on_hand_qty ?? 0), uom))}</td>
          <td style="text-align:right">${escapeHtml(fmtQty(Number(r.on_order_qty ?? 0), uom))}</td>
          <td style="text-align:right">${escapeHtml(fmtQty(Number(r.shortage_qty ?? 0), uom))}</td>
          <td style="text-align:right">${escapeHtml(r.unit_cost == null ? '-' : `$${Number(r.unit_cost).toFixed(4)}`)}</td>
          <td style="text-align:right">${escapeHtml(fm(extended))}</td>
          <td>${escapeHtml(status)}</td>
        </tr>`;
      }).join('')
      : (bomLines ?? []).map((l, idx) => ({ l, idx })).filter(({ l }) => l.line_type === 'component').map(({ l, idx }) => {
        const itemName = itemLookup.byId.get(l.component_qbo_item_id ?? '')?.item_name ?? l.component_qbo_item_id ?? '?';
        const scaled = plannedByIdx.get(idx);
        const unitCost = l.default_cost ?? itemLookup.byId.get(l.component_qbo_item_id ?? '')?.purchase_cost ?? null;
        const extended = Number(scaled?.qty ?? 0) * Number(unitCost ?? 0);
        return `<tr>
          <td>${escapeHtml(itemName)}</td>
          <td style="text-align:right">${escapeHtml(scaled ? fmtQty(scaled.qty, scaled.uom) : '-')}</td>
          <td style="text-align:right">-</td>
          <td style="text-align:right">-</td>
          <td style="text-align:right">-</td>
          <td style="text-align:right">-</td>
          <td style="text-align:right">${escapeHtml(unitCost == null ? '-' : `$${Number(unitCost).toFixed(4)}`)}</td>
          <td style="text-align:right">${escapeHtml(fm(extended))}</td>
          <td>UNCHECKED</td>
        </tr>`;
      }).join('');
    const serviceRowsHtml = (bomLines ?? []).map((l, idx) => ({ l, idx })).filter(({ l }) => l.line_type === 'service').map(({ l, idx }) => {
      const itemName = l.service_label ?? '?';
      const scaled = plannedByIdx.get(idx);
      const unitCost = l.default_cost ?? null;
      const extended = Number(scaled?.qty ?? 0) * Number(unitCost ?? 0);
      return `<tr>
        <td>${escapeHtml(itemName)}</td>
        <td style="text-align:right">${escapeHtml(fmtQty(Number(l.qty_per), l.qty_uom || 'each'))}</td>
        <td style="text-align:right">${escapeHtml(scaled ? fmtQty(scaled.qty, scaled.uom) : '-')}</td>
        <td style="text-align:right">${escapeHtml(unitCost == null ? '-' : `$${Number(unitCost).toFixed(4)}`)}</td>
        <td style="text-align:right">${escapeHtml(fm(extended))}</td>
      </tr>`;
    }).join('');
    const costBasis = costs ? `Locked ${new Date(costs.computed_at).toLocaleString()}` : 'Estimated from current BOM + item costs';
    const packetComponentCost = costs ? Number(costs.components_cost) : estimatedComponentCost;
    const packetServiceCost = costs ? Number(costs.services_cost) : estimatedServiceCost;
    const packetCoPackFee = costs ? Number(costs.co_pack_fee) : Number(order!.co_pack_fee || 0);
    const packetFreight = costs ? Number(costs.freight_cost) : Number(order!.freight_cost || 0);
    const packetOther = costs ? Number(costs.other_cost) : Number(order!.other_landed_cost || 0);
    const packetTotal = costs ? Number(costs.total_cost) : estimatedTotalCost;
    const packetUnitCost = costs ? costs.unit_cost : estimatedUnitCost;
    const syrupVarianceHtml = isSyrupMode ? `
      <h2>Syrup Variance</h2>
      <div class="totals">
        <div class="kv"><div class="lbl">Planned gal</div>${escapeHtml(plannedSyrupGallons == null ? '-' : fmtQty(plannedSyrupGallons, 'gal'))}</div>
        <div class="kv"><div class="lbl">Invoice gal</div>${escapeHtml(lockedSyrupGallonsForVariance == null ? '-' : fmtQty(lockedSyrupGallonsForVariance, 'gal'))}</div>
        <div class="kv"><div class="lbl">Gal variance</div>${escapeHtml(fmtDeltaQty(syrupGallonsVariance, 'gal'))}</div>
        <div class="kv"><div class="lbl">Gal variance %</div>${escapeHtml(fmtDeltaPct(syrupGallonsVariancePct))}</div>
        <div class="kv"><div class="lbl">Cost variance</div>${escapeHtml(fmtDeltaMoney(syrupCostVariance))}</div>
        <div class="kv"><div class="lbl">Status</div>${escapeHtml(SYRUP_VARIANCE_LABEL[order!.syrup_variance_status ?? 'pending'] ?? 'Pending')}</div>
      </div>` : '';
    w.document.write(`<html><head><title>${escapeHtml(order!.order_number)}</title>
      <style>
        @page{size:letter;margin:0.5in}
        body{font-family:system-ui,sans-serif;color:#0a0e17;font-size:11px;margin:0}
        h1{font-size:20px;border-bottom:3px solid #0a0e17;padding-bottom:6px;margin:0 0 12px}
        h2{font-size:12px;margin:14px 0 6px;text-transform:uppercase;letter-spacing:1px}
        .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
        .kv{border:1px solid #0a0e17;padding:6px 8px}
        .lbl{font-size:8px;font-weight:700;letter-spacing:1px;color:#475569;text-transform:uppercase}
        table{width:100%;border-collapse:collapse;font-size:10.5px;border:1px solid #0a0e17;margin-top:10px}
        th{background:#0a0e17;color:#fff;padding:5px 6px;font-size:8.5px;text-align:left;text-transform:uppercase;letter-spacing:1px}
        td{padding:5px 6px;border-bottom:1px solid #e2e8f0}
        .warn td{background:#fff7ed}
        .totals{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-top:8px}
      </style></head><body>
      <h1>Co-Pack Order · ${escapeHtml(order!.order_number)}</h1>
      <div class="meta">
        <div class="kv"><div class="lbl">Co-packer</div>${escapeHtml(order!.vendor_name ?? order!.qbo_vendor_id)}</div>
        <div class="kv"><div class="lbl">Finished SKU</div>${escapeHtml(finished?.item_name ?? order!.finished_item_name ?? order!.finished_qbo_item_id)}</div>
        <div class="kv"><div class="lbl">Ordered yield</div>${escapeHtml(orderedLabel)}</div>
        <div class="kv"><div class="lbl">Finished units</div>${escapeHtml(order!.finished_units_received == null ? (estimatedFinishedUnits == null ? '-' : fmtNum(estimatedFinishedUnits)) : fmtNum(Number(order!.finished_units_received)))}</div>
        <div class="kv"><div class="lbl">Material source</div>${escapeHtml(SOURCE_MODE_LABEL[materialSourceMode])}</div>
        <div class="kv"><div class="lbl">Expected</div>${escapeHtml(order!.expected_date ?? '-')}</div>
        <div class="kv"><div class="lbl">Receive to</div>${escapeHtml(loc?.name ?? order!.location_label ?? '-')}</div>
        <div class="kv"><div class="lbl">Stage from</div>${escapeHtml(isSyrupMode ? 'Vendor supplied syrup' : sourceLoc ? `${sourceLoc.code} - ${sourceLoc.name}` : '-')}</div>
        <div class="kv"><div class="lbl">Co-packer staging</div>${escapeHtml(isSyrupMode ? 'Not staged by APBG' : copackerLoc ? `${copackerLoc.code} - ${copackerLoc.name}` : '-')}</div>
        <div class="kv"><div class="lbl">Instructions</div>${escapeHtml(order!.notes ?? '-')}</div>
      </div>
      <h2>Cost Summary · ${escapeHtml(costBasis)}</h2>
      <div class="totals">
        <div class="kv"><div class="lbl">Components</div>${escapeHtml(fm(packetComponentCost))}</div>
        <div class="kv"><div class="lbl">Services</div>${escapeHtml(fm(packetServiceCost))}</div>
        <div class="kv"><div class="lbl">Co-pack fee</div>${escapeHtml(fm(packetCoPackFee))}</div>
        <div class="kv"><div class="lbl">Freight</div>${escapeHtml(fm(packetFreight))}</div>
        <div class="kv"><div class="lbl">Other</div>${escapeHtml(fm(packetOther))}</div>
        <div class="kv"><div class="lbl">Landed $/unit</div>${escapeHtml(packetUnitCost == null ? '-' : `$${Number(packetUnitCost).toFixed(4)}`)}</div>
      </div>
      <div class="kv" style="margin-top:6px"><div class="lbl">Total landed COGS</div>${escapeHtml(fm(packetTotal))}</div>
      ${syrupVarianceHtml}
      <h2>${isSyrupMode ? 'Syrup Supply' : 'Raw Materials'} ${shortageRows.length > 0 ? `· ${shortageRows.length} short` : ''}</h2>
      <table><thead><tr><th>Component</th><th style="text-align:right">Required</th><th style="text-align:right">Source stock</th><th style="text-align:right">All stock</th><th style="text-align:right">On order</th><th style="text-align:right">Short</th><th style="text-align:right">Unit $</th><th style="text-align:right">Extended</th><th>Status</th></tr></thead><tbody>${materialRowsHtml}</tbody></table>
      ${serviceRowsHtml ? `<h2>Services / Co-Pack Work</h2><table><thead><tr><th>Service</th><th style="text-align:right">Qty / Recipe</th><th style="text-align:right">Required</th><th style="text-align:right">Unit $</th><th style="text-align:right">Extended</th></tr></thead><tbody>${serviceRowsHtml}</tbody></table>` : ''}
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

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, fontSize: 12, marginBottom: 14 }}>
          <Meta label="Ordered yield" value={orderedLabel} />
          <Meta label="Actual yield" value={receivedLabel} />
          <Meta label="Finished units" value={order.finished_units_received == null ? '—' : fmtNum(Number(order.finished_units_received))} />
          <Meta label="Material source" value={SOURCE_MODE_LABEL[materialSourceMode]} />
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

        {bom && !isSyrupMode && (
          <>
            <div style={{
              marginBottom: 10,
              padding: 12,
              border: '1px solid var(--bd)',
              borderRadius: 4,
              background: 'rgba(255,255,255,0.025)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
                <Truck size={15} color="var(--ac)" />
                <div>
                  <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
                    Stage raw materials to co-packer
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 2 }}>
                    Creates a draft stock transfer packet. Inventory moves only when the transfer is shipped.
                  </div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, alignItems: 'end' }}>
                <LField label="Source stock location">
                  <select style={inp()} value={sourceLocId} onChange={(e) => setSourceLocId(e.target.value)}>
                    <option value="">—</option>
                    {sourceLocs.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
                  </select>
                </LField>
                <LField label="Co-packer staging location">
                  <select style={inp()} value={copackerLocId} onChange={(e) => setCopackerLocId(e.target.value)}>
                    <option value="">—</option>
                    {copackerLocs.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
                  </select>
                </LField>
                <div>
                  <button
                    onClick={doCreateMaterialTransfer}
                    disabled={transferBusy || !sourceLocId || !copackerLocId || !materialRows || materialRows.length === 0}
                    style={btnPrimary()}
                  >
                    <Truck size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
                    {transferBusy ? 'Creating…' : 'Create Draft Transfer'}
                  </button>
                </div>
              </div>
              {copackerLocs.length === 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--am)' }}>
                  Add an active inventory location with kind “co-packer” before creating staging transfers.
                </div>
              )}
            </div>
            <MaterialRequirementsPanel
              bomId={bom.id}
              targetQty={Number(order.qty_ordered)}
              targetUom={order.target_uom || 'gal'}
              locationId={sourceLocId || null}
              locationLabel={sourceLoc ? `${sourceLoc.code} — ${sourceLoc.name}` : null}
              title="Raw materials to stage for co-packer"
              onRowsChange={setMaterialRows}
            />
            {!costs && (
              <div style={{
                marginBottom: 14, padding: 12,
                background: 'rgba(91,181,240,0.04)', border: '1px solid rgba(91,181,240,0.18)', borderRadius: 4,
              }}>
                <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 }}>
                  Estimated COGS packet · before receipt
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: 8, fontSize: 13 }}>
                  <Kv label="Components" value={fm(estimatedComponentCost)} />
                  <Kv label="Services" value={fm(estimatedServiceCost)} />
                  <Kv label="Landed costs" value={fm(estimatedLandedCost)} />
                  <Kv label="Total" value={fm(estimatedTotalCost)} bold accent />
                  <Kv label="$ / finished unit" value={estimatedUnitCost == null ? '—' : `$${Number(estimatedUnitCost).toFixed(4)}`} bold accent />
                  <Kv label="Short $" value={fm(shortageCost)} />
                </div>
              </div>
            )}
          </>
        )}

        {bom && isSyrupMode && (
          <>
            <SyrupModeNotice
              syrupGallons={effectiveSyrupGallons}
              syrupRate={effectiveSyrupRate}
            />
            <SyrupVariancePanel
              status={order.syrup_variance_status}
              plannedGallons={plannedSyrupGallons}
              plannedCost={plannedSyrupCost}
              lockedGallons={lockedSyrupGallonsForVariance}
              lockedRate={lockedSyrupRateForVariance}
              lockedCost={lockedSyrupCostForVariance}
              gallonsVariance={syrupGallonsVariance}
              gallonsVariancePct={syrupGallonsVariancePct}
              costVariance={syrupCostVariance}
              costVariancePct={syrupCostVariancePct}
            />
            {!costs && (
              <div style={{
                marginBottom: 14, padding: 12,
                background: 'rgba(91,181,240,0.04)', border: '1px solid rgba(91,181,240,0.18)', borderRadius: 4,
              }}>
                <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 }}>
                  Estimated COGS packet · syrup co-pack
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: 8, fontSize: 13 }}>
                  <Kv label="Syrup gal" value={effectiveSyrupGallons == null ? '—' : fmtQty(effectiveSyrupGallons, 'gal')} />
                  <Kv label="$ / gal" value={`$${Number(effectiveSyrupRate || 0).toFixed(4)}`} />
                  <Kv label="Syrup" value={fm(estimatedComponentCost)} />
                  <Kv label="Services" value={fm(estimatedServiceCost)} />
                  <Kv label="Landed costs" value={fm(estimatedLandedCost)} />
                  <Kv label="Total" value={fm(estimatedTotalCost)} bold accent />
                  <Kv label="$ / finished unit" value={estimatedUnitCost == null ? '—' : `$${Number(estimatedUnitCost).toFixed(4)}`} bold accent />
                </div>
              </div>
            )}
          </>
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
                {bom && (
                  <PackEntryHelper
                    bom={bom}
                    label="Actual pack entry"
                    onApply={(nextQty, nextUom) => {
                      setActualQty(formatInputQty(nextQty));
                      setActualUom(nextUom);
                    }}
                  />
                )}
              </LField>
              {isSyrupMode && (
                <>
                  <LField label="Invoice syrup gallons">
                    <input
                      type="number"
                      min={0.0001}
                      step="any"
                      style={inp()}
                      value={syrupGallonsActual}
                      onChange={(e) => setSyrupGallonsActual(e.target.value)}
                    />
                    <div style={{ marginTop: 4, fontSize: 10, color: 'var(--mt)' }}>
                      BOM estimate: {syrupGallons == null ? '—' : fmtQty(syrupGallons, 'gal')}
                    </div>
                  </LField>
                  <LField label="Invoice $ / gal">
                    <input
                      type="number"
                      min={0.0001}
                      step="any"
                      style={inp()}
                      value={syrupRateActual}
                      onChange={(e) => setSyrupRateActual(e.target.value)}
                    />
                    <div style={{ marginTop: 4, fontSize: 10, color: 'var(--mt)' }}>
                      Syrup total: {syrupInvoiceTotal == null ? '—' : fm(syrupInvoiceTotal)}
                    </div>
                  </LField>
                </>
              )}
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: 8, fontSize: 13 }}>
              <Kv label={isSyrupMode ? 'Syrup' : 'BOM components'} value={fm(Number(costs.components_cost))} />
              {isSyrupMode && <Kv label="Syrup gal" value={costs.syrup_gallons == null ? '—' : fmtQty(Number(costs.syrup_gallons), 'gal')} />}
              {isSyrupMode && <Kv label="$ / gal" value={`$${Number(effectiveSyrupRate || 0).toFixed(4)}`} />}
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

function SyrupModeNotice({
  syrupGallons,
  syrupRate,
}: {
  syrupGallons: number | null;
  syrupRate: number;
}) {
  const syrupCost = syrupGallons == null ? null : syrupGallons * syrupRate;
  return (
    <section style={{
      marginTop: 12,
      marginBottom: 14,
      padding: 12,
      border: '1px solid rgba(91,181,240,0.24)',
      borderRadius: 4,
      background: 'rgba(91,181,240,0.05)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Truck size={15} color="var(--ac)" />
        <div>
          <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
            Syrup Co-Pack
          </div>
          <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 2 }}>
            Syrup is supplied by the flavor company and billed by gallon. APBG component inventory is not staged for this order.
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <MiniStat label="Syrup gal" value={syrupGallons == null ? '—' : fmtQty(syrupGallons, 'gal')} />
        <MiniStat label="$ / gal" value={`$${Number(syrupRate || 0).toFixed(4)}`} />
        <MiniStat label="Syrup cost" value={syrupCost == null ? '—' : fm(syrupCost)} />
      </div>
    </section>
  );
}

function SyrupVariancePanel({
  status,
  plannedGallons,
  plannedCost,
  lockedGallons,
  lockedRate,
  lockedCost,
  gallonsVariance,
  gallonsVariancePct,
  costVariance,
  costVariancePct,
}: {
  status: CopackSyrupVarianceStatus | null;
  plannedGallons: number | null;
  plannedCost: number | null;
  lockedGallons: number | null;
  lockedRate: number | null;
  lockedCost: number | null;
  gallonsVariance: number | null;
  gallonsVariancePct: number | null;
  costVariance: number | null;
  costVariancePct: number | null;
}) {
  const effectiveStatus = status ?? 'pending';
  const tone = syrupVarianceTone(effectiveStatus);
  return (
    <section style={{
      marginBottom: 14,
      padding: 12,
      border: `1px solid ${tone.border}`,
      borderRadius: 4,
      background: tone.bg,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
          Syrup Variance
        </div>
        <span style={{
          color: tone.color,
          border: `1px solid ${tone.border}`,
          background: 'rgba(255,255,255,0.04)',
          padding: '1px 7px',
          borderRadius: 10,
          fontSize: 10,
          fontWeight: 700,
        }}>
          {SYRUP_VARIANCE_LABEL[effectiveStatus]}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, fontSize: 13 }}>
        <Kv label="BOM gal" value={plannedGallons == null ? '—' : fmtQty(plannedGallons, 'gal')} />
        <Kv label="Invoice gal" value={lockedGallons == null ? '—' : fmtQty(lockedGallons, 'gal')} />
        <Kv label="Gal delta" value={fmtDeltaQty(gallonsVariance, 'gal')} bold accent={effectiveStatus === 'alert'} />
        <Kv label="Gal delta %" value={fmtDeltaPct(gallonsVariancePct)} />
        <Kv label="BOM syrup $" value={plannedCost == null ? '—' : fm(plannedCost)} />
        <Kv label="Invoice syrup $" value={lockedCost == null ? '—' : fm(lockedCost)} />
        <Kv label="$ / gal" value={lockedRate == null ? '—' : `$${lockedRate.toFixed(4)}`} />
        <Kv label="$ delta" value={fmtDeltaMoney(costVariance)} bold accent={effectiveStatus === 'alert'} />
        <Kv label="$ delta %" value={fmtDeltaPct(costVariancePct)} />
      </div>
    </section>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 74 }}>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ marginTop: 2, fontSize: 12, fontWeight: 700, color: 'var(--tx)', fontFamily: 'var(--ff-mono)' }}>{value}</div>
    </div>
  );
}

function syrupVarianceTone(status: CopackSyrupVarianceStatus) {
  switch (status) {
    case 'alert':
      return { color: '#f87171', border: 'rgba(248,113,113,0.45)', bg: 'rgba(248,113,113,0.08)' };
    case 'watch':
      return { color: 'var(--am)', border: 'rgba(239,191,65,0.40)', bg: 'rgba(239,191,65,0.08)' };
    case 'ok':
      return { color: 'var(--gn)', border: 'rgba(125,238,164,0.35)', bg: 'rgba(125,238,164,0.06)' };
    case 'pending':
    default:
      return { color: 'var(--mt)', border: 'rgba(148,163,184,0.30)', bg: 'rgba(148,163,184,0.06)' };
  }
}

function fmtDeltaMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  if (Math.abs(n) < 0.005) return fm(0);
  return `${n > 0 ? '+' : ''}${fm(n)}`;
}

function fmtDeltaQty(value: number | null | undefined, uom: string): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  if (Math.abs(n) < 0.0001) return fmtQty(0, uom);
  return `${n > 0 ? '+' : ''}${fmtQty(n, uom)}`;
}

function fmtDeltaPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value) * 100;
  if (Math.abs(n) < 0.05) return '0.0%';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function PackEntryHelper({
  bom, label = 'Pack entry', onApply,
}: {
  bom: ProductBom;
  label?: string;
  onApply: (qty: number, uom: string) => void;
}) {
  const [entryQty, setEntryQty] = useState('');
  const [entryUnit, setEntryUnit] = useState<PackEntryUnit>('finished');
  const converted = useMemo(
    () => convertPackEntry(Number(entryQty), entryUnit, bom),
    [entryQty, entryUnit, bom],
  );

  return (
    <div style={{
      marginTop: 6,
      padding: 8,
      border: '1px solid rgba(255,255,255,0.09)',
      borderRadius: 4,
      background: 'rgba(255,255,255,0.025)',
    }}>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="number" min={0} step="any" style={{ ...inp(), flex: '1 1 72px', minWidth: 0 }} value={entryQty} onChange={(e) => setEntryQty(e.target.value)} />
        <select style={{ ...inp(), flex: '1 1 112px', minWidth: 0 }} value={entryUnit} onChange={(e) => setEntryUnit(e.target.value as PackEntryUnit)}>
          {PACK_ENTRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button type="button" style={{ ...btnSecondary(), padding: '4px 8px' }}
          disabled={!converted}
          onClick={() => converted && onApply(converted.qty, converted.uom)}>
          Use
        </button>
      </div>
      <div style={{
        marginTop: 5,
        fontSize: 10.5,
        color: converted ? 'var(--tx)' : 'var(--mt)',
        fontFamily: 'var(--ff-mono)',
      }}>
        {converted ? `= ${fmtQty(converted.qty, converted.uom)}` : '= -'}
      </div>
    </div>
  );
}

function bomLineToInputForReadiness(l: ProductBomLine): BomLineInput {
  return {
    line_type: l.line_type,
    component_qbo_item_id: l.component_qbo_item_id,
    service_label: l.service_label,
    qty_per: Number(l.qty_per),
    qty_uom: l.qty_uom || 'each',
    scrap_pct: Number(l.scrap_pct ?? 0),
    default_cost: l.default_cost == null ? null : Number(l.default_cost),
    notes: l.notes,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function convertPackEntry(qty: number, unit: PackEntryUnit, bom: ProductBom): { qty: number; uom: string } | null {
  if (!Number.isFinite(qty) || !(qty > 0)) return null;
  const cansPerFinishedUnit = Number(bom.cans_per_case || 0);
  const ozPerCan = Number(bom.oz_per_can || 0);
  if (!(cansPerFinishedUnit > 0) || !(ozPerCan > 0)) return null;

  const cans = unit === 'can' ? qty
    : unit === 'pack8' ? qty * 8
      : unit === 'pack24' ? qty * 24
        : qty * cansPerFinishedUnit;
  const finishedUnits = cans / cansPerFinishedUnit;
  const yieldUom = bom.yield_uom || 'each';
  if (yieldUom === 'each' || yieldUom === 'case') return { qty: finishedUnits, uom: yieldUom };

  return { qty: cans * ozPerCan / 128, uom: 'gal' };
}

function formatInputQty(v: number): string {
  if (!Number.isFinite(v)) return '';
  return String(Number(v.toFixed(6)));
}

function estimateFinishedUnits(qty: number, uom: string, bom: ProductBom): number | null {
  if (!Number.isFinite(qty) || !(qty > 0)) return null;
  const cansPerFinishedUnit = Number(bom.cans_per_case || 0);
  const ozPerCan = Number(bom.oz_per_can || 0);
  if (cansPerFinishedUnit > 0 && ozPerCan > 0) {
    const flOz = uom === 'gal' ? qty * 128
      : uom === 'fl_oz' ? qty
        : uom === 'L' ? qty * 33.8140227
          : uom === 'mL' ? qty * 0.0338140227
            : null;
    if (flOz != null) return flOz / (cansPerFinishedUnit * ozPerCan);
  }
  if (uom === 'each' || uom === 'case') return qty;
  return null;
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600,
  letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)',
};
const td: React.CSSProperties = { padding: '6px 10px', verticalAlign: 'middle' };
