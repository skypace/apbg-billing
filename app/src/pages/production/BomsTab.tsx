import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Plus, X as XIcon, FlaskConical } from 'lucide-react';
import {
  BomLineInput, BomLineType, BomQtyBasis, ProductBom, ProductBomLine,
  fetchBomLines, saveBomV2, updateBom,
} from '../../lib/production';
import { ProductFormula } from '../../lib/formulas';
import {
  BatchBasis, CaseRequirement, BomSyncResult, BomPreflight,
  fetchBatchBasis, fetchCaseRequirements, syncBomFromFormula, fetchBomPreflight,
} from '../../lib/rawMaterials';
import { QboVendor } from '../../lib/purchasing';
import { ProductionItem, fetchProductionItems } from '../../lib/rawMaterials';
import { componentVendorId, masterIndex } from '../../lib/componentSourcing';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { GRID_SX, GRID_DEFAULTS } from '../stock/stockStyles';
import type { ProductionItemLookup } from './ProductionPage';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

interface Props {
  boms: ProductBom[] | null;
  formulas: ProductFormula[] | null;
  vendors: QboVendor[] | null;
  itemLookup: ProductionItemLookup;
  onChanged: () => void;
}

// The redesigned BOM is a pure parts list: the sellable finished item, the
// sub-items that make it up (each with its vendor), and the formula / spec
// sheet it's built from. NO quantity math lives here — every total is
// calculated on the work order.
export function BomsTab({ boms, formulas, vendors, itemLookup, onChanged }: Props) {
  const [editing, setEditing] = useState<ProductBom | 'new' | null>(null);
  const toast = useToast();

  const formulaById = useMemo(() => {
    const m = new Map<string, ProductFormula>();
    for (const f of formulas ?? []) m.set(f.id, f);
    return m;
  }, [formulas]);

  const rows = useMemo(() => (boms ?? []).map((b) => ({
    ...b,
    finished_label: itemLookup.byId.get(b.finished_qbo_item_id)?.item_name ?? b.finished_qbo_item_id,
    formula_label: b.formula_id ? (formulaById.get(b.formula_id)?.name ?? '…') : null,
  })), [boms, itemLookup, formulaById]);

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'finished_label', headerName: 'Sellable item', flex: 1, minWidth: 220,
      renderCell: (p) => (
        <button onClick={() => setEditing((boms ?? []).find((b) => b.id === p.row.id) ?? null)} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--ac)', fontWeight: 700, padding: 0, fontSize: 12.5, textAlign: 'left',
        }}>{String(p.value ?? '')}</button>
      ),
    },
    { field: 'name', headerName: 'BOM name', flex: 1, minWidth: 160,
      valueFormatter: (v) => v ? String(v) : '—' },
    {
      field: 'formula_label', headerName: 'Formula / spec sheet', flex: 1, minWidth: 190,
      renderCell: (p) => p.value
        ? <span style={{ fontSize: 11 }}>
            <FlaskConical size={11} style={{ verticalAlign: -1, marginRight: 4, color: 'var(--ac)' }} />
            {String(p.value)}
          </span>
        : <span style={{ color: 'var(--am)', fontSize: 11 }}>no formula linked</span>,
    },
    { field: 'version', headerName: 'Ver', width: 60, cellClassName: 'mn' },
    {
      field: 'is_active', headerName: 'Active', width: 90,
      renderCell: (p) => {
        const active = Boolean(p.value);
        return <span style={{
          color: active ? 'var(--gn)' : 'var(--mt)', fontSize: 9, fontWeight: 700,
          border: `1px solid ${active ? 'var(--gn)' : 'var(--mt)'}`, padding: '1px 7px', borderRadius: 12,
        }}>{active ? 'ACTIVE' : 'OFF'}</span>;
      },
    },
    { field: 'cans_per_case', headerName: 'Cans/case', width: 90, cellClassName: 'mn' },
    { field: 'oz_per_can', headerName: 'Oz/can', width: 80, cellClassName: 'mn' },
    { field: 'updated_at', headerName: 'Updated', width: 155,
      valueFormatter: (v) => v ? new Date(String(v)).toLocaleString() : '—' },
  ], [boms]);

  async function toggleActive(bom: ProductBom) {
    try {
      await updateBom(bom.id, { is_active: !bom.is_active } as Partial<ProductBom>);
      toast.success(bom.is_active ? 'BOM deactivated' : 'BOM activated');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
  }

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--mt)' }}>
            A BOM is the sellable item + the sub-items that make it up, tied to its formula.
            Quantities here are <strong>per finished unit</strong> — totals are calculated on the work order.
          </span>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button onClick={() => setEditing('new')} style={btnPrimary()}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> New BOM
          </button>
        </div>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        <DataGridPro
          rows={rows}
          columns={columns}
          {...GRID_DEFAULTS}
          sx={GRID_SX}
          density="compact"
          loading={boms === null}
          disableRowSelectionOnClick
        />
      </div>

      {editing && (
        <BomEditModal
          bom={editing === 'new' ? null : editing}
          formulas={formulas ?? []}
          vendors={vendors ?? []}
          itemLookup={itemLookup}
          onToggleActive={editing !== 'new' ? () => { void toggleActive(editing as ProductBom); setEditing(null); } : undefined}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
        />
      )}
    </div>
  );
}

// ── Edit / create ────────────────────────────────────────────────────────

interface LineRow {
  line_type: BomLineType;
  component_qbo_item_id: string;
  service_label: string;
  qty_per: string;
  qty_uom: string;
  qty_basis: BomQtyBasis;
  scrap_pct: string;   // percent, e.g. "2" = 2%
  default_cost: string;
  vendor_id: string;
  notes: string;
}

const EMPTY_LINE: LineRow = {
  line_type: 'component', component_qbo_item_id: '', service_label: '',
  qty_per: '', qty_uom: 'each', qty_basis: 'per_yield', scrap_pct: '', default_cost: '', vendor_id: '', notes: '',
};

function BomEditModal({ bom, formulas, vendors, itemLookup, onToggleActive, onClose, onSaved }: {
  bom: ProductBom | null;
  formulas: ProductFormula[];
  vendors: QboVendor[];
  itemLookup: ProductionItemLookup;
  onToggleActive?: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isNew = bom == null;
  const [finishedId, setFinishedId] = useState(bom?.finished_qbo_item_id ?? '');
  const [name, setName] = useState(bom?.name ?? '');
  const [version, setVersion] = useState(bom?.version ?? '1');
  const [formulaId, setFormulaId] = useState(bom?.formula_id ?? '');
  const [cansPerCase, setCansPerCase] = useState(String(bom?.cans_per_case ?? 24));
  const [ozPerCan, setOzPerCan] = useState(String(bom?.oz_per_can ?? 12));
  const [notes, setNotes] = useState(bom?.notes ?? '');
  const [lines, setLines] = useState<LineRow[]>([{ ...EMPTY_LINE }]);
  const [recipeLines, setRecipeLines] = useState<ProductBomLine[]>([]);
  const [reqs, setReqs] = useState<CaseRequirement[] | null>(null);
  const [basis, setBasis] = useState<BatchBasis | null>(null);
  const [preflight, setPreflight] = useState<BomPreflight | null>(null);
  const [masterItems, setMasterItems] = useState<ProductionItem[]>([]);
  const [rebuilding, setRebuilding] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchProductionItems().then((r) => { if (alive) setMasterItems(r); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!bom) return;
    let alive = true;
    fetchBomLines(bom.id).then((all: ProductBomLine[]) => {
      if (!alive) return;
      // Only the hand-entered lines are editable here. The ingredient lines
      // belong to the formula and are shown read-only in the Recipe panel —
      // loading them into this form would re-save them as manual and the next
      // rebuild would add a second copy of the whole recipe.
      setRecipeLines(all.filter((l) => l.source === 'formula'));
      const rows = all.filter((l) => l.source !== 'formula');
      setLines(rows.length ? rows.map((l) => ({
        line_type: l.line_type,
        component_qbo_item_id: l.component_qbo_item_id ?? '',
        service_label: l.service_label ?? '',
        qty_per: String(l.qty_per),
        qty_uom: l.qty_uom || 'each',
        qty_basis: l.qty_basis ?? 'per_yield',
        scrap_pct: l.scrap_pct ? String(Number(l.scrap_pct) * 100) : '',
        default_cost: l.default_cost != null ? String(l.default_cost) : '',
        vendor_id: l.preferred_qbo_vendor_id ?? '',
        notes: l.notes ?? '',
      })) : [{ ...EMPTY_LINE }]);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [bom]);

  const validLines = lines.filter((l) =>
    Number(l.qty_per) > 0 &&
    (l.line_type === 'component' ? l.component_qbo_item_id : l.service_label.trim()));
  const canSave = !!finishedId && (validLines.length > 0 || (!isNew && recipeLines.length > 0));
  // A component with no vendor on its LINE is fine when Materials & Pricing
  // has one — the line slot is an override, not the default. The pre-flight
  // (server-side, master-aware) is the authority once it has loaded.
  const masters = useMemo(() => masterIndex(masterItems), [masterItems]);
  const vendorName = (id: string | null | undefined) => vendors.find((v) => v.qbo_vendor_id === id)?.display_name ?? null;
  const missingVendors = preflight
    ? preflight.blockers.filter((b) => b.kind === 'no_vendor').length
    : validLines.filter((l) => l.line_type === 'component'
        && !componentVendorId({ component_qbo_item_id: l.component_qbo_item_id, preferred_qbo_vendor_id: l.vendor_id || null, qty_per: l.qty_per }, masters)).length;
  // The picker lists the stocked components (track_locations), every item
  // Materials & Pricing knows, and whatever the lines already reference —
  // the gallon, tolling, cans and Velcorin are none of them tracked by
  // location, and a line whose item the picker cannot name reads as blank.
  const componentOptions = useMemo(() => {
    const seen = new Map<string, string>(itemLookup.componentOptions.map((o) => [o.id, o.label]));
    for (const m of masterItems) if (!seen.has(m.qbo_item_id)) seen.set(m.qbo_item_id, m.item_name);
    for (const l of lines) {
      if (l.component_qbo_item_id && !seen.has(l.component_qbo_item_id)) {
        seen.set(l.component_qbo_item_id, itemLookup.byId.get(l.component_qbo_item_id)?.item_name ?? l.component_qbo_item_id);
      }
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [itemLookup, masterItems, lines]);

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload: BomLineInput[] = validLines.map((l) => ({
        line_type: l.line_type,
        component_qbo_item_id: l.line_type === 'component' ? l.component_qbo_item_id : null,
        service_label: l.line_type === 'service' ? l.service_label.trim() : null,
        qty_per: Number(l.qty_per),
        qty_uom: l.qty_uom || 'each',
        qty_basis: l.qty_basis,
        scrap_pct: l.scrap_pct ? Number(l.scrap_pct) / 100 : 0,
        default_cost: l.default_cost ? Number(l.default_cost) : null,
        preferred_qbo_vendor_id: l.vendor_id || null,
        notes: l.notes || null,
      }));
      await saveBomV2({
        id: bom?.id ?? null,
        header: {
          finished_qbo_item_id: finishedId,
          name: name || null,
          version,
          formula_id: formulaId || null,
          yield_qty: 1,
          yield_uom: 'each',
          cans_per_case: Number(cansPerCase) || 24,
          oz_per_can: Number(ozPerCan) || 12,
          notes: notes || null,
        },
        lines: payload,
      });
      toast.success(isNew ? 'BOM created' : 'BOM saved');
      onSaved();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  // The recipe preview reads the SAME function the rebuild and the work order
  // read, so what is shown here is what will be ordered — not a second copy of
  // the arithmetic that can drift from it.
  // The pre-flight answers "how many POs, to whom, and what would stop them".
  // It is about the whole BOM, so it runs whether or not a formula is attached.
  useEffect(() => {
    if (!bom) { setPreflight(null); return; }
    let alive = true;
    fetchBomPreflight(bom.id)
      .then((p) => { if (alive) setPreflight(p); })
      .catch(() => { if (alive) setPreflight(null); });
    return () => { alive = false; };
  }, [bom]);

  useEffect(() => {
    if (!bom || !formulaId) { setReqs(null); return; }
    let alive = true;
    fetchCaseRequirements(bom.id)
      .then((r) => { if (alive) setReqs(r); })
      .catch(() => { if (alive) setReqs(null); });
    fetchBatchBasis(bom.id)
      .then((b) => { if (alive) setBasis(b); })
      .catch(() => { if (alive) setBasis(null); });
    return () => { alive = false; };
  }, [bom, formulaId]);

  async function rebuildFromFormula() {
    if (!bom) return;
    setRebuilding(true);
    try {
      const res: BomSyncResult = await syncBomFromFormula(bom.id);
      const parts = [res.added + ' ingredient line' + (res.added === 1 ? '' : 's') + ' written'];
      if (res.unlinked.length) {
        parts.push(res.unlinked.length + ' left off — no QuickBooks item yet: '
          + res.unlinked.map((u) => u.name).join(', '));
      }
      if (res.unlinked.length) toast.error(parts.join('. '));
      else toast.success(parts.join('. '));
      const all = await fetchBomLines(bom.id);
      setRecipeLines(all.filter((l) => l.source === 'formula'));
      setBasis(await fetchBatchBasis(bom.id).catch(() => null));
      setPreflight(await fetchBomPreflight(bom.id).catch(() => null));
      for (const w of res.warnings ?? []) toast.info(w);
      onSaved();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setRebuilding(false); }
  }

  function setLine(i: number, patch: Partial<LineRow>) {
    setLines((rows) => rows.map((x, j) => j === i ? { ...x, ...patch } : x));
  }

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
            {isNew ? 'New Bill of Materials' : `Edit BOM · ${itemLookup.byId.get(bom!.finished_qbo_item_id)?.item_name ?? bom!.finished_qbo_item_id}`}
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
            <XIcon size={16} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
          <LField label="Sellable finished item *">
            <select style={inp()} value={finishedId} onChange={(e) => setFinishedId(e.target.value)} disabled={!isNew}>
              <option value="">—</option>
              {isNew
                ? itemLookup.finishedOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)
                : <option value={finishedId}>{itemLookup.byId.get(finishedId)?.item_name ?? finishedId}</option>}
            </select>
          </LField>
          <LField label="Formula / spec sheet (the driver)">
            <select style={inp()} value={formulaId} onChange={(e) => setFormulaId(e.target.value)}>
              <option value="">— none —</option>
              {formulas.map((f) => <option key={f.id} value={f.id}>{f.name} · rev {f.doc_rev}</option>)}
            </select>
          </LField>
          <LField label="BOM name">
            <input style={inp()} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cola 24pk case" />
          </LField>
          <LField label="Version">
            <input style={inp()} value={version} onChange={(e) => setVersion(e.target.value)} />
          </LField>
          <LField label="Cans per case">
            <input type="number" min={1} style={inp()} value={cansPerCase} onChange={(e) => setCansPerCase(e.target.value)} />
          </LField>
          <LField label="Oz per can">
            <input type="number" min={0} step="any" style={inp()} value={ozPerCan} onChange={(e) => setOzPerCan(e.target.value)} />
          </LField>
        </div>

        {preflight && (
          <div style={{
            marginTop: 16, padding: 12, border: '1px solid var(--bd)', borderRadius: 5,
            background: 'rgba(255,255,255,0.02)',
          }}>
            <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>
              Who gets a purchase order · {preflight.po_count} PO{preflight.po_count === 1 ? '' : 's'} per run
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8 }}>
              {preflight.vendors.map((v) => (
                <div key={v.qbo_vendor_id ?? 'none'} style={{
                  padding: 9, borderRadius: 4, background: 'rgba(255,255,255,0.03)',
                  border: v.qbo_vendor_id ? '1px solid transparent' : '1px solid var(--am)',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: v.qbo_vendor_id ? 'var(--tx)' : 'var(--am)' }}>
                    {v.vendor_name}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3, lineHeight: 1.6 }}>
                    {v.items.join(' · ')}
                  </div>
                </div>
              ))}
            </div>
            {preflight.blockers.length > 0 && (
              <div style={{
                marginTop: 9, padding: 9, borderRadius: 4,
                background: 'rgba(245,158,11,0.10)', border: '1px solid var(--am)', fontSize: 11, lineHeight: 1.7,
              }}>
                <strong style={{ color: 'var(--am)' }}>
                  {preflight.blockers.length} line{preflight.blockers.length === 1 ? '' : 's'} would stop the
                  purchase order reaching QuickBooks
                </strong>
                {preflight.blockers.map((b) => (
                  <div key={b.qbo_item_id} style={{ marginTop: 4, color: 'var(--mt)' }}>
                    <span style={{ color: 'var(--tx)' }}>{b.item_name}</span> — {b.detail}
                  </div>
                ))}
              </div>
            )}
            {(preflight.warnings ?? []).length > 0 && (
              <div style={{
                marginTop: 9, padding: 9, borderRadius: 4,
                background: 'rgba(255,255,255,0.03)', border: '1px dashed var(--bd)', fontSize: 11, lineHeight: 1.7,
              }}>
                <strong style={{ color: 'var(--tx)' }}>
                  Worth a look — this will still post
                </strong>
                {preflight.warnings.map((w) => (
                  <div key={w.qbo_item_id} style={{ marginTop: 4, color: 'var(--mt)' }}>
                    <span style={{ color: 'var(--tx)' }}>{w.item_name}</span> — {w.detail}
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 10, color: 'var(--mt)', lineHeight: 1.6 }}>
              A run raises one purchase order per vendor on this list. The ingredients are not counted here —
              they ride under the flavour's gallon line as detail, so they never become a PO line of their own.
            </div>
          </div>
        )}

        {!isNew && (
          <div style={{
            marginTop: 16, padding: 12, border: '1px solid var(--bd)', borderRadius: 5,
            background: 'rgba(255,255,255,0.02)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
                Recipe — from the formula, per 1 case
              </div>
              <div style={{ flex: 1 }} />
              <button
                style={btnSecondary()}
                disabled={!formulaId || rebuilding}
                title={formulaId ? '' : 'Link a formula first'}
                onClick={rebuildFromFormula}
              >
                <FlaskConical size={12} style={{ verticalAlign: -2, marginRight: 5 }} />
                {rebuilding ? 'Rebuilding…' : 'Rebuild from formula'}
              </button>
            </div>

            {!formulaId && (
              <div style={{ fontSize: 11, color: 'var(--am)' }}>
                No formula linked, so there is no recipe to explode. Pick one above and save.
              </div>
            )}

            {formulaId && reqs && reqs.length > 0 && (
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--mt)', fontSize: 9.5, textTransform: 'uppercase' }}>
                    <th style={{ padding: '3px 5px' }}>Material</th>
                    <th style={{ padding: '3px 5px' }}>% by weight</th>
                    <th style={{ padding: '3px 5px' }}>Per case</th>
                    <th style={{ padding: '3px 5px' }}>Vendor</th>
                    <th style={{ padding: '3px 5px' }}>On the BOM?</th>
                  </tr>
                </thead>
                <tbody>
                  {reqs.map((r, i) => {
                    // A recipe line is identified by its material, not by a
                    // QuickBooks item — rolled-up ingredients have no item at all.
                    const onBom = recipeLines.some((l) => l.ingredient_id === r.ingredient_id);
                    return (
                      <tr key={i} style={{ borderTop: '1px solid var(--bd)' }}>
                        <td style={{ padding: '3px 5px' }}>{r.material_name}</td>
                        <td style={{ padding: '3px 5px' }} className="mn">
                          {(Number(r.pct_by_weight) * 100).toFixed(4)}%
                        </td>
                        <td style={{ padding: '3px 5px' }} className="mn">
                          {Number(r.qty_per_case).toFixed(5)} {r.recipe_uom}
                        </td>
                        <td style={{ padding: '3px 5px', color: r.vendor_name ? undefined : 'var(--am)' }}>
                          {r.vendor_name ?? (r.is_purchased ? 'no vendor' : '—')}
                        </td>
                        <td style={{ padding: '3px 5px' }}>
                          {!r.is_purchased
                            ? <span style={{ color: 'var(--mt)' }}>sourced on site</span>
                            : onBom
                              ? <span style={{ color: 'var(--gn)' }}>yes</span>
                              : <span style={{ color: 'var(--am)' }}>rebuild to add</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {basis && (
              <div style={{
                marginTop: 10, padding: 10, borderRadius: 4,
                background: 'rgba(255,255,255,0.03)', fontSize: 11, lineHeight: 1.75,
              }}>
                <div style={{ fontSize: 9.5, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 5 }}>
                  How the concentrate volume is worked out
                </div>
                <div>
                  A case is {basis.cans_per_case} × {basis.oz_per_can} oz ={' '}
                  <strong>{basis.gal_per_case} gal</strong> of finished soda. At{' '}
                  <strong>{basis.dilution_ratio}:1</strong> the concentrate is one part in{' '}
                  {basis.dilution_ratio + 1} — <strong>{basis.concentrate_gal_per_case} gal per case</strong>,
                  which is what the gallon line below carries. It is computed, not typed.
                </div>
                <div style={{ marginTop: 4, color: 'var(--mt)' }}>
                  Cross-check: every material here ends up inside that concentrate —{' '}
                  {basis.solids_lbs_per_case} lb in {basis.concentrate_gal_per_case} gal ={' '}
                  <strong style={{ color: 'var(--tx)' }}>
                    {basis.solids_lbs_per_concentrate_gal ?? '—'} lb per gallon
                  </strong>
                  {' · '}
                  <span style={{
                    color: basis.verdict.startsWith('consistent') ? 'var(--gn)'
                      : basis.verdict.startsWith('diet') ? 'var(--mt)' : 'var(--am)',
                  }}>{basis.verdict}</span>.
                </div>
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 10, color: 'var(--mt)', lineHeight: 1.6 }}>
              These materials are <strong>billed inside the flavour's 1-gallon line</strong> below — the
              purchase order shows every quantity so the supplier knows what to buy, but QuickBooks sees one
              gallon line at the gallon price. Rebuilding replaces the recipe and recomputes the gallon
              quantity; the vendor, the price, the cans and the co-packer charges are yours and are never
              touched.
            </div>
          </div>
        )}

        <div style={{ marginTop: 16, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
            Sub-items (per 1 finished unit)
          </div>
          {missingVendors > 0 && (
            <span style={{ fontSize: 10.5, color: 'var(--am)' }}>
              {missingVendors} component{missingVendors === 1 ? '' : 's'} without a vendor — set one under Materials & Pricing (or override it here) so work orders can generate POs.
            </span>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '95px 1.6fr 70px 90px 70px 62px 80px 1.2fr 28px', gap: 6, marginBottom: 4, fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          <span>Type</span><span>Sub-item / service</span><span>Qty</span><span>Per</span><span>UoM</span><span>Scrap %</span><span>Est unit $</span><span>Vendor</span><span />
        </div>
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '95px 1.6fr 70px 90px 70px 62px 80px 1.2fr 28px', gap: 6, marginBottom: 6 }}>
            <select style={inp()} value={l.line_type} onChange={(e) => setLine(i, { line_type: e.target.value as BomLineType })}>
              <option value="component">Component</option>
              <option value="service">Service</option>
            </select>
            {l.line_type === 'component' ? (
              <select style={inp()} value={l.component_qbo_item_id} onChange={(e) => setLine(i, { component_qbo_item_id: e.target.value })}>
                <option value="">—</option>
                {componentOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            ) : (
              <input style={inp()} placeholder="Service label (e.g. Canning fee)" value={l.service_label}
                onChange={(e) => setLine(i, { service_label: e.target.value })} />
            )}
            <input type="number" min={0} step="any" style={inp()} value={l.qty_per}
              onChange={(e) => setLine(i, { qty_per: e.target.value })} />
            <select style={inp()} value={l.qty_basis} title="Per unit scales with the run; per run is a flat quantity per work order (a vendor's fixed fee)"
              onChange={(e) => setLine(i, { qty_basis: e.target.value as BomQtyBasis })}>
              <option value="per_yield">per unit</option>
              <option value="per_run">per run</option>
            </select>
            <input style={inp()} value={l.qty_uom} onChange={(e) => setLine(i, { qty_uom: e.target.value })} />
            <input type="number" min={0} step="any" style={inp()} value={l.scrap_pct}
              onChange={(e) => setLine(i, { scrap_pct: e.target.value })} />
            <input type="number" min={0} step="any" style={inp()} value={l.default_cost}
              onChange={(e) => setLine(i, { default_cost: e.target.value })} />
            {l.line_type === 'component' ? (
              <select style={inp()} value={l.vendor_id} onChange={(e) => setLine(i, { vendor_id: e.target.value })}
                title="Blank = the vendor set under Materials & Pricing for this item. Pick one here only to override it for this BOM.">
                <option value="">{masters.get(l.component_qbo_item_id)?.qbo_vendor_id
                  ? `master · ${vendorName(masters.get(l.component_qbo_item_id)!.qbo_vendor_id) ?? 'set'}`
                  : '— vendor —'}</option>
                {vendors.map((v) => <option key={v.qbo_vendor_id} value={v.qbo_vendor_id}>{v.display_name}</option>)}
              </select>
            ) : <span style={{ fontSize: 10, color: 'var(--mt)', alignSelf: 'center' }}>cost-only</span>}
            <button style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}
              onClick={() => setLines((rows) => rows.length > 1 ? rows.filter((_, j) => j !== i) : rows)}>
              <XIcon size={13} />
            </button>
          </div>
        ))}
        <button style={btnSecondary()} onClick={() => setLines((rows) => [...rows, { ...EMPTY_LINE }])}>
          <Plus size={11} style={{ marginRight: 3, verticalAlign: -1 }} /> Add sub-item
        </button>

        <div style={{ marginTop: 12 }}>
          <LField label="Notes">
            <textarea rows={2} style={{ ...inp(), width: '100%', resize: 'vertical', minHeight: 36 }}
              value={notes} onChange={(e) => setNotes(e.target.value)} />
          </LField>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 16 }}>
          <div>
            {onToggleActive && (
              <button onClick={onToggleActive} style={btnSecondary()}>
                {bom?.is_active ? 'Deactivate BOM' : 'Reactivate BOM'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={btnSecondary()}>Cancel</button>
            <button onClick={submit} disabled={!canSave || saving} style={btnPrimary()}>
              {saving ? 'Saving…' : isNew ? 'Create BOM' : 'Save BOM'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div>
    <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
    {children}
  </div>;
}
