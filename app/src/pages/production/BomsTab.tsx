import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, X as XIcon } from 'lucide-react';
import {
  BomLineInput, ProductBom, ProductBomLine,
  createBom, fetchBomLines, replaceBomLines, updateBom,
} from '../../lib/production';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, btnDanger, inp } from '../../lib/styles';
import { UOM_OPTIONS, scaleBom, fmtQty, uomGroup } from '../../lib/uom';
import type { ProductionItemLookup } from './ProductionPage';

interface Props {
  boms: ProductBom[] | null;
  itemLookup: ProductionItemLookup;
  onChanged: () => void;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/** Friendly display label for a BOM. Falls back to "Version N" so the
 *  table never shows blank cells for older rows that pre-date the name
 *  field (migration backfill handles existing data; this is the runtime
 *  safety net for any future null). */
function bomLabel(b: ProductBom): string {
  return (b.name && b.name.trim()) || `Version ${b.version}`;
}

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
              <Th>Name</Th>
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
                  <Td>
                    <div style={{ fontWeight: 600, color: 'var(--tx)' }}>{bomLabel(b)}</div>
                    <div style={{ fontSize: 10, color: 'var(--mt)', fontFamily: 'var(--ff-mono)', marginTop: 1 }}>
                      v{b.version}
                    </div>
                  </Td>
                  <Td style={{ textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                    {fmtQty(Number(b.yield_qty), b.yield_uom || 'each')}
                  </Td>
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
  const [name, setName] = useState('');
  const [yieldQty, setYieldQty] = useState<string>('1');
  const [yieldUom, setYieldUom] = useState<string>('each');
  // Volume bridge: only meaningful when yield is a count UoM (each/case) and
  // 1 yield produces a known volume of finished product. Lets the scaler
  // accept "make 1000 gal" against a per-case BOM.
  const [finishedGal, setFinishedGal] = useState<string>('');
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
        finished_vol_per_yield_gal: finishedGal.trim() === '' ? null : Number(finishedGal),
        lines,
        version,
        name: name.trim() === '' ? null : name.trim(),
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
        <LField label="Name (optional)">
          <input style={inp()} value={name} onChange={(e) => setName(e.target.value)}
            placeholder='e.g. "Cola — 1000 gal batch"' />
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
        {uomGroup(yieldUom) === 'count' && (
          <LField label="Gal of finished product / yield (optional)">
            <input type="number" min={0} step="any" style={inp()}
              value={finishedGal} onChange={(e) => setFinishedGal(e.target.value)}
              placeholder="e.g. 2.25 — enables scaling by gallons" />
          </LField>
        )}
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

// ── Detail modal (edit lines, toggle active, rename) ───────────────────

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
  const [name, setName] = useState<string>(bom.name ?? '');
  // Local-edit copy of the gal-per-yield bridge. Persists via updateBom on
  // blur so the BOM scaler can convert "make N gal" → runs without a
  // save + reopen.
  const [finishedGal, setFinishedGal] = useState<string>(
    bom.finished_vol_per_yield_gal == null ? '' : String(bom.finished_vol_per_yield_gal),
  );

  useEffect(() => {
    let alive = true;
    fetchBomLines(bomId).then((ls) => {
      if (!alive) return;
      setLines(ls.map(bomLineToInput));
    }).catch(() => alive && setLines([]));
    return () => { alive = false; };
  }, [bomId]);

  // Target volume for scaling — drives the "Required for batch" column in
  // BomLinesEditor. Held here so a single input at the top controls the rows.
  const [targetQty, setTargetQty] = useState<string>('');
  const [targetUom, setTargetUom] = useState<string>(bom.yield_uom || 'each');

  const it = itemLookup.byId.get(bom.finished_qbo_item_id);

  const bridgeGal = useMemo(() => {
    const live = finishedGal.trim();
    if (live !== '') return Number(live);
    return bom.finished_vol_per_yield_gal == null ? undefined : Number(bom.finished_vol_per_yield_gal);
  }, [finishedGal, bom.finished_vol_per_yield_gal]);

  const scaling = useMemo(() => {
    const tQty = Number(targetQty) || 0;
    if (!lines || tQty <= 0) return { scaled: null, incompat: false, scaledByIdx: new Map<number, { qty: number; uom: string }>() };
    const yieldDef = { qty: Number(bom.yield_qty), uom: bom.yield_uom || 'each', finishedVolPerYieldGal: bridgeGal };
    const out = scaleBom(
      { qty: tQty, uom: targetUom },
      yieldDef,
      lines.map((l, idx) => ({
        qty_per: Number(l.qty_per),
        qty_uom: l.qty_uom || 'each',
        scrap_pct: Number(l.scrap_pct ?? 0),
        ref: { idx },
      })),
    );
    const map = new Map<number, { qty: number; uom: string }>();
    if (out) for (const s of out.scaledLines) map.set(s.ref.idx, { qty: s.qty, uom: s.uom });
    return { scaled: out, incompat: out === null, scaledByIdx: map };
  }, [lines, bom.yield_qty, bom.yield_uom, bridgeGal, targetQty, targetUom]);

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

  async function saveName() {
    const next = name.trim() === '' ? null : name.trim();
    const prev = bom.name ?? null;
    if (next === prev) return;
    try {
      await updateBom(bomId, { name: next });
      toast.success(next ? `Renamed to "${next}"` : 'Name cleared');
      // No onChanged — autosave-on-blur, parent treats that as "close+refresh".
      // Next fetchBoms will pick it up; the detail modal keeps the live state.
    } catch (e) { toast.error(errMsg(e)); }
  }

  async function saveFinishedGal() {
    const next = finishedGal.trim() === '' ? null : Number(finishedGal);
    // Coerce prev: PostgREST returns numeric as JSON string, so comparing a
    // typed number against bom.finished_vol_per_yield_gal directly always
    // misses (same gotcha as bom.yield_qty in the detail header).
    const prev = bom.finished_vol_per_yield_gal == null
      ? null
      : Number(bom.finished_vol_per_yield_gal);
    if (next === prev || (next !== null && !Number.isFinite(next))) return;
    try {
      await updateBom(bomId, { finished_vol_per_yield_gal: next });
    } catch (e) { toast.error(errMsg(e)); }
  }

  const displayName = (name && name.trim()) || `Version ${bom.version}`;

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '90px 20px 20px', overflowY: 'auto',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
        maxWidth: 1080, width: '100%', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto', padding: 20,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
              BOM · {displayName} · v{bom.version} · yield {fmtQty(Number(bom.yield_qty), bom.yield_uom || 'each')} / batch
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 22, color: 'var(--ac)' }}>
              {it?.item_name ?? bom.finished_qbo_item_id}
            </h2>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
            <XIcon size={18} />
          </button>
        </div>

        {/* Rename row */}
        <div style={{
          marginBottom: 14, padding: '8px 10px',
          border: '1px solid var(--bd)', borderRadius: 4, fontSize: 11,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ color: 'var(--mt)' }}>Name</span>
          <input style={{ ...inp(), flex: 1 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            placeholder='e.g. "Cola — 1000 gal batch"' />
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

        {uomGroup(bom.yield_uom || 'each') === 'count' && (
          <div style={{
            marginBottom: 10, padding: '8px 10px',
            border: '1px solid var(--bd)', borderRadius: 4, fontSize: 11,
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{ color: 'var(--mt)' }}>
              1 {bom.yield_uom || 'each'} produces
            </span>
            <input type="number" min={0} step="any" style={{ ...inp(), width: 100 }}
              value={finishedGal}
              onChange={(e) => setFinishedGal(e.target.value)}
              onBlur={saveFinishedGal}
              placeholder="—" />
            <span style={{ color: 'var(--mt)' }}>
              gal of finished product (enables "make N gal" scaling)
            </span>
          </div>
        )}

        {/* Scale-to-batch input — drives the Required column in the BOM lines editor below. */}
        <div style={{
          marginBottom: 14, padding: '10px 12px',
          border: '1px solid var(--bd)', borderRadius: 4, fontSize: 12,
          background: 'rgba(91,181,240,0.04)',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={{ color: 'var(--mt)', fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            Scale to make
          </span>
          <input type="number" min={0} step="any" style={{ ...inp(), width: 110, textAlign: 'right' }}
            value={targetQty}
            onChange={(e) => setTargetQty(e.target.value)}
            placeholder="qty" />
          <select value={targetUom} onChange={(e) => setTargetUom(e.target.value)} style={{ ...inp(), width: 110 }}>
            {UOM_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {scaling.scaled ? (
            <span style={{ color: 'var(--mt)' }}>
              → <strong style={{ color: 'var(--ac)', fontFamily: 'var(--ff-mono)' }}>
                {scaling.scaled.runs.toLocaleString(undefined, { maximumFractionDigits: 4 })}
              </strong> {scaling.scaled.runs === 1 ? 'run' : 'runs'} · BOM lines below show required quantities for this batch
            </span>
          ) : scaling.incompat ? (
            <span style={{ color: 'var(--am)', fontSize: 11 }}>
              Can't convert {targetUom} → {bom.yield_uom || 'each'}.
              {uomGroup(targetUom) === 'volume' && uomGroup(bom.yield_uom || 'each') === 'count' && bridgeGal == null
                ? <> Set "1 {bom.yield_uom || 'each'} produces ___ gal" above.</>
                : <> Enter the target in {bom.yield_uom || 'each'}.</>}
            </span>
          ) : (
            <span style={{ color: 'var(--mt)', fontSize: 11 }}>
              Enter a target qty to see Required columns auto-populate.
            </span>
          )}
        </div>

        {lines === null
          ? <div style={{ padding: 18, color: 'var(--mt)' }}>Loading lines…</div>
          : <>
              <BomLinesEditor
                lines={lines}
                setLines={setLines}
                itemLookup={itemLookup}
                scaledByIdx={scaling.scaledByIdx}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <button onClick={onClose} style={btnSecondary()}>Close</button>
                <button onClick={saveLines} disabled={saving || !lines.every(validLine)} style={btnPrimary()}>
                  {saving ? 'Saving…' : 'Save lines'}
                </button>
              </div>
            </>}
      </div>
    </div>
  );
}

// ── BOM lines sub-editor (shared by create form + detail modal) ─────────

function BomLinesEditor({ lines, setLines, itemLookup, scaledByIdx }: {
  lines: BomLineInput[];
  setLines: (next: BomLineInput[]) => void;
  itemLookup: ProductionItemLookup;
  /** Per-row scaled qty + uom keyed by line index. Empty Map = no scaling
   *  active; the Required column renders "—". */
  scaledByIdx?: Map<number, { qty: number; uom: string }>;
}) {
  const showRequired = (scaledByIdx?.size ?? 0) > 0;

  function addComponent() { setLines([...lines, emptyComponentLine()]); }
  function addService()   { setLines([...lines, emptyServiceLine()]); }
  function rm(i: number)  { setLines(lines.filter((_, idx) => idx !== i)); }
  function patch(i: number, p: Partial<BomLineInput>) {
    setLines(lines.map((l, idx) => idx === i ? { ...l, ...p } : l));
  }

  return (
    <>
      <div style={{ marginTop: 14, fontSize: 10, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>
        Lines (per yield qty){showRequired ? ' · Required column shows scaled batch quantities' : ''}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--bd)' }}>
            <th style={cellTh}>Type</th>
            <th style={cellTh}>Component / Service</th>
            <th style={{ ...cellTh, width: 80, textAlign: 'right' }}>Qty / yield</th>
            <th style={{ ...cellTh, width: 80 }}>UoM</th>
            {showRequired && (
              <th style={{ ...cellTh, width: 110, textAlign: 'right', color: 'var(--ac)' }}>Required</th>
            )}
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
              {showRequired && (
                <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', fontWeight: 600, color: 'var(--ac)' }}>
                  {scaledByIdx?.has(i)
                    ? fmtQty(scaledByIdx.get(i)!.qty, scaledByIdx.get(i)!.uom)
                    : <span style={{ color: 'var(--mt)' }}>—</span>}
                </td>
              )}
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

