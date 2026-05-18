import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Plus, X as XIcon, FileText } from 'lucide-react';
import {
  ProductBom, WorkOrder, WorkOrderCosts, WorkOrderStatus,
  closeWorkOrder, consumeWorkOrder, createWorkOrder,
  fetchBomLines, fetchWorkOrderCosts, voidWorkOrder,
  pushWorkOrderToQbo,
  ProductBomLine,
} from '../../lib/production';
import { InventoryLocation } from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { fmtNum, fm } from '../../lib/formatters';
import { GRID_SX } from '../stock/stockStyles';
import type { ProductionItemLookup } from './ProductionPage';

const STATUS_COLOR: Record<WorkOrderStatus, string> = {
  draft:    'var(--mt)',
  consumed: 'var(--am)',
  closed:   'var(--gn)',
  void:     '#64748b',
};

interface Props {
  workOrders: WorkOrder[] | null;
  boms: ProductBom[];
  bomById: Map<string, ProductBom>;
  locations: InventoryLocation[];
  locById: Map<string, InventoryLocation>;
  itemLookup: ProductionItemLookup;
  onChanged: () => void;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function WorkOrdersTab({
  workOrders, boms, bomById, locations, locById, itemLookup, onChanged,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | WorkOrderStatus>('all');

  const physicalLocs = useMemo(
    () => locations.filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment'),
    [locations],
  );

  const filtered = useMemo(() => {
    const list = workOrders ?? [];
    if (statusFilter === 'all') return list;
    return list.filter((w) => w.status === statusFilter);
  }, [workOrders, statusFilter]);

  const enriched = useMemo(() => filtered.map((w) => ({
    ...w,
    id: w.id,
    finished_label: itemLookup.byId.get(w.finished_qbo_item_id)?.item_name ?? w.finished_qbo_item_id,
    location_label: locById.get(w.production_location_id)?.code ?? '?',
  })), [filtered, itemLookup, locById]);

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'batch_code', headerName: 'WO #', width: 150,
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
        const v = String(p.value ?? '') as WorkOrderStatus;
        const c = STATUS_COLOR[v] ?? 'var(--mt)';
        return <span style={{
          background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
          padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
        }}>{v.toUpperCase()}</span>;
      },
    },
    { field: 'finished_label', headerName: 'Finished SKU', flex: 1, minWidth: 200,
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{String(p.value)}</span> },
    { field: 'qty_to_produce', headerName: 'Qty', type: 'number', width: 90, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)) },
    { field: 'qty_produced_actual', headerName: 'Actual', type: 'number', width: 90, cellClassName: 'mn',
      valueFormatter: (v) => v == null ? '—' : fmtNum(Number(v)) },
    { field: 'location_label', headerName: 'Location', width: 130 },
    { field: 'scheduled_date', headerName: 'Scheduled', width: 110,
      valueFormatter: (v) => v ? String(v) : '—' },
    { field: 'created_at', headerName: 'Created', width: 160,
      valueFormatter: (v) => v ? new Date(String(v)).toLocaleString() : '—' },
  ], []);

  const activeBoms = boms.filter((b) => b.is_active);

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="toolbar-section" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="toolbar-label">Status</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | WorkOrderStatus)} style={inp()}>
              <option value="all">All</option>
              <option value="draft">Draft</option>
              <option value="consumed">Consumed (WIP)</option>
              <option value="closed">Closed</option>
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
        <CreateWorkOrderForm
          boms={activeBoms}
          locations={physicalLocs}
          itemLookup={itemLookup}
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); onChanged(); }}
        />
      )}

      <div className="cd" style={{ padding: 0 }}>
        <DataGridPro
          rows={enriched}
          columns={columns}
          sx={GRID_SX}
          density="compact"
          loading={workOrders === null}
          initialState={{ sorting: { sortModel: [{ field: 'created_at', sort: 'desc' }] } }}
          disableRowSelectionOnClick
        />
      </div>

      {openId && (
        <WorkOrderDetailModal
          woId={openId}
          wo={(workOrders ?? []).find((w) => w.id === openId) ?? null}
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

// ── Create form ────────────────────────────────────────────────────────

function CreateWorkOrderForm({
  boms, locations, itemLookup, onCancel, onCreated,
}: {
  boms: ProductBom[];
  locations: InventoryLocation[];
  itemLookup: ProductionItemLookup;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [bomId, setBomId] = useState('');
  const [qty, setQty] = useState<string>('');
  const [locId, setLocId] = useState('');
  const [scheduled, setScheduled] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const canSave = !!bomId && Number(qty) > 0 && !!locId;
  const selectedBom = boms.find((b) => b.id === bomId);
  const selectedFinished = selectedBom ? itemLookup.byId.get(selectedBom.finished_qbo_item_id) : null;

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      await createWorkOrder({
        bom_id: bomId,
        qty_to_produce: Number(qty),
        production_location_id: locId,
        scheduled_date: scheduled || null,
        notes: notes || null,
      });
      toast.success('Work order created');
      onCreated();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="cd" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
          New Work Order
        </div>
        <button onClick={onCancel} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
          <XIcon size={14} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        <LField label="BOM">
          <select style={inp()} value={bomId} onChange={(e) => setBomId(e.target.value)}>
            <option value="">—</option>
            {boms.map((b) => {
              const it = itemLookup.byId.get(b.finished_qbo_item_id);
              return <option key={b.id} value={b.id}>
                {it?.item_name ?? b.finished_qbo_item_id} · v{b.version}
              </option>;
            })}
          </select>
        </LField>
        <LField label="Qty to produce">
          <input type="number" min={0.0001} step="any" style={inp()}
            value={qty} onChange={(e) => setQty(e.target.value)} />
        </LField>
        <LField label="Production location">
          <select style={inp()} value={locId} onChange={(e) => setLocId(e.target.value)}>
            <option value="">—</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
          </select>
        </LField>
        <LField label="Scheduled date">
          <input type="date" style={inp()} value={scheduled} onChange={(e) => setScheduled(e.target.value)} />
        </LField>
      </div>

      {selectedBom && (
        <div style={{
          marginTop: 12, padding: 10,
          background: 'rgba(91,181,240,0.04)', border: '1px solid var(--bd)', borderRadius: 4,
          fontSize: 11, color: 'var(--mt)',
        }}>
          BOM yield: <strong style={{ color: 'var(--tx)' }}>{selectedBom.yield_qty}</strong> {selectedFinished?.item_name ?? ''} per batch
          {Number(qty) > 0 && <> · running <strong style={{ color: 'var(--tx)' }}>{(Number(qty) / Number(selectedBom.yield_qty)).toFixed(2)}</strong> batches</>}
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
          {saving ? 'Creating…' : 'Create as Draft'}
        </button>
      </div>
    </div>
  );
}

// ── Detail modal ───────────────────────────────────────────────────────

function WorkOrderDetailModal({
  woId, wo, bomById, locById, itemLookup, onClose, onChanged,
}: {
  woId: string;
  wo: WorkOrder | null;
  bomById: Map<string, ProductBom>;
  locById: Map<string, InventoryLocation>;
  itemLookup: ProductionItemLookup;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [bomLines, setBomLines] = useState<ProductBomLine[] | null>(null);
  const [costs, setCosts] = useState<WorkOrderCosts | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    if (wo) {
      fetchBomLines(wo.bom_id).then((ls) => alive && setBomLines(ls)).catch(() => alive && setBomLines([]));
    }
    fetchWorkOrderCosts(woId).then((c) => alive && setCosts(c)).catch(() => alive && setCosts(null));
    return () => { alive = false; };
  }, [woId, wo]);

  if (!wo) return null;

  const bom = bomById.get(wo.bom_id);
  const loc = locById.get(wo.production_location_id);
  const finished = itemLookup.byId.get(wo.finished_qbo_item_id);
  const batches = bom ? Number(wo.qty_to_produce) / Number(bom.yield_qty) : 0;

  async function doConsume() {
    if (!confirm(`Consume components for ${wo!.batch_code}?\n\nThis will deduct each component's qty from ${loc?.code ?? 'production location'}. Movements are append-only — to reverse, void this WO (only available from draft) or create offsetting adjustments.`)) return;
    setBusy(true);
    try {
      await consumeWorkOrder(woId);
      toast.success('Components consumed');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doClose() {
    const actualStr = prompt(
      `Close ${wo!.batch_code} — finished qty produced?\n\n` +
      `Target was ${wo!.qty_to_produce}. Enter actual yield.`,
      String(wo!.qty_to_produce)
    );
    if (actualStr == null) return;
    const actual = Number(actualStr);
    if (!Number.isFinite(actual) || actual <= 0) {
      toast.error('Invalid qty');
      return;
    }
    setBusy(true);
    try {
      await closeWorkOrder(woId, actual);
      toast.success('Closed · finished good added · cost snapshot locked');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doPushToQbo() {
    if (!confirm(
      'Push this work order to QuickBooks as an InventoryAdjustment?\n\n' +
      'This will create a single adjustment record in QBO with:\n' +
      '  • Negative quantity for each component consumed\n' +
      '  • Positive quantity for the finished good produced\n\n' +
      'Only Inventory-tracked items are pushed; Service / NonInventory components are skipped.\n\n' +
      'The push is idempotent — once successful, this button hides.'
    )) return;
    setBusy(true);
    try {
      const result = await pushWorkOrderToQbo(woId);
      if (result.no_change) {
        toast.info('Already synced to QBO.');
      } else {
        toast.success(
          `Pushed to QBO as InventoryAdjustment #${result.qbo_inventory_adjustment_id}` +
          (result.skipped && result.skipped.length > 0
            ? ` (${result.skipped.length} non-inventory items skipped)`
            : ''),
        );
      }
      onChanged();
    } catch (e) { toast.error('QBO push failed: ' + errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doVoid() {
    const reason = prompt('Void reason?');
    if (!reason) return;
    setBusy(true);
    try {
      await voidWorkOrder(woId, reason);
      toast.success('Voided');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  function printSummary() {
    if (!wo || !bom) return;
    const w = window.open('', '_blank');
    if (!w) return;
    const lines = (costs?.detail ?? []).map((d, i) => `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(d.label)}</td>
      <td>${d.kind}</td>
      <td style="text-align:right">${fmtNum(Number(d.qty))}</td>
      <td style="text-align:right">${d.unit_cost == null ? '—' : `$${Number(d.unit_cost).toFixed(4)}`}</td>
      <td style="text-align:right">$${Number(d.extended_cost).toFixed(2)}</td>
    </tr>`).join('');
    w.document.write(`<html><head><title>WO ${wo.batch_code}</title>
      <style>
        @page{size:letter;margin:0.5in}
        body{font-family:system-ui,sans-serif;color:#0a0e17;font-size:11px;margin:0}
        h1{font-size:20px;border-bottom:3px solid #0a0e17;padding-bottom:6px;margin:0 0 12px}
        .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;font-size:11px}
        .kv{border:1px solid #0a0e17;padding:5px 8px}
        .lbl{font-size:8px;font-weight:700;letter-spacing:1px;color:#475569;text-transform:uppercase}
        table{width:100%;border-collapse:collapse;font-size:10.5px;border:1px solid #0a0e17;margin-top:10px}
        th{background:#0a0e17;color:#fff;padding:4px 6px;font-size:8.5px;text-align:left;text-transform:uppercase;letter-spacing:1px}
        td{padding:4px 6px;border-bottom:1px solid #e2e8f0}
        tr:nth-child(even) td{background:#f8fafc}
        tfoot td{background:#0a0e17;color:#fff;font-weight:700;border:none}
      </style></head><body>
      <h1>Work Order · ${escapeHtml(wo.batch_code)}</h1>
      <div class="meta">
        <div class="kv"><div class="lbl">Finished SKU</div>${escapeHtml(finished?.item_name ?? wo.finished_qbo_item_id)}</div>
        <div class="kv"><div class="lbl">BOM</div>v${escapeHtml(bom.version)} · yield ${bom.yield_qty}/batch</div>
        <div class="kv"><div class="lbl">Qty target / actual</div>${fmtNum(Number(wo.qty_to_produce))} / ${wo.qty_produced_actual == null ? '—' : fmtNum(Number(wo.qty_produced_actual))}</div>
        <div class="kv"><div class="lbl">Production location</div>${escapeHtml(loc?.name ?? '?')} · ${escapeHtml(loc?.code ?? '')}</div>
        <div class="kv"><div class="lbl">Status</div>${wo.status.toUpperCase()}</div>
        <div class="kv"><div class="lbl">Scheduled / Closed</div>${escapeHtml(wo.scheduled_date ?? '—')} / ${wo.closed_at ? new Date(wo.closed_at).toLocaleDateString() : '—'}</div>
      </div>
      ${costs ? `<table>
        <thead><tr><th>#</th><th>Item / Service</th><th>Kind</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit $</th><th style="text-align:right">Extended $</th></tr></thead>
        <tbody>${lines}</tbody>
        <tfoot>
          <tr><td colspan="5" style="text-align:right">Components</td><td style="text-align:right">$${Number(costs.components_cost).toFixed(2)}</td></tr>
          <tr><td colspan="5" style="text-align:right">Services</td><td style="text-align:right">$${Number(costs.services_cost).toFixed(2)}</td></tr>
          <tr><td colspan="5" style="text-align:right">TOTAL</td><td style="text-align:right">$${Number(costs.total_cost).toFixed(2)}</td></tr>
          <tr><td colspan="5" style="text-align:right">UNIT COST (÷ ${fmtNum(Number(costs.qty_produced))})</td><td style="text-align:right">${costs.unit_cost == null ? '—' : `$${Number(costs.unit_cost).toFixed(4)}`}</td></tr>
        </tfoot>
      </table>` : '<div style="color:#94a3b8;font-style:italic">Cost rollup not yet computed (close the work order to snapshot).</div>'}
      <script>setTimeout(function(){window.print()},300);</script>
    </body></html>`);
    w.document.close();
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '90px 20px 20px', overflowY: 'auto',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
        maxWidth: 940, width: '100%', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto', padding: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
              Work Order · {wo.status.toUpperCase()}
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 22, fontFamily: 'var(--ff-mono)', color: 'var(--ac)' }}>
              {wo.batch_code}
            </h2>
            <div style={{ marginTop: 4, color: 'var(--tx)', fontSize: 13 }}>
              {finished?.item_name ?? wo.finished_qbo_item_id}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
            <XIcon size={18} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, fontSize: 12, marginBottom: 14 }}>
          <Meta label="BOM" value={bom ? `v${bom.version} · yield ${bom.yield_qty}/batch` : '?'} />
          <Meta label="Qty (target / actual)" value={`${fmtNum(Number(wo.qty_to_produce))} / ${wo.qty_produced_actual == null ? '—' : fmtNum(Number(wo.qty_produced_actual))}`} />
          <Meta label="Batches" value={batches > 0 ? batches.toFixed(2) : '—'} />
          <Meta label="Location" value={loc ? `${loc.code} — ${loc.name}` : '?'} />
          <Meta label="Scheduled" value={wo.scheduled_date ?? '—'} />
          <Meta label="Closed" value={wo.closed_at ? new Date(wo.closed_at).toLocaleString() : '—'} />
        </div>

        {/* Cost rollup */}
        {costs && (
          <div style={{
            marginBottom: 14, padding: 12,
            background: 'rgba(125,238,164,0.06)', border: '1px solid rgba(125,238,164,0.20)', borderRadius: 4,
          }}>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 }}>
              Cost rollup · locked {new Date(costs.computed_at).toLocaleString()}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 13 }}>
              <Kv label="Components" value={fm(Number(costs.components_cost))} />
              <Kv label="Services"   value={fm(Number(costs.services_cost))} />
              <Kv label="Total"      value={fm(Number(costs.total_cost))} bold />
              <Kv label="Unit cost"  value={costs.unit_cost == null ? '—' : `$${Number(costs.unit_cost).toFixed(4)}`} bold accent />
            </div>
            {costs.detail.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 10 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                    <th style={cellTh}>Item / Service</th>
                    <th style={{ ...cellTh, textAlign: 'right' }}>Qty</th>
                    <th style={{ ...cellTh, textAlign: 'right' }}>Unit $</th>
                    <th style={{ ...cellTh, textAlign: 'right' }}>Extended</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.detail.map((d, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={cellTd}>
                        <strong>{d.label}</strong>
                        <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{d.kind}</span>
                      </td>
                      <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(d.qty))}</td>
                      <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                        {d.unit_cost == null ? '—' : `$${Number(d.unit_cost).toFixed(4)}`}
                      </td>
                      <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fm(Number(d.extended_cost))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* BOM lines preview (planned consumption) */}
        {wo.status !== 'closed' && bomLines && (
          <>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
              Planned consumption (for this WO)
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                  <th style={cellTh}>Component / Service</th>
                  <th style={{ ...cellTh, textAlign: 'right' }}>Qty / yield</th>
                  <th style={{ ...cellTh, textAlign: 'right' }}>Scrap %</th>
                  <th style={{ ...cellTh, textAlign: 'right' }}>Qty for WO</th>
                  <th style={{ ...cellTh, textAlign: 'right' }}>Est unit $</th>
                </tr>
              </thead>
              <tbody>
                {bomLines.map((l) => {
                  const label = l.line_type === 'component'
                    ? (itemLookup.byId.get(l.component_qbo_item_id ?? '')?.item_name ?? l.component_qbo_item_id ?? '?')
                    : l.service_label ?? '?';
                  const baseUnit = l.line_type === 'component'
                    ? (l.default_cost ?? itemLookup.byId.get(l.component_qbo_item_id ?? '')?.purchase_cost ?? null)
                    : l.default_cost;
                  const qtyForWo = batches * Number(l.qty_per) * (1 + Number(l.scrap_pct));
                  return (
                    <tr key={l.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={cellTd}>
                        <strong>{label}</strong>
                        <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{l.line_type}</span>
                      </td>
                      <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(Number(l.qty_per))}</td>
                      <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                        {(Number(l.scrap_pct) * 100).toFixed(1)}%
                      </td>
                      <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(qtyForWo)}</td>
                      <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                        {baseUnit == null ? '—' : `$${Number(baseUnit).toFixed(4)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        {wo.notes && (
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--mt)' }}>
            <div style={{ fontSize: 9, letterSpacing: 0.6, textTransform: 'uppercase' }}>Notes</div>
            {wo.notes}
          </div>
        )}

        {wo.status === 'closed' && wo.qbo_inventory_adjustment_id && (
          <div style={{
            marginTop: 14, padding: '8px 12px', fontSize: 11,
            background: 'rgba(91,181,240,0.08)', borderLeft: '3px solid var(--ac)',
            borderRadius: 4, color: 'var(--tx2)',
          }}>
            ✓ Synced to QBO as InventoryAdjustment <code style={{ color: 'var(--ac)' }}>#{wo.qbo_inventory_adjustment_id}</code>
            {wo.qbo_pushed_at && (
              <span style={{ marginLeft: 8, color: 'var(--mt)' }}>
                · {new Date(wo.qbo_pushed_at).toLocaleString()}
              </span>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
          <button onClick={printSummary} style={btnSecondary()}>
            <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Print
          </button>
          {wo.status === 'draft' && (
            <>
              <button onClick={doVoid} disabled={busy} style={btnDanger()}>Void</button>
              <button onClick={doConsume} disabled={busy} style={btnPrimary()}>Consume components →</button>
            </>
          )}
          {wo.status === 'consumed' && (
            <button onClick={doClose} disabled={busy} style={btnPrimary()}>Close + lock costs →</button>
          )}
          {wo.status === 'closed' && !wo.qbo_inventory_adjustment_id && (
            <button onClick={doPushToQbo} disabled={busy} style={btnPrimary()}
              title="Post an InventoryAdjustment to QBO with the consume + yield deltas from this work order">
              Push to QBO →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

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

const cellTh: React.CSSProperties = { textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600,
  letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)' };
const cellTd: React.CSSProperties = { padding: '6px 10px', verticalAlign: 'middle' };
