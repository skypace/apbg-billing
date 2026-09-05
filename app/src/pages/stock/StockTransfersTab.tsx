import { useCallback, useEffect, useMemo, useState } from 'react';
import { SearchSelect } from '../../components/SearchSelect';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Plus, FileText, X as XIcon, Trash2, Mail } from 'lucide-react';
import { openDocPdf } from '../../lib/productionDocs';
import { EmailDocModal } from '../production/EmailDocModal';
import {
  FreightTerms,
  InventoryLocation,
  InventoryTransfer,
  InventoryTransferLine,
  InventoryTransferLineInput,
  TransferStatus,
  createTransfer,
  setTransferDates,
  fetchTransferLines,
  receiveTransfer,
  shipTransfer,
  updateTransferFreight,
  voidTransfer,
} from '../../lib/inventoryControl';
import {
  SendResult,
  TransferWorkflow,
  WorkflowStatus,
  describeSends,
  fetchWorkflow,
  markBuilt,
  requestTransfer,
  resendReceiveLink,
  scheduleTransfer,
} from '../../lib/transferWorkflow';
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
    { field: 'transfer_date', headerName: 'Issued', width: 110,
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
          initialState={{ sorting: { sortModel: [{ field: 'transfer_date', sort: 'desc' }] } }}
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
    { qbo_item_id: '', qty: 1, unit_cost: null, notes: null, line_weight_lbs: null, line_pallets: null, lot_code: null, born_on_date: null },
  ]);
  const [transferDate, setTransferDate] = useState<string>(laToday());
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
    setLines([...lines, { qbo_item_id: '', qty: 1, unit_cost: null, notes: null, line_weight_lbs: null, line_pallets: null, lot_code: null, born_on_date: null }]);
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
        transfer_date: transferDate || null,
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
          <SearchSelect value={from} onChange={setFrom} placeholder="Type a location…"
            options={locations.map((l) => ({ id: l.id, label: `${l.code} — ${l.name}`, hint: l.kind.replace('_', ' ') }))} />
        </LField>
        <LField label="To">
          <SearchSelect value={to} onChange={setTo} placeholder="Type a location…"
            options={locations.filter((l) => l.id !== from).map((l) => ({ id: l.id, label: `${l.code} — ${l.name}`, hint: l.kind.replace('_', ' ') }))} />
        </LField>
        {/* Sky (2026-09-04): a transfer used the system date. Paperwork written
            up on Monday for a Friday load read Monday, on the BOL and in the
            list. This is the DOCUMENT date and it is editable afterwards too. */}
        <LField label="Transfer date">
          <input type="date" style={inp()} value={transferDate}
            onChange={(e) => setTransferDate(e.target.value)} />
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
            <th style={{ ...cellTh, width: 90 }}>Lot</th>
            <th style={{ ...cellTh, width: 120 }}>Born on</th>
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
                <td style={cellTd}>
                  <input style={{ ...inp(), width: '100%', fontFamily: 'var(--ff-mono)' }} placeholder="lot"
                    value={l.lot_code ?? ''} onChange={(e) => patchLine(i, { lot_code: e.target.value || null })} />
                </td>
                <td style={cellTd}>
                  <input type="date" style={{ ...inp(), width: '100%' }}
                    value={l.born_on_date ?? ''} onChange={(e) => patchLine(i, { born_on_date: e.target.value || null })} />
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
  const [emailOpen, setEmailOpen] = useState(false);
  // ⚠ Two buttons that both move stock is the one thing an operator must
  //   never be offered. Once a transfer is being run as a PROCESS, shipping
  //   belongs to Schedule & ship (which collects the BOL details and sends
  //   the receive link); the plain Mark Shipped stays for a transfer nobody
  //   raised through the process.
  const [wfStep, setWfStep] = useState<WorkflowStatus>('none');
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
  // TypeScript does not carry a narrowing on a destructured PARAMETER into a
  // closure, so the handlers below read this already-narrowed local instead.
  const doc = transfer;

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
    // The date is ASKED for, not assumed: a load that went out on Friday is
    // routinely marked shipped on Monday, and the RPC stamps CURRENT_DATE when
    // it is given nothing. Cancel on the prompt cancels the whole action.
    const when = prompt(`Ship date for ${doc.bol_number}?`, doc.ship_date ?? laToday());
    if (when === null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(when.trim())) { toast.error('Use a date like 2026-09-04'); return; }
    if (!confirm(`Mark ${doc.bol_number} shipped on ${when.trim()} and decrement ${fromLoc?.code ?? 'source'}?\n\nThe printed BOL has blank signature lines for wet-ink signing.`)) return;
    setBusy(true);
    try {
      await shipTransfer(transferId, when.trim());
      toast.success('Marked shipped');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }
  async function doReceive() {
    const when = prompt(`Received date for ${doc.bol_number}?`, doc.received_date ?? laToday());
    if (when === null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(when.trim())) { toast.error('Use a date like 2026-09-04'); return; }
    if (!confirm(`Mark ${doc.bol_number} received on ${when.trim()} and increment ${toLoc?.code ?? 'destination'}?\n\nThe printed BOL has blank signature lines for wet-ink signing.`)) return;
    setBusy(true);
    try {
      await receiveTransfer(transferId, when.trim());
      toast.success('Marked received');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }
  async function saveDates(dates: { transfer_date?: string; ship_date?: string; received_date?: string }) {
    setBusy(true);
    try {
      await setTransferDates(transferId, dates);
      toast.success('Date updated');
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
          {/* ⚠ Changing a date here corrects the PAPERWORK. The inventory
              movements keep the timestamps they were posted with — ledger
              history is never edited (the reconcile rule). */}
          <DateField label="Transfer date" value={transfer.transfer_date} editable={status !== 'void' && !busy}
            onSave={(v) => saveDates({ transfer_date: v })} />
          <DateField label="Shipped" value={transfer.ship_date}
            editable={status !== 'void' && !busy && (status === 'in_transit' || status === 'received')}
            onSave={(v) => saveDates({ ship_date: v })} />
          <DateField label="Received" value={transfer.received_date}
            editable={status !== 'void' && !busy && status === 'received'}
            onSave={(v) => saveDates({ received_date: v })} />
        </div>

        <TransferWorkflowPanel
          transferId={transferId} transfer={doc} busy={busy} setBusy={setBusy}
          onChanged={onChanged} onStep={setWfStep} />

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
              <th style={cellTh}>Lot</th>
              <th style={cellTh}>Born on</th>
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
                  <td style={{ ...cellTd, fontFamily: 'var(--ff-mono)' }}>{l.lot_code ?? '—'}</td>
                  <td style={{ ...cellTd, color: 'var(--mt)' }}>
                    {l.born_on_date ?? '—'}{l.best_by_date ? <span style={{ fontSize: 9.5 }}> · best by {l.best_by_date}</span> : null}
                  </td>
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
              <tr><td colSpan={8} style={{ padding: 14, textAlign: 'center', color: 'var(--mt)' }}>No lines</td></tr>
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
          <button onClick={() => openDocPdf({ kind: 'bol', id: transferId }).catch((e) => toast.error(errMsg(e)))} style={btnSecondary()}
            title="The branded bill of lading as a PDF — print it or save it from there">
            <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> View BOL PDF
          </button>
          <button onClick={() => setEmailOpen(true)} style={btnSecondary()} title="Email the BOL PDF to the shipper, carrier or receiver">
            <Mail size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Email…
          </button>
          {status === 'draft' && (
            <>
              <button onClick={doVoid} disabled={busy} style={btnDanger()}>Void</button>
              {wfStep === 'none' && (
                <button onClick={doShip} disabled={busy} style={btnPrimary()}>Mark Shipped</button>
              )}
            </>
          )}
          {status === 'in_transit' && (
            <button onClick={doReceive} disabled={busy} style={btnPrimary()}>Mark Received</button>
          )}
        </div>
        {emailOpen && (
          <EmailDocModal ref={{ kind: 'bol', id: transferId }} title={'BOL ' + transfer.bol_number} onClose={() => setEmailOpen(false)} />
        )}
      </div>
    </div>
  );
}

/**
 * The transfer PROCESS — the panel a person works down.
 *
 * Sky (2026-09-04): the order goes in, the office is emailed to build it with
 * the pick ticket attached, Service Fusion gets a ticket whose number rides on
 * that email, the receiving branch is warned, the tech completes the ticket,
 * the office is told to schedule it, shipping and BOL details are entered, and
 * the branch gets everything plus a ONE-TIME link to receive.
 *
 * ⚠ Every step here is PAPERWORK except Schedule, which ships the load through
 *   the ordinary ship RPC. So this panel replaces the Mark Shipped button on a
 *   transfer that is being run as a process, and leaves it alone on one that is
 *   not — an operator must never have two buttons that both move stock.
 */
function TransferWorkflowPanel({ transferId, transfer, busy, setBusy, onChanged, onStep }: {
  transferId: string;
  transfer: InventoryTransfer;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onChanged: () => void;
  onStep: (s: WorkflowStatus) => void;
}) {
  const toast = useToast();
  const [wf, setWf] = useState<TransferWorkflow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);

  const [shipDate, setShipDate] = useState(laToday());
  const [carrier, setCarrier] = useState(transfer.carrier ?? '');
  const [proNumber, setProNumber] = useState(transfer.pro_number ?? '');
  const [tracking, setTracking] = useState(transfer.tracking_number ?? '');
  const [terms, setTerms] = useState<string>(transfer.freight_terms ?? '');
  const [pallets, setPallets] = useState(transfer.total_pallets == null ? '' : String(transfer.total_pallets));
  const [weight, setWeight] = useState(transfer.total_weight_lbs == null ? '' : String(transfer.total_weight_lbs));
  const [instructions, setInstructions] = useState(transfer.special_instructions ?? '');
  const [signer, setSigner] = useState('');

  const reload = useCallback(() => {
    fetchWorkflow(transferId)
      .then((w) => { setWf(w); setLoaded(true); onStep(w?.workflow_status ?? 'none'); })
      .catch(() => setLoaded(true));
  }, [transferId, onStep]);

  useEffect(() => { setLoaded(false); setWf(null); reload(); }, [reload]);

  // The workflow is switched off, or this environment has no settings row —
  // say nothing rather than offering a button that can only fail.
  if (!loaded || !wf) return null;

  const step = wf.workflow_status;
  const report = (r: { emails?: SendResult[] }) => toast.success(describeSends(r.emails));

  async function run(fn: () => Promise<{ emails?: SendResult[] }>, ok: string) {
    setBusy(true);
    try {
      const r = await fn();
      toast.success(ok);
      report(r);
      reload();
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doRequest() {
    setBusy(true);
    try {
      const r = await requestTransfer(transferId);
      // The Service Fusion half is reported plainly either way: a ticket that
      // was not created is a thing to do by hand, not a silent gap.
      if (r.sf_job_number) toast.success(`Requested — Service Fusion ticket ${r.sf_job_number}`);
      else toast.error(`Requested, but Service Fusion did not take the ticket: ${r.sf_error ?? 'unknown'} — make it by hand`);
      if (r.sf_warning) toast.error(r.sf_warning);
      toast.success(describeSends(r.emails));
      reload();
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function doSchedule() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(shipDate.trim())) { toast.error('Use a ship date like 2026-09-05'); return; }
    if (!confirm(`Ship ${transfer.bol_number} on ${shipDate.trim()}?\n\nThis moves the stock out of the sending location and emails the receiving branch a one-time link to receive it.`)) return;
    await run(() => scheduleTransfer(transferId, {
      ship_date: shipDate.trim(),
      carrier: carrier || null,
      pro_number: proNumber || null,
      tracking_number: tracking || null,
      freight_terms: terms || null,
      total_pallets: pallets || null,
      total_weight_lbs: weight || null,
      special_instructions: instructions || null,
      shipper_signature_name: signer || null,
    }), 'Shipped — the receiving branch has the link');
    setShowSchedule(false);
  }

  const linkState = (() => {
    if (!wf.receive_link_sent_at) return null;
    if (wf.receive_token_used_at) return `Receive link used ${new Date(wf.receive_token_used_at).toLocaleString()}`;
    const exp = wf.receive_token_expires_at ? new Date(wf.receive_token_expires_at) : null;
    if (exp && exp.getTime() < Date.now()) return 'Receive link EXPIRED — send a new one';
    return `Receive link live${exp ? ` until ${exp.toLocaleDateString()}` : ''}`;
  })();

  return (
    <div style={{
      marginBottom: 14, padding: 10,
      background: 'rgba(46,184,114,0.05)', border: '1px solid var(--bd)', borderRadius: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
          Transfer process
        </div>
        <Steps step={step} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, fontSize: 12, marginBottom: 10 }}>
        <Meta label="Service Fusion ticket" value={wf.sf_job_number ? `#${wf.sf_job_number}${wf.sf_job_status ? ` · ${wf.sf_job_status}` : ''}` : (wf.sf_error ? 'not created' : '—')} />
        <Meta label="Requested" value={wf.requested_at ? new Date(wf.requested_at).toLocaleString() : '—'} />
        <Meta label="Built" value={wf.built_at ? new Date(wf.built_at).toLocaleString() : '—'} />
        <Meta label="Receive link" value={linkState ?? '—'} />
      </div>

      {wf.sf_error && (
        <div style={{ fontSize: 11, color: 'var(--rd)', marginBottom: 8 }}>
          Service Fusion refused the ticket: {wf.sf_error}. Make it by hand — customer, category and the lines are on the pull ticket.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={() => openDocPdf({ kind: 'pull_ticket', id: transferId }).catch((e) => toast.error(errMsg(e)))}
          style={btnSecondary()}
          title="What the warehouse picks — one line per item with a tick box">
          <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Pull ticket
        </button>

        {step === 'none' && transfer.status === 'draft' && (
          <button onClick={doRequest} disabled={busy} style={btnPrimary()}
            title="Creates the Service Fusion ticket, emails the office the pull ticket, and warns the receiving branch">
            Request the transfer
          </button>
        )}
        {step === 'requested' && (
          <button onClick={() => run(() => markBuilt(transferId), 'Marked built')} disabled={busy} style={btnPrimary()}
            title="The tech has completed the ticket — this asks the office to schedule the delivery">
            Ticket complete — ready to schedule
          </button>
        )}
        {step === 'built' && transfer.status === 'draft' && (
          <button onClick={() => setShowSchedule((v) => !v)} disabled={busy} style={btnPrimary()}>
            {showSchedule ? 'Cancel' : 'Schedule & ship…'}
          </button>
        )}
        {transfer.status === 'in_transit' && wf.receive_link_sent_at && (
          <button
            onClick={() => {
              const to = prompt('Send a NEW receive link to (blank = the receiving branch):', '');
              if (to === null) return;
              run(() => resendReceiveLink(transferId, to.trim() || undefined), 'A new link is on its way');
            }}
            disabled={busy} style={btnSecondary()}
            title="Only the hash of a link is stored, so the original cannot be re-sent — this mints a new one and kills the old">
            Send a new receive link
          </button>
        )}
      </div>

      {showSchedule && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--bd)' }}>
          <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 8 }}>
            Shipping and BOL details. Saving ships the load and emails the receiving branch the BOL plus a one-time link to receive it.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <LField label="Ship date"><input value={shipDate} onChange={(e) => setShipDate(e.target.value)} type="date" style={inp()} /></LField>
            <LField label="Carrier"><input value={carrier} onChange={(e) => setCarrier(e.target.value)} style={inp()} /></LField>
            <LField label="PRO #"><input value={proNumber} onChange={(e) => setProNumber(e.target.value)} style={inp()} /></LField>
            <LField label="Tracking #"><input value={tracking} onChange={(e) => setTracking(e.target.value)} style={inp()} /></LField>
            <LField label="Freight terms">
              <select value={terms} onChange={(e) => setTerms(e.target.value)} style={inp()}>
                <option value="">—</option>
                <option value="prepaid">Prepaid</option>
                <option value="collect">Collect</option>
                <option value="third_party">Third Party</option>
              </select>
            </LField>
            <LField label="Pallets"><input value={pallets} onChange={(e) => setPallets(e.target.value)} style={inp()} /></LField>
            <LField label="Weight (lb)"><input value={weight} onChange={(e) => setWeight(e.target.value)} style={inp()} /></LField>
            <LField label="Shipper signature name"><input value={signer} onChange={(e) => setSigner(e.target.value)} style={inp()} /></LField>
          </div>
          <div style={{ marginTop: 10 }}>
            <LField label="Special instructions">
              <input value={instructions} onChange={(e) => setInstructions(e.target.value)} style={inp()} />
            </LField>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button onClick={doSchedule} disabled={busy} style={btnPrimary()}>Ship it & send the link</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Four words that say where the load is in the process. */
function Steps({ step }: { step: WorkflowStatus }) {
  const order: WorkflowStatus[] = ['none', 'requested', 'built', 'scheduled'];
  const labels: Record<WorkflowStatus, string> = {
    none: 'Not requested', requested: 'Building', built: 'Ready to ship', scheduled: 'Shipped',
  };
  const at = order.indexOf(step);
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {order.map((s, i) => (
        <span key={s} style={{
          fontSize: 9, fontWeight: 700, letterSpacing: 0.5, padding: '2px 7px', borderRadius: 12,
          border: '1px solid ' + (i <= at ? 'var(--gn)' : 'var(--bd)'),
          color: i <= at ? 'var(--gn)' : 'var(--mt)',
          background: i === at ? 'rgba(46,184,114,0.12)' : 'transparent',
        }}>{labels[s].toUpperCase()}</span>
      ))}
    </div>
  );
}

// ── tiny helpers ───────────────────────────────────────────────────────

function ItemPicker({ value, options, onChange }: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  // Type to narrow ("root" finds the root beer case), or open the arrow for the whole list.
  return <SearchSelect value={value} onChange={onChange} options={options} placeholder="Type an item…" style={{ width: '100%' }} />;
}

/** Today in Los Angeles as YYYY-MM-DD. en-CA yields that order directly; a
 *  plain local Date would name the wrong day for a browser in another zone. */
function laToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** A date the operator sets. Read-only until the transfer has reached the
 *  state the date describes — fn_set_transfer_dates refuses the rest, and a
 *  box you can type into that the server will reject is worse than no box. */
function DateField({ label, value, editable, onSave }: {
  label: string;
  value: string | null;
  editable: boolean;
  onSave: (v: string) => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
      {editable
        ? <input
            type="date"
            defaultValue={value ?? ''}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (!v || v === (value ?? '')) return;
              onSave(v);
            }}
            style={{ ...inp(), width: '100%' }}
          />
        : <div style={{ marginTop: 3, color: value ? 'var(--tx)' : 'var(--mt)' }}>{value ?? '—'}</div>}
    </div>
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
