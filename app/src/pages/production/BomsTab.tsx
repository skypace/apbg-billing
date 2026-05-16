import { useEffect, useState } from 'react';
import { Plus, Trash2, X as XIcon } from 'lucide-react';
import {
  BomLineInput, ProductBom, ProductBomLine,
  createBom, fetchBomLines, replaceBomLines, updateBom,
} from '../../lib/production';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { UOM_OPTIONS, scaleBom, fmtQty } from '../../lib/uom';
import type { ProductionItemLookup } from './ProductionPage';

interface Props {
  boms: ProductBom[] | null;
  itemLookup: ProductionItemLookup;
  onChanged: () => void;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function BomsTab({ boms, itemLookup, onChanged }: Props) {
  const [creating, setCreating] = useState(false);
  const [openBomId, setOpenBomId] = useState<string | null>(null);

  if (boms === null) return <div style={{ padding: 18, color: 'var(--mt)' }}>Loading…</div>;

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: 'var(--mt)', fontSize: 11 }}>
            {boms.length} BOM{boms.length === 1 ? '' : 's'} · {boms.filter((b) => b.is_active).length} active
          </span>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button onClick={() => setCreating(true)} style={btnPrimary()}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> New BOM
          </button>
        </div>
      </div>

      {creating && (
        <CreateBomForm
          itemLookup={itemLookup}
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); onChanged(); }}
        />
      )}

      {itemLookup.finishedOptions.length === 0 && (
        <div style={{
          padding: 10, marginBottom: 14,
          background: 'rgba(239,191,65,0.08)', border: '1px solid rgba(239,191,65,0.30)',
          borderRadius: 4, fontSize: 11, color: 'var(--am)',
        }}>
          No items flagged for BOM. Toggle <strong>BOM</strong> on a finished SKU in{' '}
          <strong>Settings → Items (master)</strong> before creating a BOM.
        </div>
      )}

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--sf)', borderBottom: '1px solid var(--bd)' }}>
              <Th>Finished SKU</Th>
              <Th>Version</Th>
              <Th style={{ textAlign: 'right' }}>Yield Qty</Th>
              <Th>Status</Th>
              <Th>Effective</Th>
              <Th style={{ width: 90 }}> </Th>
            </tr>
          </thead>
          <tbody>
            {boms.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 18, textAlign: 'center', color: 'var(--mt)' }}>
                No BOMs yet.
              </td></tr>
            )}
            {boms.map((b) => {
              const it = itemLookup.byId.get(b.finished_qbo_item_id);
              return (
                <tr key={b.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <Td><strong>{it?.item_name ?? b.finished_qbo_item_id}</strong></Td>
                  <Td><code style={{ color: 'var(--mt)', fontFamily: 'var(--ff-mono)' }}>{b.version}</code></Td>
                  <Td style={{ textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{Number(b.yield_qty)}</Td>
                  <Td>
                    <span style={{
                      fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5,
                      color: b.is_active ? 'var(--gn)' : 'var(--mt)',
                    }}>{b.is_active ? 'ACTIVE' : 'INACTIVE'}</span>
                  </Td>
                  <Td><span style={{ color: 'var(--mt)' }}>{b.effective_date ?? '—'}</span></Td>
                  <Td>
                    <button onClick={() => setOpenBomId(b.id)} style={btnSecondary()}>Open</button>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {openBomId && (
        <BomDetailModal
          bomId={openBomId}
          bom={boms.find((b) => b.id === openBomId)!}
          itemLookup={itemLookup}
          onClose={() => setOpenBomId(null)}
          onChanged={() => { setOpenBomId(null); onChanged(); }}
        />
      )}
    </div>
  );
}

// ── Create form ────────────────────────────────────────────────────────

function CreateBomForm({ itemLookup, onCancel, onCreated }: {
  itemLookup: ProductionItemLookup;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [finishedId, setFinishedId] = useState('');
  const [version, setVersion] = useState('1');
  const [yieldQty, setYieldQty] = useState<string>('1');
  const [yieldUom, setYieldUom] = useState<string>('each');
  const [effective, setEffective] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<BomLineInput[]>([emptyComponentLine()]);
  const [saving, setSaving] = useState(false);

  const canSave =
    !!finishedId &&
    Number(yieldQty) > 0 &&
    lines.length > 0 &&
    lines.every(validLine);

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      await createBom({
        finished_qbo_item_id: finishedId,
        yield_qty: Number(yieldQty),
        yield_uom: yieldUom,
        lines,
        version,
        effective_date: effective || null,
        notes: notes || null,
      });
      toast.success('BOM created');
      onCreated();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="cd" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
          New BOM
        </div>
        <button onClick={onCancel} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
          <XIcon size={14} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        <LField label="Finished SKU">
          <select style={inp()} value={finishedId} onChange={(e) => setFinishedId(e.target.value)}>
            <option value="">— Select item —</option>
            {itemLookup.finishedOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </LField>
        <LField label="Version">
          <input style={inp()} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1" />
        </LField>
        <LField label="Yield / batch">
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" min={0.0001} step="any" style={{ ...inp(), flex: 1 }}
              value={yieldQty} onChange={(e) => setYieldQty(e.target.value)} />
            <select value={yieldUom} onChange={(e) => setYieldUom(e.target.value)} style={{ ...inp(), width: 90 }}>
              {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </LField>
        <LField label="Effective date">
          <input type="date" style={inp()} value={effective} onChange={(e) => setEffective(e.target.value)} />
        </LField>
      </div>

      <BomLinesEditor
        lines={lines}
        setLines={setLines}
        itemLookup={itemLookup}
      />

      <div style={{ marginTop: 10 }}>
        <LField label="Notes">
          <textarea rows={2} style={{ ...inp(), width: '100%', resize: 'vertical', minHeight: 36 }}
            value={notes} onChange={(e) => setNotes(e.target.value)} />
        </LField>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button onClick={onCancel} style={btnSecondary()}>Cancel</button>
        <button onClick={submit} disabled={!canSave || saving} style={btnPrimary()}>
          {saving ? 'Creating…' : 'Create BOM'}
        </button>
      </div>
    </div>
  );
}

// ── Detail modal (edit lines, toggle active) ────────────────────────────

function BomDetailModal({ bomId, bom, itemLookup, onClose, onChanged }: {
  bomId: string;
  bom: ProductBom;
  itemLookup: ProductionItemLookup;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [lines, setLines] = useState<BomLineInput[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState(bom.is_active);

  useEffect(() => {
    let alive = true;
    fetchBomLines(bomId).then((ls) => {
      if (!alive) return;
      setLines(ls.map(bomLineToInput));
    }).catch(() => alive && setLines([]));
    return () => { alive = false; };
  }, [bomId]);

  const it = itemLookup.byId.get(bom.finished_qbo_item_id);

  async function saveLines() {
    if (!lines || !lines.every(validLine)) return;
    setSaving(true);
    try {
      await replaceBomLines(bomId, lines);
      toast.success('BOM lines saved');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  async function toggleActive() {
    setSaving(true);
    try {
      await updateBom(bomId, { is_active: !active });
      setActive(!active);
      toast.success(active ? 'Deactivated' : 'Activated');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
        maxWidth: 880, width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: 20,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
              BOM · v{bom.version} · yield {fmtQty(Number(bom.yield_qty), bom.yield_uom || 'each')} / batch
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 22, color: 'var(--ac)' }}>
              {it?.item_name ?? bom.finished_qbo_item_id}
            </h2>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
            <XIcon size={18} />
          </button>
        </div>

        <div style={{
          marginBottom: 14, padding: '8px 10px',
          background: 'rgba(91,181,240,0.04)', border: '1px solid var(--bd)', borderRadius: 4,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11,
        }}>
          <span>
            Status: <strong style={{ color: active ? 'var(--gn)' : 'var(--mt)' }}>
              {active ? 'ACTIVE' : 'INACTIVE'}
            </strong>
          </span>
          <button onClick={toggleActive} disabled={saving} style={btnSecondary()}>
            {active ? 'Deactivate' : 'Activate'}
          </button>
        </div>

        {lines === null
          ? <div style={{ padding: 18, color: 'var(--mt)' }}>Loading lines…</div>
          : <>
              <BomLinesEditor lines={lines} setLines={setLines} itemLookup={itemLookup} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <button onClick={onClose} style={btnSecondary()}>Close</button>
                <button onClick={saveLines} disabled={saving || !lines.every(validLine)} style={btnPrimary()}>
                  {saving ? 'Saving…' : 'Save lines'}
                </button>
              </div>
              <ScaleBomPanel bom={bom} lines={lines} itemLookup={itemLookup} />
            </>}
      </div>
    </div>
  );
}

// ── BOM lines sub-editor (shared by create form + detail modal) ─────────

function BomLinesEditor({ lines, setLines, itemLookup }: {
  lines: BomLineInput[];
  setLines: (next: BomLineInput[]) => void;
  itemLookup: ProductionItemLookup;
}) {
  function addComponent() { setLines([...lines, emptyComponentLine()]); }
  function addService()   { setLines([...lines, emptyServiceLine()]); }
  function rm(i: number)  { setLines(lines.filter((_, idx) => idx !== i)); }
  function patch(i: number, p: Partial<BomLineInput>) {
    setLines(lines.map((l, idx) => idx === i ? { ...l, ...p } : l));
  }

  return (
    <>
      <div style={{ marginTop: 14, fontSize: 10, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>
        Lines (per yield qty)
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bd)' }}>
            <th style={cellTh}>Type</th>
            <th style={cellTh}>Component / Service</th>
            <th style={{ ...cellTh, width: 80, textAlign: 'right' }}>Qty / yield</th>
            <th style={{ ...cellTh, width: 80 }}>UoM</th>
            <th style={{ ...cellTh, width: 80, textAlign: 'right' }}>Scrap %</th>
            <th style={{ ...cellTh, width: 100, textAlign: 'right' }}>Unit Cost</th>
            <th style={{ ...cellTh, width: 150 }}>Notes</th>
            <th style={{ ...cellTh, width: 36 }}> </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <td style={cellTd}>
                <select value={l.line_type} onChange={(e) => {
                  const t = e.target.value as 'component' | 'service';
                  patch(i, t === 'component'
                    ? { line_type: 'component', service_label: null }
                    : { line_type: 'service', component_qbo_item_id: null });
                }} style={{ ...inp(), width: '100%' }}>
                  <option value="component">Component</option>
                  <option value="service">Service</option>
                </select>
              </td>
              <td style={cellTd}>
                {l.line_type === 'component'
                  ? <select value={l.component_qbo_item_id ?? ''}
                      onChange={(e) => patch(i, { component_qbo_item_id: e.target.value || null })}
                      style={{ ...inp(), width: '100%' }}>
                      <option value="">— Select component —</option>
                      {itemLookup.componentOptions.map((o) =>
                        <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  : <input style={{ ...inp(), width: '100%' }} value={l.service_label ?? ''}
                      placeholder="e.g. Co-pack fee per case"
                      onChange={(e) => patch(i, { service_label: e.target.value || null })} />}
              </td>
              <td style={{ ...cellTd, textAlign: 'right' }}>
                <input type="number" min={0.0001} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }}
                  value={l.qty_per} onChange={(e) => patch(i, { qty_per: Number(e.target.value) })} />
              </td>
              <td style={cellTd}>
                <select value={l.qty_uom ?? 'each'} onChange={(e) => patch(i, { qty_uom: e.target.value })}
                  style={{ ...inp(), width: '100%' }}>
                  {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </td>
              <td style={{ ...cellTd, textAlign: 'right' }}>
                <input type="number" min={0} max={99} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }}
                  value={(l.scrap_pct ?? 0) * 100}
                  onChange={(e) => patch(i, { scrap_pct: Number(e.target.value) / 100 })} />
              </td>
              <td style={{ ...cellTd, textAlign: 'right' }}>
                <input type="number" min={0} step="any" style={{ ...inp(), width: '100%', textAlign: 'right' }}
                  value={l.default_cost ?? ''}
                  placeholder={l.line_type === 'component' && l.component_qbo_item_id
                    ? (itemLookup.byId.get(l.component_qbo_item_id)?.purchase_cost ?? '').toString()
                    : ''}
                  onChange={(e) => patch(i, { default_cost: e.target.value === '' ? null : Number(e.target.value) })} />
              </td>
              <td style={cellTd}>
                <input style={inp()} value={l.notes ?? ''}
                  onChange={(e) => patch(i, { notes: e.target.value || null })} />
              </td>
              <td style={{ ...cellTd, textAlign: 'right' }}>
                <button onClick={() => rm(i)} disabled={lines.length === 1}
                  style={{
                    background: 'transparent', border: 'none',
                    cursor: lines.length === 1 ? 'not-allowed' : 'pointer',
                    color: lines.length === 1 ? 'var(--mt)' : 'var(--rd)',
                    opacity: lines.length === 1 ? 0.4 : 1, padding: 4,
                  }}><Trash2 size={13} /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={addComponent} style={btnSecondary()}>+ Component</button>
        <button onClick={addService}   style={btnSecondary()}>+ Service</button>
      </div>
    </>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

function emptyComponentLine(): BomLineInput {
  return { line_type: 'component', component_qbo_item_id: null, qty_per: 1, qty_uom: 'each', scrap_pct: 0, default_cost: null, notes: null };
}
function emptyServiceLine(): BomLineInput {
  return { line_type: 'service', service_label: '', qty_per: 1, qty_uom: 'each', scrap_pct: 0, default_cost: null, notes: null };
}
function bomLineToInput(l: ProductBomLine): BomLineInput {
  return {
    line_type: l.line_type,
    component_qbo_item_id: l.component_qbo_item_id,
    service_label: l.service_label,
    qty_per: Number(l.qty_per),
    qty_uom: l.qty_uom || 'each',
    scrap_pct: Number(l.scrap_pct),
    default_cost: l.default_cost == null ? null : Number(l.default_cost),
    notes: l.notes,
  };
}
function validLine(l: BomLineInput): boolean {
  if (!(Number(l.qty_per) > 0)) return false;
  if (l.line_type === 'component') return !!l.component_qbo_item_id;
  return !!(l.service_label && l.service_label.trim());
}

function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 10, fontWeight: 600,
    letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)', ...style }}>{children}</th>;
}
function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: '7px 10px', verticalAlign: 'middle', ...style }}>{children}</td>;
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

// ── Scale this BOM calculator ───────────────────────────────────────────
//
// Live scratchpad inside the BOM detail modal. Operator types a target
// quantity + UoM ("make 1000 gal") and we multiply every line by the
// implied runs. Read-only — doesn't save anything, just shows the math
// so the operator can sanity-check a future work order.
function ScaleBomPanel({ bom, lines, itemLookup }: {
  bom: ProductBom;
  lines: BomLineInput[];
  itemLookup: ProductionItemLookup;
}) {
  const [targetQty, setTargetQty] = useState<string>(String(bom.yield_qty));
  const [targetUom, setTargetUom] = useState<string>(bom.yield_uom || 'each');

  const target = { qty: Number(targetQty) || 0, uom: targetUom };
  const yield_ = { qty: Number(bom.yield_qty), uom: bom.yield_uom || 'each' };
  const scaled = target.qty > 0
    ? scaleBom(target, yield_, lines.map((l, idx) => ({
        qty_per: Number(l.qty_per),
        qty_uom: l.qty_uom || 'each',
        ref: { line: l, idx },
      })))
    : null;
  const incompat = target.qty > 0 && scaled === null;

  return (
    <div style={{
      marginTop: 20, padding: 14, border: '1px solid var(--bd)', borderRadius: 6,
      background: 'rgba(91,181,240,0.04)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 10 }}>
        Scale this BOM
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12 }}>Make</span>
        <input type="number" min={0} step="any" style={{ ...inp(), width: 120, textAlign: 'right' }}
          value={targetQty} onChange={(e) => setTargetQty(e.target.value)} />
        <select value={targetUom} onChange={(e) => setTargetUom(e.target.value)} style={{ ...inp(), width: 100 }}>
          {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {scaled
          ? <span style={{ fontSize: 12, color: 'var(--mt)' }}>
              → <strong style={{ color: 'var(--tx)', fontFamily: 'var(--ff-mono)' }}>{scaled.runs.toLocaleString(undefined, { maximumFractionDigits: 4 })}</strong> {scaled.runs === 1 ? 'run' : 'runs'} of this BOM
            </span>
          : incompat
            ? <span style={{ fontSize: 11, color: 'var(--am)' }}>
                Can't convert {targetUom} → {yield_.uom}. Pick a UoM in the same family as the BOM yield, or type in {yield_.uom}.
              </span>
            : null}
      </div>

      {scaled && scaled.scaledLines.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--bd)' }}>
              <th style={cellTh}>Component / Service</th>
              <th style={{ ...cellTh, textAlign: 'right' }}>Per yield</th>
              <th style={{ ...cellTh, textAlign: 'right' }}>Required</th>
            </tr>
          </thead>
          <tbody>
            {scaled.scaledLines.map(({ qty, uom, ref }) => {
              const l = ref.line;
              const label = l.line_type === 'component'
                ? (l.component_qbo_item_id ? itemLookup.byId.get(l.component_qbo_item_id)?.item_name : null) ?? '(no component)'
                : (l.service_label || '(no label)');
              return (
                <tr key={ref.idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={cellTd}>{label}</td>
                  <td style={{ ...cellTd, textAlign: 'right', color: 'var(--mt)', fontFamily: 'var(--ff-mono)' }}>
                    {fmtQty(Number(l.qty_per), l.qty_uom || 'each')}
                  </td>
                  <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', fontWeight: 600 }}>
                    {fmtQty(qty, uom)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
