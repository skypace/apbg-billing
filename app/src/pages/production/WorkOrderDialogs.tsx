// Dialogs shared by the Work Orders tab and the Production Orders (run) detail:
// record yield (with optional lots), the per-work-order ship dialog, and the
// lot editor. Extracted 2026-09-03 so a run can record each flavour's yield
// without a second copy of the lot arithmetic — the "quantities must total the
// yield" rule lives in checkLots() and nowhere else.
import { useState } from 'react';
import { Plus, X as XIcon, FileText, Tag } from 'lucide-react';
import type { WorkOrderView, WorkOrderLot, WorkOrderLotInput } from '../../lib/production';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';
import { LField } from './productionUi';

// ── Action dialogs ───────────────────────────────────────────────────────

export function RecordYieldDialog({ wo, busy, onCancel, onSubmit }: {
  wo: WorkOrderView; busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
}) {
  const [actual, setActual] = useState(String(wo.qty_to_produce));
  const [copackFee, setCopackFee] = useState('');
  const [freight, setFreight] = useState('');
  const [other, setOther] = useState('');
  const [date, setDate] = useState('');
  const [lotRows, setLotRows] = useState<LotRow[]>([]);
  const pct = Number(wo.expected_units) > 0 ? (Number(actual) / Number(wo.expected_units)) * 100 : null;
  const lotCheck = checkLots(lotRows, Number(actual));
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
      <LotEditor rows={lotRows} onChange={setLotRows} expectedTotal={Number(actual)}
        hint="Optional here — the co-packer's lot codes and born-on dates can also be entered before shipping. If entered, the lot quantities must add up to the yield." />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button style={btnSecondary()} onClick={onCancel}>Cancel</button>
        <button style={btnPrimary()} disabled={busy || !(Number(actual) > 0) || !lotCheck.ok} title={lotCheck.ok ? undefined : lotCheck.reason} onClick={() => onSubmit({
          actual_yield_qty: Number(actual),
          copack_fee: copackFee ? Number(copackFee) : 0,
          freight_cost: freight ? Number(freight) : 0,
          other_cost: other ? Number(other) : 0,
          yield_date: date || null,
          ...(lotCheck.payload.length ? { lots: lotCheck.payload } : {}),
        })}>Record yield + lock costs</button>
      </div>
    </div>
  );
}

export function ShipDialog({ wo, busy, lots, onCancel, onSubmit }: {
  wo: WorkOrderView; busy: boolean; lots: WorkOrderLot[];
  onCancel: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
}) {
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [proNumber, setProNumber] = useState('');
  const [date, setDate] = useState('');
  const [lotRows, setLotRows] = useState<LotRow[]>([]);
  const produced = Number(wo.qty_produced_actual ?? 0);
  const lotCheck = checkLots(lotRows, produced);
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
      {lots.length > 0 ? (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--mt)' }}>
          <Tag size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          {lots.length} lot{lots.length === 1 ? '' : 's'} on file — the BOL will carry one line per lot:{' '}
          {lots.map((l) => `${l.lot_code} ×${fmtNum(Number(l.qty))}${l.born_on_date ? ` (born ${l.born_on_date})` : ''}`).join(' · ')}.
          Use “Edit lots” on the work order to change them before shipping.
        </div>
      ) : (
        <LotEditor rows={lotRows} onChange={setLotRows} expectedTotal={produced}
          hint="No lots recorded yet. Enter the co-packer's lot codes and born-on dates now and the BOL prints one line per lot; leave it empty to ship as a single line." />
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button style={btnSecondary()} onClick={onCancel}>Cancel</button>
        <button style={btnPrimary()} disabled={busy || !lotCheck.ok} title={lotCheck.ok ? undefined : lotCheck.reason} onClick={() => onSubmit({
          carrier: carrier || null,
          tracking: tracking || null,
          pro_number: proNumber || null,
          ship_date: date || null,
          ...(lots.length === 0 && lotCheck.payload.length ? { lots: lotCheck.payload } : {}),
        })}>
          <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Ship it
        </button>
      </div>
    </div>
  );
}


// ── Lots ─────────────────────────────────────────────────────────────────

export interface LotRow { lot_code: string; born_on_date: string; best_by_date: string; qty: string; notes: string }
const EMPTY_LOT: LotRow = { lot_code: '', born_on_date: '', best_by_date: '', qty: '', notes: '' };

/** Rows a human has started filling in become the payload; a row that is
 *  entirely blank is ignored. Once anything is filled, every filled row needs
 *  a code and a quantity, and the quantities must total the yield — a case is
 *  in exactly one lot. */
export function checkLots(rows: LotRow[], expectedTotal: number): { ok: boolean; reason?: string; payload: WorkOrderLotInput[]; total: number } {
  const filled = rows.filter((r) => r.lot_code.trim() || r.qty.trim() || r.born_on_date || r.best_by_date || r.notes.trim());
  const payload: WorkOrderLotInput[] = filled.map((r) => ({
    lot_code: r.lot_code.trim(),
    born_on_date: r.born_on_date || null,
    best_by_date: r.best_by_date || null,
    qty: Number(r.qty),
    notes: r.notes.trim() || null,
  }));
  const total = payload.reduce((t, l) => t + (Number.isFinite(l.qty) ? l.qty : 0), 0);
  if (!payload.length) return { ok: true, payload, total: 0 };
  if (payload.some((l) => !l.lot_code)) return { ok: false, reason: 'Every lot needs a lot code', payload, total };
  if (payload.some((l) => !(l.qty > 0))) return { ok: false, reason: 'Every lot needs a quantity above zero', payload, total };
  const codes = new Set(payload.map((l) => l.lot_code.toLowerCase()));
  if (codes.size !== payload.length) return { ok: false, reason: 'Two lots share a code', payload, total };
  if (expectedTotal > 0 && Math.abs(total - expectedTotal) > 1e-6) {
    return { ok: false, reason: `Lot quantities total ${fmtNum(total)} but the yield is ${fmtNum(expectedTotal)}`, payload, total };
  }
  return { ok: true, payload, total };
}

export function LotEditor({ rows, onChange, expectedTotal, hint }: {
  rows: LotRow[]; onChange: (rows: LotRow[]) => void; expectedTotal: number; hint?: string;
}) {
  const check = checkLots(rows, expectedTotal);
  const setRow = (i: number, patch: Partial<LotRow>) => onChange(rows.map((r, j) => j === i ? { ...r, ...patch } : r));
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
        <Tag size={11} style={{ verticalAlign: -1, marginRight: 4 }} /> Lots — lot code · born on · best by · cases
      </div>
      {hint && <div style={{ fontSize: 10.5, color: 'var(--mt)', marginBottom: 6 }}>{hint}</div>}
      {rows.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 130px 130px 90px 1.4fr 28px', gap: 6, marginBottom: 4, fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          <span>Lot code</span><span>Born on</span><span>Best by</span><span>Cases</span><span>Notes</span><span />
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.2fr 130px 130px 90px 1.4fr 28px', gap: 6, marginBottom: 6 }}>
          <input style={{ ...inp(), fontFamily: 'var(--ff-mono)' }} placeholder="e.g. Q375" value={r.lot_code} onChange={(e) => setRow(i, { lot_code: e.target.value })} />
          <input type="date" style={inp()} value={r.born_on_date} onChange={(e) => setRow(i, { born_on_date: e.target.value })} />
          <input type="date" style={inp()} value={r.best_by_date} onChange={(e) => setRow(i, { best_by_date: e.target.value })} />
          <input type="number" min={0} step="any" style={inp()} value={r.qty} onChange={(e) => setRow(i, { qty: e.target.value })} />
          <input style={inp()} placeholder="notes" value={r.notes} onChange={(e) => setRow(i, { notes: e.target.value })} />
          <button style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}><XIcon size={13} /></button>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button style={btnSecondary()} onClick={() => onChange([...rows, { ...EMPTY_LOT }])}>
          <Plus size={11} style={{ marginRight: 3, verticalAlign: -1 }} /> Add lot
        </button>
        {check.payload.length > 0 && (
          <span style={{ fontSize: 11, color: check.ok ? 'var(--gn)' : 'var(--am)' }}>
            {check.ok
              ? `${check.payload.length} lot${check.payload.length === 1 ? '' : 's'} · ${fmtNum(check.total)} cases — matches the yield`
              : check.reason}
          </span>
        )}
      </div>
    </div>
  );
}

export function LotsDialog({ wo, busy, lots, onCancel, onSubmit }: {
  wo: WorkOrderView; busy: boolean; lots: WorkOrderLot[];
  onCancel: () => void;
  onSubmit: (payload: WorkOrderLotInput[]) => void;
}) {
  const [rows, setRows] = useState<LotRow[]>(lots.length
    ? lots.map((l) => ({ lot_code: l.lot_code, born_on_date: l.born_on_date ?? '', best_by_date: l.best_by_date ?? '', qty: String(l.qty), notes: l.notes ?? '' }))
    : [{ ...EMPTY_LOT }]);
  const expected = Number(wo.qty_produced_actual ?? 0);
  const check = checkLots(rows, expected);
  return (
    <div className="cd" style={{ padding: 12, marginTop: 12, border: '1px solid var(--ac)' }}>
      <div style={{ fontSize: 10.5, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
        Lots for {wo.batch_code}{expected > 0 ? ` — must total ${fmtNum(expected)} cases` : ''}
      </div>
      <LotEditor rows={rows} onChange={setRows} expectedTotal={expected}
        hint="The co-packer's own lot / batch codes and the born-on (production) date for each. Saving replaces the list." />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button style={btnSecondary()} onClick={onCancel}>Cancel</button>
        <button style={btnPrimary()} disabled={busy || !check.ok} title={check.ok ? undefined : check.reason}
          onClick={() => onSubmit(check.payload)}>
          {check.payload.length ? 'Save lots' : 'Clear lots'}
        </button>
      </div>
    </div>
  );
}

