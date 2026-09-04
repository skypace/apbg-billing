import { useEffect, useMemo, useState } from 'react';
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
  fetchTransferLines,
  receiveTransfer,
  shipTransfer,
  updateTransferFreight,
  voidTransfer,
  reopenTransfer,
} from '../../lib/inventoryControl';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';
import { GRID_SX, GRID_DEFAULTS, STATUS_COLOR } from './stockStyles';
import type { ItemLookup } from './StockPage';
import { StatusBuckets } from '../../components/StatusBuckets';
import { BulkActionBar } from '../../components/BulkActionBar';
import { ReasonDialog } from '../../components/ReasonDialog';
import { BulkEditDialog } from '../../components/BulkEditDialog';
import { useGridSelection } from '../../lib/useGridSelection';
import { countBuckets, rowBucket, type Bucket } from '../../lib/lifecycleBuckets';
import { deleteDrafts, reopenDocs, summarizeBulk, updateDocs, voidDocs, type BulkResult } from '../../lib/bulkActions';

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
  const toast = useToast();
  const [bucket, setBucket] = useState<Bucket>('open');
  const [bulk, setBulk] = useState<'void' | 'delete' | 'edit' | 'reopen' | null>(null);
  const [busy, setBusy] = useState(false);
  const sel = useGridSelection([bucket, transfers?.length]);

  const physicalLocs = useMemo(
    () => locations.filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment'),
    [locations],
  );

  const counts = useMemo(() => countBuckets('transfer', transfers ?? []), [transfers]);
  const filtered = useMemo(
    () => (transfers ?? []).filter((t) => rowBucket('transfer', t) === bucket),
    [transfers, bucket],
  );
  const selectedRows = useMemo(
    () => filtered.filter((t) => sel.selected.includes(t.id)),
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
  const voidItems = selectedRows.map((t) => ({
    id: t.id, number: t.bol_number, eligible: t.status === 'draft',
    why: t.status === 'void' ? 'already void'
      : t.status === 'in_transit' ? 'already shipped — receive it, or reverse the shipment from its detail'
      : 'received — stock has landed',
  }));
  const deleteItems = selectedRows.map((t) => ({
    id: t.id, number: t.bol_number, eligible: t.status === 'draft',
    why: 'not a draft — void it instead',
  }));
  const reopenItems = selectedRows.map((t) => ({
    id: t.id, number: t.bol_number, eligible: t.status === 'received', why: 'not received',
  }));

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
          <StatusBuckets kind="transfer" value={bucket} counts={counts} onChange={setBucket} />
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
          {...sel.gridProps}
        />
      </div>

      <BulkActionBar count={sel.selected.length} noun="transfer" onClear={sel.clear}>
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
        <ReasonDialog title="Void transfers" verb={`Void ${voidItems.filter((i) => i.eligible).length} transfer${voidItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={voidItems} busy={busy}
          note="Only a draft can be voided — once shipped, stock has moved and the ledger is corrected by receiving or reversing, never by voiding."
          onCancel={() => setBulk(null)}
          onConfirm={(reason, ids) => runBulk('voided', () => voidDocs('transfer', ids, reason))} />
      )}
      {bulk === 'delete' && (
        <ReasonDialog title="Delete draft transfers" verb={`Delete ${deleteItems.filter((i) => i.eligible).length} draft${deleteItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={deleteItems} needReason={false} busy={busy}
          note="Only a draft can be deleted, and never one that is a work order's return shipment or fulfils a sub-distributor order."
          onCancel={() => setBulk(null)}
          onConfirm={(_reason, ids) => runBulk('deleted', () => deleteDrafts('transfer', ids))} />
      )}
      {bulk === 'reopen' && (
        <ReasonDialog title="Reopen transfers" verb={`Reopen ${reopenItems.filter((i) => i.eligible).length} transfer${reopenItems.filter((i) => i.eligible).length === 1 ? '' : 's'}`}
          items={reopenItems} busy={busy}
          note="Every line is reversed from the destination back to In Transit with a new movement. Refused once the stock has moved on, or when the transfer is a work order's return shipment that the run has already received."
          onCancel={() => setBulk(null)}
          onConfirm={(reason, ids) => runBulk('reopened', () => reopenDocs('transfer', ids, reason))} />
      )}
      {bulk === 'edit' && (
        <BulkEditDialog title="Edit transfers" count={sel.selected.length} busy={busy}
          fields={[
            { key: 'carrier', label: 'Carrier', type: 'text' },
            { key: 'tracking_number', label: 'Tracking / PRO #', type: 'text' },
            { key: 'special_instructions', label: 'Special instructions', type: 'textarea' },
            { key: 'notes', label: 'Notes', type: 'textarea' },
          ]}
          onCancel={() => setBulk(null)}
          onConfirm={(patch) => runBulk('edited', () => updateDocs('transfer', sel.selected, patch))} />
      )}

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
  const [voidAsk, setVoidAsk] = useState(false);
  const [reopenAsk, setReopenAsk] = useState(false);
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
  async function doReopen(reason: string) {
    setReopenAsk(false);
    setBusy(true);
    try {
      await reopenTransfer(transferId, reason);
      toast.success('Reopened — back in transit');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }
  async function doVoid(reason: string) {
    setVoidAsk(false);
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
          {voidAsk && (
            <ReasonDialog title={'Void ' + transfer.bol_number} verb="Void transfer"
              items={[{ id: transfer.id, number: transfer.bol_number, eligible: true }]} busy={busy}
              note="Nothing has shipped yet, so nothing moves in the ledger. The reason stays on the row."
              onCancel={() => setVoidAsk(false)} onConfirm={(reason) => void doVoid(reason)} />
          )}
          {status === 'draft' && (
            <>
              <button onClick={() => setVoidAsk(true)} disabled={busy} style={btnDanger()}>Void</button>
              <button onClick={doShip} disabled={busy} style={btnPrimary()}>Mark Shipped</button>
            </>
          )}
          {status === 'in_transit' && (
            <button onClick={doReceive} disabled={busy} style={btnPrimary()}>Mark Received</button>
          )}
          {status === 'received' && (
            <button onClick={() => setReopenAsk(true)} disabled={busy} style={btnSecondary()} title="Reverse the receipt back to In Transit">Reopen</button>
          )}
          {reopenAsk && (
            <ReasonDialog title={'Reopen ' + transfer.bol_number} verb="Reopen transfer"
              items={[{ id: transfer.id, number: transfer.bol_number, eligible: true }]} busy={busy}
              note="Every line is reversed from the destination back to In Transit with a new movement (nothing is edited). Refused once the stock has moved on."
              onCancel={() => setReopenAsk(false)} onConfirm={(reason) => void doReopen(reason)} />
          )}
        </div>
        {emailOpen && (
          <EmailDocModal ref={{ kind: 'bol', id: transferId }} title={'BOL ' + transfer.bol_number} onClose={() => setEmailOpen(false)} />
        )}
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
