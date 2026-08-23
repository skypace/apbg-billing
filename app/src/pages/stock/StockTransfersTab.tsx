import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Plus, FileText, X as XIcon, Trash2 } from 'lucide-react';
import {
  FreightTerms,
  InventoryLocation,
  InventoryTransfer,
  InventoryTransferLine,
  InventoryTransferLineInput,
  TransferStatus,
  createTransfer,
  fetchTransferLines,
  receiveTransfer,
  shipTransfer,
  updateTransferFreight,
  voidTransfer,
} from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';
import { GRID_SX, GRID_DEFAULTS, STATUS_COLOR } from './stockStyles';
import type { ItemLookup } from './StockPage';

interface Props {
  transfers: InventoryTransfer[] | null;
  locations: InventoryLocation[];
  locationById: Map<string, InventoryLocation>;
  itemLookup: ItemLookup;
  onChanged: () => void;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function StockTransfersTab({ transfers, locations, locationById, itemLookup, onChanged }: Props) {
  const [creating, setCreating] = useState(false);
  const [openTransferId, setOpenTransferId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | TransferStatus>('all');

  const physicalLocs = useMemo(
    () => locations.filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment'),
    [locations],
  );

  const filtered = useMemo(() => {
    const list = transfers ?? [];
    if (statusFilter === 'all') return list;
    return list.filter((t) => t.status === statusFilter);
  }, [transfers, statusFilter]);

  const enriched = useMemo(() => filtered.map((t) => ({
    ...t,
    id: t.id,
    from_label: locationById.get(t.from_location_id)?.code ?? '?',
    to_label:   locationById.get(t.to_location_id)?.code   ?? '?',
  })), [filtered, locationById]);

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'bol_number',
      headerName: 'BOL #',
      width: 160,
      renderCell: (p) => (
        <button
          onClick={() => setOpenTransferId(String(p.row.id))}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontWeight: 600,
            padding: 0, fontSize: 12,
          }}
        >{String(p.value ?? '')}</button>
      ),
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 120,
      renderCell: (p) => {
        const v = String(p.value ?? '');
        const c = STATUS_COLOR[v] ?? 'var(--mt)';
        return (
          <span style={{
            background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
            padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
          }}>{v.replace('_', ' ').toUpperCase()}</span>
        );
      },
    },
    { field: 'from_label', headerName: 'From',     width: 140 },
    { field: 'to_label',   headerName: 'To',       width: 140 },
    { field: 'carrier',    headerName: 'Carrier',  flex: 1, minWidth: 140,
      valueFormatter: (v) => (v ? String(v) : '—') },
    { field: 'ship_date',  headerName: 'Shipped',  width: 110,
      valueFormatter: (v) => (v ? String(v) : '—') },
    { field: 'received_date', headerName: 'Received', width: 110,
      valueFormatter: (v) => (v ? String(v) : '—') },
    { field: 'created_at', headerName: 'Created',  width: 160,
      valueFormatter: (v) => v ? new Date(String(v)).toLocaleString() : '—' },
  ], []);

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="toolbar-section" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="toolbar-label">Status</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | TransferStatus)}
              style={inp()}>
              <option value="all">All</option>
              <option value="draft">Draft</option>
              <option value="in_transit">In Transit</option>
              <option value="received">Received</option>
              <option value="void">Void</option>
            </select>
          </div>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button onClick={() => setCreating(true)} style={btnPrimary()}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> New Transfer
          </button>
        </div>
      </div>

      {creating && (
        <CreateTransferForm
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
          {...GRID_DEFAULTS}
          sx={GRID_SX}
          density="compact"
          loading={transfers === null}
          initialState={{ sorting: { sortModel: [{ field: 'created_at', sort: 'desc' }] } }}
          disableRowSelectionOnClick
        />
      </div>

      {openTransferId && (
        <TransferDetailModal
          transferId={openTransferId}
          transfer={(transfers ?? []).find((t) => t.id === openTransferId) ?? null}
          locationById={locationById}
          itemLookup={itemLookup}
          onClose={() => setOpenTransferId(null)}
          onChanged={() => { setOpenTransferId(null); onChanged(); }}
        />
      )}
    </div>
  );
}

// ── Create form ─────────────────────────────────────────────────────────

function CreateTransferForm({ locations, itemLookup, onCancel, onCreated }: {
  locations: InventoryLocation[];
  itemLookup: ItemLookup;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [proNumber, setProNumber] = useState('');
  const [freightTerms, setFreightTerms] = useState<FreightTerms | ''>('');
  const [specialInstructions, setSpecialInstructions] = useState('');
  const [notes, setNotes] = useState('');
  const [totalWeightOverride, setTotalWeightOverride] = useState<string>('');
  const [totalPalletsOverride, setTotalPalletsOverride] = useState<string>('');
  const [declaredValueOverride, setDeclaredValueOverride] = useState<string>('');
  const [lines, setLines] = useState<InventoryTransferLineInput[]>([
    { qbo_item_id: '', qty: 1, unit_cost: null, notes: null, line_weight_lbs: null, line_pallets: null },
  ]);
  const [saving, setSaving] = useState(false);

  // Auto-suggested totals (each line's computed weight / pallets / value).
  const suggested = useMemo(() => {
    let weight = 0, pallets = 0, value = 0, anyData = false;
    for (const l of lines) {
      if (!l.qbo_item_id || !(Number(l.qty) > 0)) continue;
      const it = itemLookup.byId.get(l.qbo_item_id);
      const qty = Number(l.qty);
      const w = l.line_weight_lbs ?? (it?.weight_per_unit_lbs ? Number(it.weight_per_unit_lbs) * qty : null);
      const p = l.line_pallets ?? (it?.units_per_pallet ? qty / Number(it.units_per_pallet) : null);
      const uc = l.unit_cost ?? (it?.purchase_cost ? Number(it.purchase_cost) : null);
      if (w != null) { weight += w; anyData = true; }
      if (p != null) { pallets += p; anyData = true; }
      if (uc != null) { value += uc * qty; anyData = true; }
    }
    return { weight, pallets, value, anyData };
  }, [lines, itemLookup]);

  const canSave =
    !!from && !!to && from !== to &&
    lines.length > 0 &&
    lines.every((l) => l.qbo_item_id && Number(l.qty) > 0);

  function addLine() {
    setLines([...lines, { qbo_item_id: '', qty: 1, unit_cost: null, notes: null, line_weight_lbs: null, line_pallets: null }]);
  }
  function rmLine(i: number) {
    setLines(lines.filter((_, idx) => idx !== i));
  }
  function patchLine(i: number, patch: Partial<InventoryTransferLineInput>) {
    setLines(lines.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  }
  function pickItem(i: number, id: string) {
    const it = itemLookup.byId.get(id);
    // Snap unit_cost from item default if not already set
    const patch: Partial<InventoryTransferLineInput> = { qbo_item_id: id };
    if (lines[i].unit_cost == null && it?.purchase_cost != null) {
      patch.unit_cost = Number(it.purchase_cost);
    }
    patchLine(i, patch);
  }

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      await createTransfer({
        from_location_id: from,
        to_location_id: to,
        lines,
        carrier: carrier || null,
        tracking_number: tracking || null,
        notes: notes || null,
        pro_number: proNumber || null,
        freight_terms: (freightTerms || null) as FreightTerms | null,
        total_weight_lbs:   totalWeightOverride   !== '' ? Number(totalWeightOverride)   : (suggested.anyData ? round1(suggested.weight)   : null),
        total_pallets:      totalPalletsOverride  !== '' ? Number(totalPalletsOverride)  : (suggested.anyData ? round2(suggested.pallets)  : null),
        declared_value_usd: declaredValueOverride !== '' ? Number(declaredValueOverride) : (suggested.anyData ? round2(suggested.value)    : null),
        special_instructions: specialInstructions || null,
      });
      toast.success('Transfer created');
      onCreated();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cd" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
          New Transfer
        </div>
        <button onClick={onCancel} style={{
          background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)',
        }} aria-label="Cancel">
          <XIcon size={14} />
        </button>
      </div>

      {/* Route */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        <LField label="From">
          <select style={inp()} value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">—</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
          </select>
        </LField>
        <LField label="To">
          <select style={inp()} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">—</option>
            {locations.filter((l) => l.id !== from).map((l) =>
              <option key={l.id} value={l.id}>{l.code} — {l.name}</option>
            )}
          </select>
        </LField>
      </div>

      {/* Freight */}
      <div style={{ marginTop: 14, fontSize: 10, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>
        Freight
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <LField label="Carrier">
          <input style={inp()} value={carrier} onChange={(e) => setCarrier(e.target.value)}
            placeholder="Internal / UPS Freight / XPO" />
        </LField>
        <LField label="Tracking #">
          <input style={inp()} value={tracking} onChange={(e) => setTracking(e.target.value)} />
        </LField>
        <LField label="PRO #">
          <input style={inp()} value={proNumber} onChange={(e) => setProNumber(e.target.value)}
            placeholder="Carrier PRO" />
        </LField>
        <LField label="Freight terms">
          <select style={inp()} value={freightTerms}
            onChange={(e) => setFreightTerms(e.target.value as FreightTerms | '')}>
            <option value="">—</option>
            <option value="prepaid">Prepaid</option>
            <option value="collect">Collect</option>
            <option value="third_party">Third Party</option>
          </select>
        </LField>
      </div>

      {/* Totals (auto-suggest + override) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginTop: 8 }}>
        <LField label={`Total weight (lb)${suggested.anyData ? ` · auto ${round1(suggested.weight)}` : ''}`}>
          <input type="number" min={0} step="any" style={inp()}
            value={totalWeightOverride} onChange={(e) => setTotalWeightOverride(e.target.value)}
            placeholder={suggested.anyData ? round1(suggested.weight).toString() : '—'} />
        </LField>
        <LField label={`Total pallets${suggested.anyData ? ` · auto ${round2(suggested.pallets)}` : ''}`}>
          <input type="number" min={0} step="any" style={inp()}
            value={totalPalletsOverride} onChange={(e) => setTotalPalletsOverride(e.target.value)}
            placeholder={suggested.anyData ? round2(suggested.pallets).toString() : '—'} />
        </LField>
        <LField label={`Declared value (USD)${suggested.anyData ? ` · auto ${fmCurrencyShort(suggested.value)}` : ''}`}>
          <input type="number" min={0} step="any" style={inp()}
            value={declaredValueOverride} onChange={(e) => setDeclaredValueOverride(e.target.value)}
            placeholder={suggested.anyData ? round2(suggested.value).toString() : '—'} />
        </LField>
      </div>

      <div style={{ marginTop: 10 }}>
        <LField label="Special instructions">
          <input style={inp()} value={specialInstructions}
            onChange={(e) => setSpecialInstructions(e.target.value)}
            placeholder="Liftgate required / Call before delivery / Keep frozen / etc." />
        </LField>
      </div>

      {/* Lines */}
      <div style={{ marginTop: 14, fontSize: 10, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>
        Lines
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bd)' }}>
            <th style={cellTh}>Item</th>
            <th style={{ ...cellTh, width: 80,  textAlign: 'right' }}>Qty</th>
            <th style={{ ...cellTh, width: 90,  textAlign: 'right' }}>Wt (lb)</th>
            <th style={{ ...cellTh, width: 80,  textAlign: 'right' }}>Pallets</th>
            <th style={{ ...cellTh, width: 100, textAlign: 'right' }}>Unit Cost</th>
            <th style={{ ...cellTh, width: 150 }}>Notes</th>
            <th style={{ ...cellTh, width: 36 }}> </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const it = l.qbo_item_id ? itemLookup.byId.get(l.qbo_item_id) : null;
            const computedWt = (l.line_weight_lbs != null)
              ? l.line_weight_lbs
              : (it?.weight_per_unit_lbs ? Number(it.weight_per_unit_lbs) * Number(l.qty) : null);
            const computedPal = (l.line_pallets != null)
              ? l.line_pallets
              : (it?.units_per_pallet ? Number(l.qty) / Number(it.units_per_pallet) : null);
            const wtPlaceholder = computedWt != null && l.line_weight_lbs == null ? round1(Number(computedWt)).toString() : '';
            const palPlaceholder = computedPal != null && l.line_pallets == null ? round2(Number(computedPal)).toString() : '';
            return (
              <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={cellTd}>
                  <ItemPicker
                    value={l.qbo_item_id}
                    options={itemLookup.options}
                    onChange={(id) => pickItem(i, id)}
                  />
                  {it?.freight_class && (
                    <div style={{ marginTop: 3, fontSize: 9, color: 'var(--mt)', letterSpacing: 0.4 }}>
                      Class {it.freight_class}{it.weight_per_unit_lbs ? ` · ${it.weight_per_unit_lbs} lb/unit` : ''}{it.units_per_pallet ? ` · ${it.units_per_pallet} u/pallet` : ''}
                    </div>
                  )}
                </td>
                <td style={{ ...cellTd, textAlign: 'right' }}>
                  <input type="number" min={0.0001} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }}
                    value={l.qty} onChange={(e) => patchLine(i, { qty: Number(e.target.value) })} />
                </td>
                <td style={{ ...cellTd, textAlign: 'right' }}>
                  <input type="number" min={0} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }}
                    value={l.line_weight_lbs ?? ''}
                    placeholder={wtPlaceholder}
                    onChange={(e) => patchLine(i, { line_weight_lbs: e.target.value === '' ? null : Number(e.target.value) })} />
                </td>
                <td style={{ ...cellTd, textAlign: 'right' }}>
                  <input type="number" min={0} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }}
                    value={l.line_pallets ?? ''}
                    placeholder={palPlaceholder}
                    onChange={(e) => patchLine(i, { line_pallets: e.target.value === '' ? null : Number(e.target.value) })} />
                </td>
                <td style={{ ...cellTd, textAlign: 'right' }}>
                  <input type="number" min={0} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }}
                    value={l.unit_cost ?? ''} onChange={(e) => patchLine(i, { unit_cost: e.target.value === '' ? null : Number(e.target.value) })} />
                </td>
                <td style={cellTd}>
                  <input style={inp()} value={l.notes ?? ''}
                    onChange={(e) => patchLine(i, { notes: e.target.value || null })} />
                </td>
                <td style={{ ...cellTd, textAlign: 'right' }}>
                  <button onClick={() => rmLine(i)} aria-label="Remove line"
                    disabled={lines.length === 1}
                    style={{
                      background: 'transparent', border: 'none',
                      cursor: lines.length === 1 ? 'not-allowed' : 'pointer',
                      color: lines.length === 1 ? 'var(--mt)' : 'var(--rd)',
                      opacity: lines.length === 1 ? 0.4 : 1, padding: 4,
                    }}><Trash2 size={13} /></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <button onClick={addLine} style={{ ...btnSecondary(), marginTop: 8 }}>+ Add line</button>

      <div style={{ marginTop: 14 }}>
        <LField label="Notes (header)">
          <textarea rows={2} style={{ ...inp(), width: '100%', resize: 'vertical', minHeight: 40 }}
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

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function fmCurrencyShort(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

// ── Detail modal (view + ship/receive/void) ────────────────────────────

function TransferDetailModal({
  transferId, transfer, locationById, itemLookup, onClose, onChanged,
}: {
  transferId: string;
  transfer: InventoryTransfer | null;
  locationById: Map<string, InventoryLocation>;
  itemLookup: ItemLookup;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [lines, setLines] = useState<InventoryTransferLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const laneItemIds = useMemo(() => new Set(itemLookup.options.map((option) => option.id)), [itemLookup]);

  useEffect(() => {
    let alive = true;
    setLines(null);
    fetchTransferLines(transferId)
      .then((ls) => { if (alive) setLines(ls.filter((line) => laneItemIds.has(line.qbo_item_id))); })
      .catch(() => { if (alive) setLines([]); });
    return () => { alive = false; };
  }, [transferId, laneItemIds]);

  if (!transfer) {
    return null;
  }

  const fromLoc = locationById.get(transfer.from_location_id);
  const toLoc   = locationById.get(transfer.to_location_id);
  const status  = transfer.status;
  const editable = status === 'draft' || status === 'in_transit';

  // Compute totals from lines + item lookup. Header overrides win when set.
  const lineTotals = useMemo(() => {
    let wt = 0, pal = 0, val = 0, anyData = false;
    for (const l of (lines ?? [])) {
      const it = itemLookup.byId.get(l.qbo_item_id);
      const w = l.line_weight_lbs ?? (it?.weight_per_unit_lbs ? Number(it.weight_per_unit_lbs) * Number(l.qty) : null);
      const p = l.line_pallets ?? (it?.units_per_pallet ? Number(l.qty) / Number(it.units_per_pallet) : null);
      const uc = l.unit_cost ?? (it?.purchase_cost ? Number(it.purchase_cost) : null);
      if (w != null) { wt += w; anyData = true; }
      if (p != null) { pal += p; anyData = true; }
      if (uc != null) { val += uc * Number(l.qty); anyData = true; }
    }
    return { wt, pal, val, anyData };
  }, [lines, itemLookup]);

  const displayWeight  = transfer.total_weight_lbs   ?? (lineTotals.anyData ? round1(lineTotals.wt)  : null);
  const displayPallets = transfer.total_pallets      ?? (lineTotals.anyData ? round2(lineTotals.pal) : null);
  const displayValue   = transfer.declared_value_usd ?? (lineTotals.anyData ? round2(lineTotals.val) : null);

  async function doShip() {
    if (!confirm(`Mark shipped and decrement ${fromLoc?.code ?? 'source'}?\n\nThe printed BOL has blank signature lines for wet-ink signing.`)) return;
    setBusy(true);
    try {
      await shipTransfer(transferId);
      toast.success('Marked shipped');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }
  async function doReceive() {
    if (!confirm(`Mark received and increment ${toLoc?.code ?? 'destination'}?\n\nThe printed BOL has blank signature lines for wet-ink signing.`)) return;
    setBusy(true);
    try {
      await receiveTransfer(transferId);
      toast.success('Marked received');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }
  async function doVoid() {
    const reason = prompt('Void reason?');
    if (!reason) return;
    setBusy(true);
    try {
      await voidTransfer(transferId, reason);
      toast.success('Voided');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function patchHeader(patch: Parameters<typeof updateTransferFreight>[1]) {
    setBusy(true);
    try {
      await updateTransferFreight(transferId, patch);
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  function printBol() {
    const t = transfer;
    if (!t) return;
    const w = window.open('', '_blank');
    if (!w) return;

    const lineRows = (lines ?? []).map((l, idx) => {
      const it = itemLookup.byId.get(l.qbo_item_id);
      const qty = Number(l.qty);
      const wt = l.line_weight_lbs ?? (it?.weight_per_unit_lbs ? Number(it.weight_per_unit_lbs) * qty : null);
      const pal = l.line_pallets ?? (it?.units_per_pallet ? qty / Number(it.units_per_pallet) : null);
      const dim = (it?.dim_l_in && it?.dim_w_in && it?.dim_h_in)
        ? `${it.dim_l_in}×${it.dim_w_in}×${it.dim_h_in}"`
        : '';
      const unitType = it?.unit_type ? ` ${it.unit_type}` : '';
      return `<tr>
        <td style="width:22px;color:#64748b">${idx + 1}</td>
        <td>${escapeHtml(it?.item_name ?? l.qbo_item_id)}${dim || unitType ? `<div style="font-size:9px;color:#64748b;margin-top:2px">${escapeHtml(dim)}${escapeHtml(unitType)}</div>` : ''}${l.notes ? `<div style="font-size:9px;color:#64748b;margin-top:2px">${escapeHtml(l.notes)}</div>` : ''}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtNum(qty)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${wt == null ? '—' : round1(wt).toString()}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${pal == null ? '—' : round2(pal).toString()}</td>
        <td style="text-align:center">${escapeHtml(it?.freight_class ?? '—')}</td>
        <td style="text-align:center;font-family:monospace;font-size:9.5px">${escapeHtml(it?.nmfc_code ?? '—')}</td>
      </tr>`;
    }).join('');

    const totWt = t.total_weight_lbs   ?? (lineTotals.anyData ? round1(lineTotals.wt)  : null);
    const totPal = t.total_pallets      ?? (lineTotals.anyData ? round2(lineTotals.pal) : null);
    const totVal = t.declared_value_usd ?? (lineTotals.anyData ? round2(lineTotals.val) : null);
    const totQty = (lines ?? []).reduce((s, l) => s + Number(l.qty), 0);

    const fmtAddr = (loc?: InventoryLocation) => {
      if (!loc) return '';
      const parts = [loc.address_line1, [loc.city, loc.state, loc.postal_code].filter(Boolean).join(', ')].filter(Boolean);
      return parts.map((p) => `<div>${escapeHtml(p as string)}</div>`).join('');
    };

    const termsLabel = t.freight_terms === 'prepaid' ? 'PREPAID'
                    : t.freight_terms === 'collect' ? 'COLLECT'
                    : t.freight_terms === 'third_party' ? 'THIRD PARTY' : '—';

    w.document.write(`<html><head><title>BOL ${t.bol_number}</title>
      <style>
        @page { size: letter; margin: 0.5in; }
        *{box-sizing:border-box}
        body{font-family:system-ui,-apple-system,sans-serif;color:#0a0e17;margin:0;padding:0;font-size:11px;line-height:1.4}
        .doc{max-width:7.5in;margin:0 auto}
        .hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0a0e17;padding-bottom:8px;margin-bottom:12px}
        .hdr h1{margin:0;font-size:20px;letter-spacing:1px}
        .hdr .subtitle{font-size:9px;color:#64748b;letter-spacing:1.5px;text-transform:uppercase}
        .hdr .right{text-align:right}
        .hdr .right .bol{font-family:monospace;font-size:17px;font-weight:700;letter-spacing:1px}
        .hdr .right .stamp{display:inline-block;border:2px solid #0a0e17;padding:2px 10px;font-size:10px;font-weight:700;letter-spacing:1px;margin-top:3px}
        .row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px}
        .box{border:1px solid #0a0e17;padding:6px 8px;min-height:90px}
        .box .lbl{font-size:8px;font-weight:700;letter-spacing:1.5px;color:#475569;text-transform:uppercase;border-bottom:1px solid #cbd5e1;padding-bottom:2px;margin-bottom:4px}
        .box .big{font-size:12px;font-weight:600;margin-bottom:2px}
        .row4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:10px}
        .kv{border:1px solid #0a0e17;padding:5px 8px}
        .kv .lbl{font-size:8px;font-weight:700;letter-spacing:1px;color:#475569;text-transform:uppercase}
        .kv .val{font-size:12px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}
        table.items{width:100%;border-collapse:collapse;border:1px solid #0a0e17;font-size:10.5px}
        table.items th{background:#0a0e17;color:#fff;padding:4px 6px;font-size:8.5px;letter-spacing:1px;text-transform:uppercase;text-align:left}
        table.items td{padding:5px 6px;border-bottom:1px solid #e2e8f0;vertical-align:top}
        table.items tr:nth-child(even) td{background:#f8fafc}
        table.items tfoot td{background:#0a0e17;color:#fff;font-weight:700;padding:5px 6px;border:none}
        .instr{margin-top:10px;border:1px solid #0a0e17;padding:6px 8px;min-height:34px}
        .instr .lbl{font-size:8px;font-weight:700;letter-spacing:1.5px;color:#475569;text-transform:uppercase;margin-bottom:3px}
        .sig{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:12px}
        .sig .box{min-height:60px}
        .sig .sigline{border-bottom:1px solid #0a0e17;height:34px;margin-top:6px}
        .legal{margin-top:10px;font-size:8px;color:#64748b;line-height:1.5}
        @media print{body{font-size:10.5px}}
      </style></head><body>
      <div class="doc">
        <div class="hdr">
          <div>
            <div class="subtitle">Bill of Lading · Internal Transfer</div>
            <h1>BRIX BEVERAGE</h1>
          </div>
          <div class="right">
            <div class="bol">${escapeHtml(t.bol_number)}</div>
            <div class="stamp" style="color:${t.status === 'void' ? '#dc2626' : t.status === 'received' ? '#16a34a' : t.status === 'in_transit' ? '#d97706' : '#0a0e17'};border-color:${t.status === 'void' ? '#dc2626' : t.status === 'received' ? '#16a34a' : t.status === 'in_transit' ? '#d97706' : '#0a0e17'}">${(t.status || '').replace('_', ' ').toUpperCase()}</div>
          </div>
        </div>

        <div class="row3">
          <div class="box">
            <div class="lbl">Shipper / From</div>
            <div class="big">${escapeHtml(fromLoc?.name ?? '?')}</div>
            <div style="color:#475569">${escapeHtml(fromLoc?.code ?? '')}</div>
            ${fmtAddr(fromLoc)}
          </div>
          <div class="box">
            <div class="lbl">Consignee / To</div>
            <div class="big">${escapeHtml(toLoc?.name ?? '?')}</div>
            <div style="color:#475569">${escapeHtml(toLoc?.code ?? '')}</div>
            ${fmtAddr(toLoc)}
          </div>
          <div class="box">
            <div class="lbl">Carrier</div>
            <div class="big">${escapeHtml(t.carrier ?? '—')}</div>
            <div style="color:#475569;font-size:9px;text-transform:uppercase;letter-spacing:0.5px;margin-top:6px">PRO #</div>
            <div style="font-family:monospace">${escapeHtml(t.pro_number ?? '—')}</div>
            <div style="color:#475569;font-size:9px;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px">Tracking</div>
            <div style="font-family:monospace">${escapeHtml(t.tracking_number ?? '—')}</div>
          </div>
        </div>

        <div class="row4">
          <div class="kv"><div class="lbl">Ship Date</div><div class="val">${escapeHtml(t.ship_date ?? '—')}</div></div>
          <div class="kv"><div class="lbl">Received Date</div><div class="val">${escapeHtml(t.received_date ?? '—')}</div></div>
          <div class="kv"><div class="lbl">Freight Terms</div><div class="val">${termsLabel}</div></div>
          <div class="kv"><div class="lbl">Declared Value</div><div class="val">${totVal == null ? '—' : `$${fmtNum(round2(totVal))}`}</div></div>
        </div>

        <table class="items">
          <thead>
            <tr>
              <th style="width:22px">#</th>
              <th>Item / Description</th>
              <th style="text-align:right;width:60px">Qty</th>
              <th style="text-align:right;width:80px">Weight (lb)</th>
              <th style="text-align:right;width:60px">Pallets</th>
              <th style="text-align:center;width:55px">Class</th>
              <th style="text-align:center;width:65px">NMFC #</th>
            </tr>
          </thead>
          <tbody>${lineRows || '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:14px">No lines</td></tr>'}</tbody>
          <tfoot>
            <tr>
              <td colspan="2" style="text-align:right">TOTAL</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtNum(totQty)}</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${totWt == null ? '—' : fmtNum(round1(totWt))}</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${totPal == null ? '—' : fmtNum(round2(totPal))}</td>
              <td></td>
              <td></td>
            </tr>
          </tfoot>
        </table>

        ${t.special_instructions ? `<div class="instr"><div class="lbl">Special Instructions</div>${escapeHtml(t.special_instructions)}</div>` : ''}
        ${t.notes ? `<div class="instr"><div class="lbl">Notes</div>${escapeHtml(t.notes)}</div>` : ''}

        <div class="sig">
          <div class="box">
            <div class="lbl">Shipper signature / date</div>
            <div class="sigline">&nbsp;</div>
          </div>
          <div class="box">
            <div class="lbl">Carrier (driver) signature / date</div>
            <div class="sigline">&nbsp;</div>
          </div>
          <div class="box">
            <div class="lbl">Consignee signature / date</div>
            <div class="sigline">&nbsp;</div>
          </div>
        </div>

        <div class="legal">
          Received the goods described above in apparent good order, except as noted. Internal company transfer document &mdash; not subject to common-carrier liability rules unless a third-party carrier is named. Discrepancies must be reported to the Shipper within 48 hours of receipt.
        </div>
      </div>
      <script>setTimeout(function(){window.print()},350);</script>
    </body></html>`);
    w.document.close();
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
        maxWidth: 940, width: '100%', maxHeight: '88vh', overflowY: 'auto',
        padding: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
              BOL · {status.replace('_', ' ').toUpperCase()}
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 22, fontFamily: 'var(--ff-mono)', color: 'var(--ac)' }}>
              {transfer.bol_number}
            </h2>
          </div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)',
          }}><XIcon size={18} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, fontSize: 12, marginBottom: 14 }}>
          <Meta label="From" value={fromLoc ? `${fromLoc.code} — ${fromLoc.name}` : '?'} />
          <Meta label="To"   value={toLoc   ? `${toLoc.code} — ${toLoc.name}`     : '?'} />
          <Meta label="Shipped"  value={transfer.ship_date ?? '—'} />
          <Meta label="Received" value={transfer.received_date ?? '—'} />
        </div>

        {/* Freight section */}
        <div style={{
          marginBottom: 14, padding: 10,
          background: 'rgba(91,181,240,0.04)', border: '1px solid var(--bd)', borderRadius: 4,
        }}>
          <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 }}>
            Freight
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, fontSize: 12 }}>
            <FreightField label="Carrier" value={transfer.carrier} editable={editable && !busy}
              onSave={(v) => patchHeader({ carrier: v })} />
            <FreightField label="Tracking #" value={transfer.tracking_number} editable={editable && !busy}
              onSave={(v) => patchHeader({ tracking_number: v })} />
            <FreightField label="PRO #" value={transfer.pro_number} editable={editable && !busy}
              onSave={(v) => patchHeader({ pro_number: v })} />
            <FreightSelectField label="Freight terms"
              value={transfer.freight_terms ?? ''} editable={editable && !busy}
              options={[
                { value: '', label: '—' },
                { value: 'prepaid', label: 'Prepaid' },
                { value: 'collect', label: 'Collect' },
                { value: 'third_party', label: 'Third Party' },
              ]}
              onSave={(v) => patchHeader({ freight_terms: (v || null) as FreightTerms | null })} />
            <FreightField label={`Total weight (lb)${lineTotals.anyData && transfer.total_weight_lbs == null ? ` · auto ${round1(lineTotals.wt)}` : ''}`}
              value={displayWeight != null ? String(displayWeight) : null} editable={editable && !busy}
              numeric onSave={(v) => patchHeader({ total_weight_lbs: v === '' || v == null ? null : Number(v) })} />
            <FreightField label={`Total pallets${lineTotals.anyData && transfer.total_pallets == null ? ` · auto ${round2(lineTotals.pal)}` : ''}`}
              value={displayPallets != null ? String(displayPallets) : null} editable={editable && !busy}
              numeric onSave={(v) => patchHeader({ total_pallets: v === '' || v == null ? null : Number(v) })} />
            <FreightField label={`Declared value (USD)${lineTotals.anyData && transfer.declared_value_usd == null ? ` · auto ${round2(lineTotals.val)}` : ''}`}
              value={displayValue != null ? String(displayValue) : null} editable={editable && !busy}
              numeric onSave={(v) => patchHeader({ declared_value_usd: v === '' || v == null ? null : Number(v) })} />
            <FreightField label="Special instructions" value={transfer.special_instructions} editable={editable && !busy}
              wide onSave={(v) => patchHeader({ special_instructions: v })} />
          </div>

        </div>

        <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>Lines</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bd)' }}>
              <th style={cellTh}>Item</th>
              <th style={{ ...cellTh, textAlign: 'right' }}>Qty</th>
              <th style={{ ...cellTh, textAlign: 'right' }}>Wt (lb)</th>
              <th style={{ ...cellTh, textAlign: 'right' }}>Pallets</th>
              <th style={{ ...cellTh, textAlign: 'right' }}>Received</th>
              <th style={{ ...cellTh, textAlign: 'right' }}>Unit $</th>
            </tr>
          </thead>
          <tbody>
            {(lines ?? []).map((l) => {
              const it = itemLookup.byId.get(l.qbo_item_id);
              const qty = Number(l.qty);
              const wt = l.line_weight_lbs ?? (it?.weight_per_unit_lbs ? Number(it.weight_per_unit_lbs) * qty : null);
              const pal = l.line_pallets ?? (it?.units_per_pallet ? qty / Number(it.units_per_pallet) : null);
              return (
                <tr key={l.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={cellTd}>
                    <strong>{it?.item_name ?? l.qbo_item_id}</strong>
                    {it?.freight_class && <span style={{ marginLeft: 6, fontSize: 9.5, color: 'var(--mt)', letterSpacing: 0.4 }}>· cls {it.freight_class}</span>}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(qty)}</td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                    {wt == null ? '—' : fmtNum(round1(wt))}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                    {pal == null ? '—' : round2(pal).toString()}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                    {l.qty_received == null ? '—' : fmtNum(Number(l.qty_received))}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                    {l.unit_cost == null ? '—' : `$${Number(l.unit_cost).toFixed(2)}`}
                  </td>
                </tr>
              );
            })}
            {lines && lines.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 14, textAlign: 'center', color: 'var(--mt)' }}>No lines</td></tr>
            )}
          </tbody>
        </table>

        {transfer.notes && (
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--mt)' }}>
            <div style={{ fontSize: 9, letterSpacing: 0.6, textTransform: 'uppercase' }}>Notes</div>
            {transfer.notes}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
          <button onClick={printBol} style={btnSecondary()}>
            <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Print BOL
          </button>
          {status === 'draft' && (
            <>
              <button onClick={doVoid} disabled={busy} style={btnDanger()}>Void</button>
              <button onClick={doShip} disabled={busy} style={btnPrimary()}>Mark Shipped</button>
            </>
          )}
          {status === 'in_transit' && (
            <button onClick={doReceive} disabled={busy} style={btnPrimary()}>Mark Received</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── tiny helpers ───────────────────────────────────────────────────────

function ItemPicker({ value, options, onChange }: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inp(), width: '100%' }}>
      <option value="">— Select item —</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ marginTop: 3 }}>{value}</div>
    </div>
  );
}

function FreightField({ label, value, editable, numeric, wide, onSave }: {
  label: string;
  value: string | null;
  editable: boolean;
  numeric?: boolean;
  wide?: boolean;
  onSave: (v: string | null) => void;
}) {
  return (
    <div style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
      {editable
        ? <input
            type={numeric ? 'number' : 'text'}
            step={numeric ? 'any' : undefined}
            defaultValue={value ?? ''}
            onBlur={(e) => {
              const v = e.target.value.trim();
              const cur = value ?? '';
              if (v === cur) return;
              onSave(v === '' ? null : v);
            }}
            style={{ ...inp(), width: '100%' }}
          />
        : <div style={{ marginTop: 3, color: value ? 'var(--tx)' : 'var(--mt)' }}>{value ?? '—'}</div>}
    </div>
  );
}

function FreightSelectField({ label, value, options, editable, onSave }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  editable: boolean;
  onSave: (v: string) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
      {editable
        ? <select defaultValue={value} onChange={(e) => onSave(e.target.value)} style={{ ...inp(), width: '100%' }}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        : <div style={{ marginTop: 3, color: value ? 'var(--tx)' : 'var(--mt)' }}>
            {options.find((o) => o.value === value)?.label ?? '—'}
          </div>}
    </div>
  );
}

function LField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

const cellTh: React.CSSProperties = {
  textAlign: 'left', padding: '7px 10px',
  fontSize: 10, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)',
};
const cellTd: React.CSSProperties = { padding: '6px 10px', verticalAlign: 'middle' };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
