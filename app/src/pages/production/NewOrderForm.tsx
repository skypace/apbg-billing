// New production order — one document, several flavours, one purchase order per
// vendor for the lot. The preview is the SERVER's answer (fn_run_preview), not a
// client re-implementation: the same function that will create the run computes
// what each vendor's PO would carry — demand across every flavour, netted
// against stock already at the co-packer, lifted to the vendor's MOQ — so the
// form cannot disagree with the order it creates.
import { useEffect, useMemo, useState } from 'react';
import { Plus, X as XIcon, ShoppingCart } from 'lucide-react';
import type { ProductBom } from '../../lib/production';
import type { QboVendor } from '../../lib/purchasing';
import type { InventoryLocation } from '../../lib/inventoryControl';
import { createRun, previewRun, type RunLineInput, type RunPreview } from '../../lib/runs';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { fmtNum, fm } from '../../lib/formatters';
import type { ProductionItemLookup } from './ProductionPage';
import { LField, cellTh, cellTd, errMsg } from './productionUi';

interface LineDraft { key: number; bomId: string; qty: string; batchGal: string; galTouched: boolean }
let nextKey = 1;
function blankLine(): LineDraft { return { key: nextKey++, bomId: '', qty: '', batchGal: '', galTouched: false }; }

export function NewOrderForm({ boms, vendors, locations, itemLookup, onCancel, onCreated }: {
  boms: ProductBom[];
  vendors: QboVendor[];
  locations: InventoryLocation[];
  itemLookup: ProductionItemLookup;
  onCancel: () => void;
  onCreated: (runId: string) => void;
}) {
  const toast = useToast();
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);
  const [copackerVendor, setCopackerVendor] = useState('');
  const [copackerLoc, setCopackerLoc] = useState('');
  const [destLoc, setDestLoc] = useState('');
  const [scheduled, setScheduled] = useState('');
  const [tank, setTank] = useState('');
  const [notes, setNotes] = useState('');
  const [netStock, setNetStock] = useState(true);
  const [preview, setPreview] = useState<RunPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const copackerLocs = useMemo(
    () => [...locations].filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment')
      .sort((a, b) => (a.kind === 'co_packer' ? 0 : 1) - (b.kind === 'co_packer' ? 0 : 1) || a.code.localeCompare(b.code)),
    [locations],
  );
  const warehouses = useMemo(
    () => locations.filter((l) => l.is_active && l.kind !== 'in_transit' && l.kind !== 'adjustment' && l.kind !== 'co_packer'),
    [locations],
  );

  // Defaults: the co-packer location, and the co-packer vendor the BOMs already
  // name — a run with one co-packer should not need that picked twice.
  useEffect(() => {
    if (!copackerLoc) { const cp = copackerLocs.find((l) => l.kind === 'co_packer'); if (cp) setCopackerLoc(cp.id); }
    // Our own warehouse is where finished goods come home; a partner's building is
    // the exception, so it is offered, never defaulted.
    if (!destLoc) { const wh = warehouses.find((l) => l.kind === 'warehouse' && /^BRIX/i.test(l.code)) ?? (warehouses.length === 1 ? warehouses[0] : null); if (wh) setDestLoc(wh.id); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copackerLocs, warehouses]);
  useEffect(() => {
    if (copackerVendor) return;
    const q = vendors.find((v) => /quantum/i.test(v.display_name));
    if (q) setCopackerVendor(q.qbo_vendor_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendors]);

  const validLines: RunLineInput[] = useMemo(() => lines
    .filter((l) => l.bomId && Number(l.qty) > 0)
    .map((l) => ({ bom_id: l.bomId, qty_to_produce: Number(l.qty), batch_size_gal: l.batchGal ? Number(l.batchGal) : null })),
  [lines]);
  const dupBom = useMemo(() => {
    const seen = new Set<string>(); for (const l of validLines) { if (seen.has(l.bom_id)) return true; seen.add(l.bom_id); } return false;
  }, [validLines]);

  // Suggested batch gallons per line from the BOM geometry (cases × cans × oz ÷ 128).
  function setLine(key: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l) => {
      if (l.key !== key) return l;
      const n = { ...l, ...patch };
      if (!n.galTouched && n.bomId && Number(n.qty) > 0) {
        const b = boms.find((x) => x.id === n.bomId);
        const gal = b ? Number(n.qty) * Number(b.cans_per_case || 24) * Number(b.oz_per_can || 12) / 128 : 0;
        n.batchGal = gal > 0 ? String(Math.round(gal * 100) / 100) : '';
      }
      return n;
    }));
  }

  // Debounced server preview — one round trip per pause in typing.
  useEffect(() => {
    if (!copackerVendor || !copackerLoc || validLines.length === 0 || dupBom) { setPreview(null); setPreviewErr(null); return; }
    let alive = true; setPreviewing(true);
    const h = setTimeout(() => {
      previewRun(validLines, copackerVendor, copackerLoc, netStock)
        .then((p) => { if (alive) { setPreview(p); setPreviewErr(null); } })
        .catch((e) => { if (alive) { setPreview(null); setPreviewErr(errMsg(e)); } })
        .finally(() => { if (alive) setPreviewing(false); });
    }, 400);
    return () => { alive = false; clearTimeout(h); };
  }, [validLines, copackerVendor, copackerLoc, netStock, dupBom]);

  const blockers = preview?.blockers ?? [];
  const canSave = validLines.length > 0 && !dupBom && !!copackerVendor && !!copackerLoc && !!destLoc && !saving;

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      const id = await createRun({
        lines: validLines, copacker_qbo_vendor_id: copackerVendor, copacker_location_id: copackerLoc, destination_location_id: destLoc,
        scheduled_date: scheduled || null, tank_size_gal: tank ? Number(tank) : null, notes: notes || null, net_against_stock: netStock,
      });
      toast.success(`Production order created — ${validLines.length} flavour${validLines.length === 1 ? '' : 's'}, materials calculated`);
      onCreated(id);
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  const bomLabel = (b: ProductBom) => `${itemLookup.byId.get(b.finished_qbo_item_id)?.item_name ?? b.finished_qbo_item_id}${b.name ? ` · ${b.name}` : ''} · v${b.version}`;

  return (
    <div className="cd" style={{ padding: 14, marginBottom: 14 }} data-testid="new-order-form">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
          New production order — which flavours, how many cases, one purchase order per vendor
        </div>
        <button onClick={onCancel} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }} aria-label="Close">
          <XIcon size={14} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        <LField label="Co-packer (vendor)">
          <select style={inp()} value={copackerVendor} onChange={(e) => setCopackerVendor(e.target.value)} aria-label="Co-packer vendor">
            <option value="">—</option>
            {vendors.map((v) => <option key={v.qbo_vendor_id} value={v.qbo_vendor_id}>{v.display_name}</option>)}
          </select>
        </LField>
        <LField label="Co-packer location (materials ship here)">
          <select style={inp()} value={copackerLoc} onChange={(e) => setCopackerLoc(e.target.value)} aria-label="Co-packer location">
            <option value="">—</option>
            {copackerLocs.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
          </select>
        </LField>
        <LField label="Finished goods return to">
          <select style={inp()} value={destLoc} onChange={(e) => setDestLoc(e.target.value)} aria-label="Destination">
            <option value="">—</option>
            {warehouses.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
          </select>
        </LField>
        <LField label="Scheduled date">
          <input type="date" style={inp()} value={scheduled} onChange={(e) => setScheduled(e.target.value)} />
        </LField>
        <LField label="Tank size (gal, optional)">
          <input type="number" min={0} step="any" style={inp()} value={tank} onChange={(e) => setTank(e.target.value)} />
        </LField>
        <LField label="Notes">
          <input style={inp()} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </LField>
      </div>

      {/* Lines */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
          Flavours on this order — each becomes its own work order (its own yield, lots and cost)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 150px 28px', gap: 8, marginBottom: 4, fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          <span>Bill of materials</span><span>Cases</span><span>Batch (gal)</span><span />
        </div>
        {lines.map((l) => (
          <div key={l.key} style={{ display: 'grid', gridTemplateColumns: '1fr 140px 150px 28px', gap: 8, marginBottom: 6 }} data-testid="order-line">
            <select style={inp()} value={l.bomId} onChange={(e) => setLine(l.key, { bomId: e.target.value })} aria-label="Bill of materials">
              <option value="">—</option>
              {boms.map((b) => <option key={b.id} value={b.id}>{bomLabel(b)}</option>)}
            </select>
            <input type="number" min={1} step="any" style={inp()} value={l.qty} placeholder="cases" aria-label="Cases"
              onChange={(e) => setLine(l.key, { qty: e.target.value })} />
            <input type="number" min={0} step="any" style={inp()} value={l.batchGal} placeholder="from formula" aria-label="Batch gallons"
              onChange={(e) => setLine(l.key, { batchGal: e.target.value, galTouched: true })} />
            <button type="button" aria-label="Remove flavour" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}
              disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><XIcon size={13} /></button>
          </div>
        ))}
        <button type="button" style={btnSecondary()} onClick={() => setLines((ls) => [...ls, blankLine()])}>
          <Plus size={11} style={{ marginRight: 3, verticalAlign: -1 }} /> Add flavour
        </button>
        {dupBom && <span style={{ marginLeft: 10, fontSize: 11, color: 'var(--am)' }}>The same bill of materials is on two lines — add the cases together instead.</span>}
        <label style={{ marginLeft: 16, fontSize: 11, color: 'var(--mt)' }}>
          <input type="checkbox" checked={netStock} onChange={(e) => setNetStock(e.target.checked)} style={{ marginRight: 6 }} />
          Use raw materials already at the co-packer before ordering more
        </label>
      </div>

      {/* Server preview */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
          <ShoppingCart size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          Purchase orders this order raises{previewing ? ' · calculating…' : preview ? ` · ${preview.pos.length}` : ''}
        </div>
        {previewErr && <div style={{ fontSize: 11, color: 'var(--rd)' }}>{previewErr}</div>}
        {!preview && !previewErr && (
          <div style={{ fontSize: 11, color: 'var(--mt)' }}>Pick a co-packer and at least one flavour with a quantity to see the per-vendor purchase orders.</div>
        )}
        {preview && preview.pos.map((po) => (
          <div key={po.qbo_vendor_id ?? 'none'} style={{ marginBottom: 12, border: '1px solid var(--bd)', borderRadius: 5, overflow: 'hidden' }} data-testid="preview-po">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: 'rgba(255,255,255,0.03)', fontSize: 11.5 }}>
              <span><strong style={{ color: po.qbo_vendor_id ? 'var(--tx)' : 'var(--am)' }}>{po.vendor_name}</strong>
                <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--mt)' }}>
                  {po.close_rule === 'on_run_yield' ? 'closes when the run ships — nothing is received' : 'closes on receipt at the co-packer'}
                </span></span>
              <strong style={{ fontFamily: 'var(--ff-mono)' }}>{fm(po.subtotal)}</strong>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                  <th style={cellTh}>Item</th>
                  <th style={{ ...cellTh, textAlign: 'right' }} title="Σ what every flavour on the order needs">Needed</th>
                  <th style={{ ...cellTh, textAlign: 'right' }} title="Already at the co-packer and not spoken for by another run">From stock</th>
                  <th style={{ ...cellTh, textAlign: 'right' }} title="MOQ and order multiple applied; the surplus stays at the co-packer as stock">Ordered</th>
                  <th style={{ ...cellTh, textAlign: 'right' }}>Unit $</th>
                  <th style={{ ...cellTh, textAlign: 'right' }}>Ext $</th>
                </tr>
              </thead>
              <tbody>
                {po.lines.map((ln) => (
                  <tr key={ln.qbo_item_id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={cellTd}>
                      <strong>{ln.item_name}</strong>
                      {!ln.receivable && <span style={{ marginLeft: 6, fontSize: 9.5, color: 'var(--mt)' }}>{ln.item_type === 'Service' ? 'service — not received' : 'closes with the run'}</span>}
                      <div style={{ fontSize: 9.5, color: 'var(--mt)' }}>{ln.from.map((f) => `${f.bom} ${fmtNum(f.qty, 2)}`).join(' · ')}</div>
                    </td>
                    <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>{fmtNum(ln.demand, 2)}</td>
                    <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: ln.use_stock > 0 ? 'var(--gn)' : 'var(--mt)' }}>
                      {ln.use_stock > 0 ? '−' + fmtNum(ln.use_stock, 2) : '—'}
                      {ln.on_hand > 0 && <div style={{ fontSize: 9.5, color: 'var(--mt)' }}>{fmtNum(ln.available, 2)} of {fmtNum(ln.on_hand, 2)} free</div>}
                    </td>
                    <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                      {fmtNum(ln.ordered, 2)}
                      {ln.surplus > 0.000001 && (
                        <span style={{ color: 'var(--am)', marginLeft: 6, fontSize: 10 }} title="Surplus — stays at the co-packer for the next order">
                          +{fmtNum(ln.surplus, 2)} {ln.moq != null && ln.ordered <= ln.moq ? 'MOQ' : 'pack'}
                        </span>
                      )}
                    </td>
                    <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>{ln.unit_cost == null ? '—' : '$' + Number(ln.unit_cost).toFixed(4)}</td>
                    <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fm(ln.ext)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {preview && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', fontSize: 12 }}>
            Materials for the order: <strong style={{ marginLeft: 6, fontFamily: 'var(--ff-mono)' }}>{fm(preview.total)}</strong>
          </div>
        )}
        {blockers.length > 0 && (
          <div style={{ marginTop: 8, padding: 8, borderRadius: 4, background: 'rgba(245,158,11,0.10)', border: '1px solid var(--am)', fontSize: 11 }}>
            <strong style={{ color: 'var(--am)' }}>Fix before pushing to QuickBooks</strong>
            {blockers.map((b, i) => (
              <div key={i} style={{ marginTop: 3, color: 'var(--mt)' }}>
                <span style={{ color: 'var(--tx)' }}>{b.item_name ?? b.kind}</span> — {b.detail}
                <span style={{ color: 'var(--mt)' }}> ({preview?.lines.find((l) => l.bom_id === b.bom_id)?.bom_name ?? 'BOM'})</span>
              </div>
            ))}
          </div>
        )}
        {(preview?.warnings ?? []).length > 0 && (
          <div style={{ marginTop: 8, padding: 8, borderRadius: 4, background: 'rgba(255,255,255,0.03)', border: '1px dashed var(--bd)', fontSize: 11 }}>
            <strong>Worth a look — this will still post</strong>
            {preview!.warnings.map((w, i) => (
              <div key={i} style={{ marginTop: 3, color: 'var(--mt)' }}><span style={{ color: 'var(--tx)' }}>{w.item_name ?? w.kind}</span> — {w.detail}</div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button style={btnSecondary()} onClick={onCancel} disabled={saving}>Cancel</button>
        <button style={btnPrimary()} disabled={!canSave} onClick={submit}
          title={!destLoc ? 'Pick where the finished goods return to' : undefined}>
          {saving ? 'Creating…' : `Create production order${validLines.length > 1 ? ` · ${validLines.length} flavours` : ''}`}
        </button>
      </div>
    </div>
  );
}
