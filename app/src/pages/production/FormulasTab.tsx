import { useEffect, useMemo, useRef, useState } from 'react';
import { PrintableTable } from '../../components/PrintableTable';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Plus, X as XIcon, FileText, Paperclip, Pencil, Mail } from 'lucide-react';
import { openDocPdf } from '../../lib/productionDocs';
import { EmailDocModal } from './EmailDocModal';
import {
  ProductFormula, FormulaIngredient, FormulaRevision,
  FormulaIngredientInput, FormulaStatus,
  fetchFormulaIngredients, fetchFormulaRevisions, saveFormula,
  scaleFormulaBatch, batchTargetUnits,
  uploadFormulaAttachment, openFormulaAttachment,
} from '../../lib/formulas';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { GRID_SX, GRID_DEFAULTS } from '../stock/stockStyles';

const STATUS_COLOR: Record<FormulaStatus, string> = {
  draft:    'var(--mt)',
  active:   'var(--gn)',
  archived: '#64748b',
};

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

interface Props {
  formulas: ProductFormula[] | null;
  onChanged: () => void;
}

export function FormulasTab({ formulas, onChanged }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProductFormula | 'new' | null>(null);

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'name', headerName: 'Formula / Product', flex: 1, minWidth: 220,
      renderCell: (p) => (
        <button onClick={() => setOpenId(String(p.row.id))} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--ac)', fontWeight: 700, padding: 0, fontSize: 12.5, textAlign: 'left',
        }}>{String(p.value ?? '')}</button>
      ),
    },
    {
      field: 'status', headerName: 'Status', width: 100,
      renderCell: (p) => {
        const v = String(p.value ?? '') as FormulaStatus;
        const c = STATUS_COLOR[v] ?? 'var(--mt)';
        return <span style={{
          background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
          padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
        }}>{v.toUpperCase()}</span>;
      },
    },
    { field: 'doc_rev', headerName: 'Rev', width: 70, cellClassName: 'mn' },
    { field: 'effective_date', headerName: 'Effective', width: 105,
      valueFormatter: (v) => v ? String(v) : '—' },
    { field: 'default_batch_size_gal', headerName: 'Batch (gal)', width: 105, cellClassName: 'mn',
      valueFormatter: (v) => v == null ? '—' : Number(v).toLocaleString() },
    { field: 'can_size_oz', headerName: 'Can (oz)', width: 85, cellClassName: 'mn',
      valueFormatter: (v) => v == null ? '—' : String(v) },
    { field: 'density_lbs_per_gal', headerName: 'Density (lbs/gal)', width: 125, cellClassName: 'mn',
      valueFormatter: (v) => v == null ? '—' : String(v) },
    {
      field: 'source_file_name', headerName: 'Spec sheet', flex: 1, minWidth: 160,
      renderCell: (p) => p.value
        ? <span style={{ fontSize: 11, color: 'var(--mt)' }}><Paperclip size={10} style={{ verticalAlign: -1, marginRight: 4 }} />{String(p.value)}</span>
        : <span style={{ color: 'var(--mt)' }}>—</span>,
    },
    { field: 'updated_at', headerName: 'Updated', width: 155,
      valueFormatter: (v) => v ? new Date(String(v)).toLocaleString() : '—' },
  ], []);

  const openFormula = (formulas ?? []).find((f) => f.id === openId) ?? null;

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--mt)' }}>
            Product spec sheets &amp; formulas — the driver behind every BOM and work order.
          </span>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button onClick={() => setEditing('new')} style={btnPrimary()}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> New Formula
          </button>
        </div>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        <DataGridPro
          rows={formulas ?? []}
          columns={columns}
          {...GRID_DEFAULTS}
          sx={GRID_SX}
          density="compact"
          loading={formulas === null}
          disableRowSelectionOnClick
        />
      </div>

      {openFormula && (
        <FormulaDetailModal
          formula={openFormula}
          onClose={() => setOpenId(null)}
          onEdit={() => { setEditing(openFormula); setOpenId(null); }}
          onChanged={onChanged}
        />
      )}

      {editing && (
        <FormulaEditModal
          formula={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
        />
      )}
    </div>
  );
}

// ── Detail (spec sheet viewer) ──────────────────────────────────────────

function FormulaDetailModal({ formula, onClose, onEdit, onChanged }: {
  formula: ProductFormula;
  onClose: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [ingredients, setIngredients] = useState<FormulaIngredient[] | null>(null);
  const [revisions, setRevisions] = useState<FormulaRevision[] | null>(null);
  const [batchGal, setBatchGal] = useState<string>(String(formula.default_batch_size_gal ?? 1000));
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetchFormulaIngredients(formula.id).then((r) => alive && setIngredients(r)).catch(() => alive && setIngredients([]));
    fetchFormulaRevisions(formula.id).then((r) => alive && setRevisions(r)).catch(() => alive && setRevisions([]));
    return () => { alive = false; };
  }, [formula.id]);

  const gal = Number(batchGal) > 0 ? Number(batchGal) : 0;
  const batch = useMemo(
    () => ingredients ? scaleFormulaBatch(formula, ingredients, gal) : [],
    [formula, ingredients, gal],
  );
  const totalLbs = gal * Number(formula.density_lbs_per_gal ?? 0);
  const targetUnits = batchTargetUnits(gal, formula.can_size_oz);

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const path = await uploadFormulaAttachment(formula.id, file);
      await saveFormula({
        id: formula.id,
        header: { name: formula.name, attachment_path: path, source_file_name: file.name },
        ingredients: (ingredients ?? []).map((i) => ({
          ingredient_name: i.ingredient_name,
          pct_by_weight: i.pct_by_weight,
          uom: i.uom,
          component_qbo_item_id: i.component_qbo_item_id,
          notes: i.notes,
        })),
      });
      toast.success('Spec sheet attached');
      onChanged();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setUploading(false); }
  }

  // The batching sheet is rendered server-side as a PDF, in the same design as
  // the purchase order and the bill of lading it travels with.
  const [emailOpen, setEmailOpen] = useState(false);
  function openBatchingSheet() {
    openDocPdf({ kind: 'batch_sheet', id: formula.id, gal: gal > 0 ? gal : undefined })
      .catch((e) => toast.error(errMsg(e)));
  }

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...panel, maxWidth: 880 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
              {formula.title ?? 'Product formula'} · rev {formula.doc_rev} · {formula.status.toUpperCase()}
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 22, color: 'var(--ac)' }}>{formula.name}</h2>
          </div>
          <button onClick={onClose} style={xBtn}><XIcon size={18} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, fontSize: 12, marginBottom: 14 }}>
          <Meta label="Code" value={formula.code ?? '—'} />
          <Meta label="Effective" value={formula.effective_date ?? '—'} />
          <Meta label="Can size" value={formula.can_size_oz ? `${formula.can_size_oz} oz` : '—'} />
          <Meta label="Density" value={formula.density_lbs_per_gal ? `${formula.density_lbs_per_gal} lbs/gal` : '—'} />
        </div>

        {/* Interactive batch scaler */}
        <div className="cd" style={{ padding: 12, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
              Ingredients · scaled to
            </div>
            <input type="number" min={1} step="any" value={batchGal}
              onChange={(e) => setBatchGal(e.target.value)} style={{ ...inp(), width: 110 }} />
            <span style={{ fontSize: 11, color: 'var(--mt)' }}>gallons</span>
            <span style={{ fontSize: 11, color: 'var(--mt)' }}>
              → {totalLbs.toLocaleString(undefined, { maximumFractionDigits: 1 })} lbs total
              {targetUnits != null && <> · ≈ {Math.round(targetUnits).toLocaleString()} cans ({formula.can_size_oz} oz)</>}
            </span>
          </div>
          <PrintableTable>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                  <th style={cellTh}>Ingredient</th>
                  <th style={{ ...cellTh, textAlign: 'right' }}>% by weight</th>
                  <th style={{ ...cellTh, textAlign: 'right' }}>Target weight @ {gal.toLocaleString()} gal</th>
                </tr>
              </thead>
              <tbody>
                {(ingredients ?? []).map((ing, i) => (
                  <tr key={ing.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={cellTd}><strong>{ing.ingredient_name}</strong></td>
                    <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                      {(Number(ing.pct_by_weight) * 100).toFixed(4)}%
                    </td>
                    <td style={{ ...cellTd, textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                      {batch[i] ? `${batch[i].target_weight_lbs.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${ing.uom}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </PrintableTable>
        </div>

        {Object.keys(formula.qc_specs ?? {}).length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={sectionLbl}>Product specs (QC)</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(formula.qc_specs).map(([k, v]) => (
                <div key={k} style={{
                  padding: '6px 10px', background: 'rgba(91,181,240,0.05)',
                  border: '1px solid var(--bd)', borderRadius: 4, fontSize: 11,
                }}>
                  <span style={{ color: 'var(--mt)' }}>{k}:</span>{' '}
                  <strong style={{ fontFamily: 'var(--ff-mono)' }}>{v}</strong>
                </div>
              ))}
            </div>
          </div>
        )}

        {(formula.batching_instructions ?? []).length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={sectionLbl}>Batching instructions</div>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--tx)', lineHeight: 1.7 }}>
              {formula.batching_instructions.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </div>
        )}

        {(revisions ?? []).length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={sectionLbl}>Revision history</div>
            <PrintableTable>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                    <th style={cellTh}>Rev</th><th style={cellTh}>Change</th><th style={cellTh}>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {(revisions ?? []).map((r) => (
                    <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ ...cellTd, fontFamily: 'var(--ff-mono)', width: 60 }}>{r.rev}</td>
                      <td style={cellTd}>{r.note ?? '—'}</td>
                      <td style={{ ...cellTd, color: 'var(--mt)', width: 110 }}>{r.rev_date ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </PrintableTable>
          </div>
        )}

        {formula.comments && (
          <div style={{ marginBottom: 14, fontSize: 11, color: 'var(--mt)' }}>
            <div style={sectionLbl}>Comments</div>{formula.comments}
          </div>
        )}

        <input ref={fileRef} type="file" style={{ display: 'none' }}
          accept=".xlsx,.xls,.pdf,.csv,.png,.jpg"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload(f); e.target.value = ''; }} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
          {formula.attachment_path && (
            <button style={btnSecondary()} onClick={() => {
              openFormulaAttachment(formula.attachment_path as string).catch((e) => toast.error(errMsg(e)));
            }}>
              <Paperclip size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
              {formula.source_file_name ?? 'Download spec sheet'}
            </button>
          )}
          <button style={btnSecondary()} disabled={uploading} onClick={() => fileRef.current?.click()}>
            <Paperclip size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
            {uploading ? 'Uploading…' : formula.attachment_path ? 'Replace attachment' : 'Attach spec sheet'}
          </button>
          <button style={btnSecondary()} onClick={openBatchingSheet} title="Batching sheet PDF at the batch size shown">
            <FileText size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Batching sheet PDF
          </button>
          <button style={btnSecondary()} onClick={() => setEmailOpen(true)} title="Email the batching sheet to the co-packer">
            <Mail size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Email…
          </button>
          <button style={btnPrimary()} onClick={onEdit}>
            <Pencil size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Edit formula
          </button>
        </div>
        {emailOpen && (
          <EmailDocModal ref={{ kind: 'batch_sheet', id: formula.id, gal: gal > 0 ? gal : undefined }}
            title={'batching sheet · ' + formula.name + ' · ' + gal.toLocaleString() + ' gal'} onClose={() => setEmailOpen(false)} />
        )}
      </div>
    </div>
  );
}

// ── Edit / create ────────────────────────────────────────────────────────

interface IngRow { name: string; pct: string; uom: string; notes: string }
interface QcRow { key: string; value: string }

function FormulaEditModal({ formula, onClose, onSaved }: {
  formula: ProductFormula | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isNew = formula == null;
  const [name, setName] = useState(formula?.name ?? '');
  const [code, setCode] = useState(formula?.code ?? '');
  const [title, setTitle] = useState(formula?.title ?? 'Batching Data');
  const [docRev, setDocRev] = useState(formula?.doc_rev ?? '1.0');
  const [effDate, setEffDate] = useState(formula?.effective_date ?? '');
  const [status, setStatus] = useState<FormulaStatus>(formula?.status ?? 'active');
  const [batchGal, setBatchGal] = useState(formula?.default_batch_size_gal != null ? String(formula.default_batch_size_gal) : '');
  const [canOz, setCanOz] = useState(formula?.can_size_oz != null ? String(formula.can_size_oz) : '12');
  const [density, setDensity] = useState(formula?.density_lbs_per_gal != null ? String(formula.density_lbs_per_gal) : '8.4');
  const [comments, setComments] = useState(formula?.comments ?? '');
  const [instructions, setInstructions] = useState((formula?.batching_instructions ?? []).join('\n'));
  const [qcRows, setQcRows] = useState<QcRow[]>(
    formula ? Object.entries(formula.qc_specs ?? {}).map(([key, value]) => ({ key, value }))
      : [{ key: 'pH', value: '' }, { key: 'Brix', value: '' }, { key: 'Carb', value: '' }],
  );
  const [ings, setIngs] = useState<IngRow[]>([{ name: '', pct: '', uom: 'lbs', notes: '' }]);
  const [revNote, setRevNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!formula) return;
    let alive = true;
    fetchFormulaIngredients(formula.id).then((rows) => {
      if (!alive) return;
      setIngs(rows.map((r) => ({
        name: r.ingredient_name,
        pct: String(Number(r.pct_by_weight) * 100),
        uom: r.uom,
        notes: r.notes ?? '',
      })));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [formula]);

  const pctSum = ings.reduce((s, r) => s + (Number(r.pct) || 0), 0);
  const validIngs = ings.filter((r) => r.name.trim() && Number(r.pct) > 0);
  const canSave = name.trim().length > 0 && validIngs.length > 0;

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      const ingredients: FormulaIngredientInput[] = validIngs.map((r) => ({
        ingredient_name: r.name.trim(),
        pct_by_weight: Number(r.pct) / 100,
        uom: r.uom || 'lbs',
        notes: r.notes || null,
      }));
      const qc: Record<string, string> = {};
      for (const row of qcRows) if (row.key.trim() && row.value.trim()) qc[row.key.trim()] = row.value.trim();
      await saveFormula({
        id: formula?.id ?? null,
        header: {
          name: name.trim(),
          code: code || null,
          title: title || null,
          doc_rev: docRev || '1.0',
          effective_date: effDate || null,
          status,
          default_batch_size_gal: batchGal ? Number(batchGal) : null,
          can_size_oz: canOz ? Number(canOz) : null,
          density_lbs_per_gal: density ? Number(density) : null,
          qc_specs: qc,
          batching_instructions: instructions.split('\n').map((s) => s.trim()).filter(Boolean),
          comments: comments || null,
        },
        ingredients,
        revisionNote: revNote || (isNew ? 'Initial release' : null),
      });
      toast.success(isNew ? 'Formula created' : 'Formula saved');
      onSaved();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...panel, maxWidth: 860 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
            {isNew ? 'New Formula / Spec Sheet' : `Edit · ${formula?.name}`}
          </div>
          <button onClick={onClose} style={xBtn}><XIcon size={16} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          <LField label="Product name *">
            <input style={inp()} value={name} onChange={(e) => setName(e.target.value)} placeholder="Hangar 25 Cola" />
          </LField>
          <LField label="Co-packer code">
            <input style={inp()} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Q0XXX" />
          </LField>
          <LField label="Sheet title">
            <input style={inp()} value={title} onChange={(e) => setTitle(e.target.value)} />
          </LField>
          <LField label="Doc rev">
            <input style={inp()} value={docRev} onChange={(e) => setDocRev(e.target.value)} />
          </LField>
          <LField label="Effective date">
            <input type="date" style={inp()} value={effDate} onChange={(e) => setEffDate(e.target.value)} />
          </LField>
          <LField label="Status">
            <select style={inp()} value={status} onChange={(e) => setStatus(e.target.value as FormulaStatus)}>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </LField>
          <LField label="Default batch (gal)">
            <input type="number" min={0} step="any" style={inp()} value={batchGal} onChange={(e) => setBatchGal(e.target.value)} />
          </LField>
          <LField label="Can size (oz)">
            <input type="number" min={0} step="any" style={inp()} value={canOz} onChange={(e) => setCanOz(e.target.value)} />
          </LField>
          <LField label="Density (lbs/gal)">
            <input type="number" min={0} step="any" style={inp()} value={density} onChange={(e) => setDensity(e.target.value)} />
          </LField>
        </div>

        {/* Ingredients */}
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <div style={sectionLbl}>Ingredients (% by weight)</div>
            <span style={{
              fontSize: 10.5, fontFamily: 'var(--ff-mono)',
              color: Math.abs(pctSum - 100) < 0.01 ? 'var(--gn)' : 'var(--am)',
            }}>
              Σ {pctSum.toFixed(4)}%{Math.abs(pctSum - 100) >= 0.01 && ' (should total 100%)'}
            </span>
          </div>
          {ings.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 130px 80px 1fr 28px', gap: 6, marginBottom: 6 }}>
              <input style={inp()} placeholder="Ingredient" value={r.name}
                onChange={(e) => setIngs(rows => rows.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <input type="number" min={0} step="any" style={inp()} placeholder="% weight" value={r.pct}
                onChange={(e) => setIngs(rows => rows.map((x, j) => j === i ? { ...x, pct: e.target.value } : x))} />
              <input style={inp()} value={r.uom}
                onChange={(e) => setIngs(rows => rows.map((x, j) => j === i ? { ...x, uom: e.target.value } : x))} />
              <input style={inp()} placeholder="Notes" value={r.notes}
                onChange={(e) => setIngs(rows => rows.map((x, j) => j === i ? { ...x, notes: e.target.value } : x))} />
              <button style={xBtn} onClick={() => setIngs(rows => rows.length > 1 ? rows.filter((_, j) => j !== i) : rows)}>
                <XIcon size={13} />
              </button>
            </div>
          ))}
          <button style={btnSecondary()} onClick={() => setIngs(rows => [...rows, { name: '', pct: '', uom: 'lbs', notes: '' }])}>
            <Plus size={11} style={{ marginRight: 3, verticalAlign: -1 }} /> Add ingredient
          </button>
        </div>

        {/* QC specs */}
        <div style={{ marginTop: 16 }}>
          <div style={sectionLbl}>Product specs (QC checks)</div>
          {qcRows.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '180px 1fr 28px', gap: 6, marginBottom: 6 }}>
              <input style={inp()} placeholder="pH / Brix / Carb…" value={r.key}
                onChange={(e) => setQcRows(rows => rows.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} />
              <input style={inp()} placeholder="Spec, e.g. 2.50-2.60" value={r.value}
                onChange={(e) => setQcRows(rows => rows.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
              <button style={xBtn} onClick={() => setQcRows(rows => rows.filter((_, j) => j !== i))}><XIcon size={13} /></button>
            </div>
          ))}
          <button style={btnSecondary()} onClick={() => setQcRows(rows => [...rows, { key: '', value: '' }])}>
            <Plus size={11} style={{ marginRight: 3, verticalAlign: -1 }} /> Add spec
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          <LField label="Batching instructions (one step per line)">
            <textarea rows={6} style={{ ...inp(), width: '100%', resize: 'vertical' }}
              value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </LField>
        </div>
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <LField label="Comments">
            <input style={{ ...inp(), width: '100%' }} value={comments} onChange={(e) => setComments(e.target.value)} />
          </LField>
          <LField label={isNew ? 'Revision note (defaults to "Initial release")' : 'Revision note (logged when set)'}>
            <input style={{ ...inp(), width: '100%' }} value={revNote} onChange={(e) => setRevNote(e.target.value)}
              placeholder={isNew ? 'Initial release' : 'e.g. Reduced citric acid 10%'} />
          </LField>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary()}>Cancel</button>
          <button onClick={submit} disabled={!canSave || saving} style={btnPrimary()}>
            {saving ? 'Saving…' : isNew ? 'Create formula' : 'Save formula'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
  padding: '90px 20px 20px', overflowY: 'auto',
};
const panel: React.CSSProperties = {
  background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
  width: '100%', maxHeight: 'calc(100vh - 110px)', overflowY: 'auto', padding: 20,
};
const xBtn: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' };
const sectionLbl: React.CSSProperties = {
  fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6,
};
const cellTh: React.CSSProperties = { textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600,
  letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)' };
const cellTd: React.CSSProperties = { padding: '6px 10px', verticalAlign: 'middle' };

function Meta({ label, value }: { label: string; value: string }) {
  return <div>
    <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</div>
    <div style={{ marginTop: 3 }}>{value}</div>
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
