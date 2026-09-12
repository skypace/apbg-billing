// Documents on a production order, a work order or a purchase order (20260912d).
// One panel, mounted on all three detail screens, so a COA filed on the ORDER
// shows on every flavour and a deposit invoice filed on a PO shows on the order
// that PO belongs to. Grouped by the pipeline stage the paper belongs to; a
// stage the document has reached with nothing filed reads "no documents yet"
// — a nudge, never a gate (the paperwork arrives days after the step).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip, Upload, Archive, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import {
  DOC_KINDS, STAGE_LABEL, STAGE_ORDER, stageReached,
  type DocKind, type DocStage, type ProductionDocument,
  fetchRunDocuments, fetchWorkOrderDocuments, fetchPoDocuments, fileProductionDocument, archiveProductionDocument, openProductionDocument,
} from '../lib/productionDocuments';
import { useToast } from '../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../lib/styles';

export type DocsTarget =
  | { kind: 'run'; runId: string; runNumber: string; status: string }
  | { kind: 'wo'; woId: string; batchCode: string; runId: string | null; runNumber: string | null; status: string }
  | { kind: 'po'; poId: string; poNumber: string; runId: string | null; status: string };

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
const fmtBytes = (n: number | null) => n == null ? '' : n > 1_048_576 ? (n / 1_048_576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

export function ProductionDocumentsPanel({ target, defaultOpen = false }: { target: DocsTarget; defaultOpen?: boolean }) {
  const toast = useToast();
  const [docs, setDocs] = useState<ProductionDocument[] | null>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState<DocKind>('other');
  const [stage, setStage] = useState<DocStage>('other');
  const [title, setTitle] = useState('');
  const [docDate, setDocDate] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  // on a flavour, a document can be filed on the flavour or on the whole order
  const [onOrder, setOnOrder] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      if (target.kind === 'run') setDocs(await fetchRunDocuments(target.runId));
      else if (target.kind === 'wo') setDocs(await fetchWorkOrderDocuments(target.woId, target.runId));
      else setDocs(await fetchPoDocuments(target.poId));
    } catch { setDocs([]); }
  }, [target]);
  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => {
    const by = new Map<DocStage, ProductionDocument[]>();
    for (const d of docs ?? []) { const s = (d.stage ?? 'other') as DocStage; by.set(s, [...(by.get(s) ?? []), d]); }
    return by;
  }, [docs]);

  // PO documents have no pipeline stage of their own worth marking; the order and the flavour do
  const markStages = target.kind === 'po' ? [] : STAGE_ORDER.filter((s) => s !== 'other' && stageReached(target.status, s) && !(groups.get(s)?.length));

  function pickKind(k: DocKind) {
    setKind(k);
    const def = DOC_KINDS.find((x) => x.kind === k)?.stage ?? 'other';
    setStage(def);
  }

  async function submit() {
    if (!files.length) { toast.error('Pick at least one file'); return; }
    setBusy(true);
    try {
      for (const f of files) {
        await fileProductionDocument({
          file: f, kind, stage,
          title: files.length === 1 ? title : '',
          doc_date: docDate || null, reference, notes,
          run_id: target.kind === 'run' ? target.runId : target.kind === 'wo' && onOrder ? target.runId : null,
          wo_id: target.kind === 'wo' && !onOrder ? target.woId : null,
          po_id: target.kind === 'po' ? target.poId : null,
        });
      }
      toast.success(`${files.length} document${files.length === 1 ? '' : 's'} filed`);
      setFiles([]); setTitle(''); setDocDate(''); setReference(''); setNotes(''); setAdding(false);
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function archive(d: ProductionDocument) {
    if (!window.confirm(`Archive "${d.title}"? It stays on file, hidden from this list.`)) return;
    setBusy(true);
    try { await archiveProductionDocument(d.id); toast.success('Archived'); await load(); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  const count = docs?.length ?? 0;
  const where = target.kind === 'run' ? target.runNumber : target.kind === 'wo' ? target.batchCode : target.poNumber;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
        onClick={() => setOpen((v) => !v)}>
        <span>{open ? <ChevronDown size={11} style={{ verticalAlign: -2 }} /> : <ChevronRight size={11} style={{ verticalAlign: -2 }} />} <Paperclip size={11} style={{ verticalAlign: -2 }} /> Documents · {docs === null ? '…' : count}</span>
        <span style={{ textTransform: 'none', letterSpacing: 0 }}>
          {markStages.length > 0 && <span style={{ color: 'var(--am)' }}>no documents yet at {markStages.map((s) => STAGE_LABEL[s]).join(', ')}</span>}
          {markStages.length === 0 && docs !== null && count === 0 && <span>nothing filed yet</span>}
        </span>
      </div>
      {open && (
        <div className="cd" style={{ padding: 10, border: '1px solid var(--bd)', fontSize: 11 }}>
          {target.kind === 'wo' && target.runId && (
            <div style={{ fontSize: 10.5, color: 'var(--mt)', marginBottom: 8 }}>
              Showing what is filed on {target.batchCode} and on its production order {target.runNumber} — a COA or invoice for the whole run is filed once, on the order, and shows on every flavour.
            </div>
          )}
          {docs !== null && count === 0 && <div style={{ color: 'var(--mt)', marginBottom: 8 }}>Nothing filed on {where} yet.</div>}
          {STAGE_ORDER.filter((s) => groups.get(s)?.length).map((s) => (
            <div key={s} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 3 }}>{STAGE_LABEL[s]}</div>
              {groups.get(s)!.map((d) => (
                <div key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <button type="button" onClick={() => openProductionDocument(d).catch((e) => toast.error(errMsg(e)))} title={d.file_name}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ac)', padding: 0, fontSize: 11, fontWeight: 600, textAlign: 'left' }}>
                    <ExternalLink size={10} style={{ verticalAlign: -1, marginRight: 4 }} />{d.title}
                  </button>
                  <span style={{ color: 'var(--mt)' }}>{DOC_KINDS.find((k) => k.kind === d.kind)?.label ?? d.kind}</span>
                  {d.reference && <span style={{ fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>#{d.reference}</span>}
                  {d.doc_date && <span style={{ color: 'var(--mt)' }}>{d.doc_date}</span>}
                  <span style={{ color: 'var(--mt)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                    {target.kind !== 'run' && d.run_id && !d.wo_id && !d.po_id && <span title="filed on the production order">order · </span>}
                    {target.kind === 'run' && d.batch_code && <span title="filed on a flavour">{d.batch_code} · </span>}
                    {target.kind === 'run' && d.po_number && <span title="filed on a purchase order">{d.po_number} · </span>}
                    {d.uploaded_by_name ?? 'unknown'} · {new Date(d.uploaded_at).toLocaleDateString()} · {fmtBytes(d.size_bytes)}
                  </span>
                  <button type="button" disabled={busy} onClick={() => archive(d)} title="Archive (kept on file, hidden here)"
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)', padding: 0 }}><Archive size={11} /></button>
                </div>
              ))}
            </div>
          ))}
          {!adding ? (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
              <button type="button" style={btnSecondary()} disabled={busy} onClick={() => setAdding(true)}><Upload size={11} style={{ verticalAlign: -1, marginRight: 4 }} /> Add documents…</button>
            </div>
          ) : (
            <div style={{ marginTop: 8, padding: 10, border: '1px dashed var(--ac)', borderRadius: 6 }}
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); const fs = Array.from(e.dataTransfer.files ?? []); if (fs.length) setFiles(fs); }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
                <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>Files (drop here or pick — several at once file as one batch)
                  <input ref={fileRef} type="file" multiple style={{ ...inp(), marginTop: 4 }} onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
                </label>
                <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>What is it
                  <select style={{ ...inp(), marginTop: 4 }} value={kind} onChange={(e) => pickKind(e.target.value as DocKind)}>
                    {DOC_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                  </select>
                </label>
                <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>Belongs to step
                  <select style={{ ...inp(), marginTop: 4 }} value={stage} onChange={(e) => setStage(e.target.value as DocStage)}>
                    {STAGE_ORDER.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                  </select>
                </label>
                {files.length === 1 && (
                  <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>Title (defaults to the file name)
                    <input style={{ ...inp(), marginTop: 4 }} value={title} onChange={(e) => setTitle(e.target.value)} />
                  </label>
                )}
                <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>Document date
                  <input type="date" style={{ ...inp(), marginTop: 4 }} value={docDate} onChange={(e) => setDocDate(e.target.value)} />
                </label>
                <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>Reference (invoice #, lot, PRO #)
                  <input style={{ ...inp(), marginTop: 4 }} value={reference} onChange={(e) => setReference(e.target.value)} />
                </label>
                <label style={{ fontSize: 10.5, color: 'var(--mt)', gridColumn: '1 / -1' }}>Notes (SKUs, month, gallons — what the vendor left off)
                  <input style={{ ...inp(), marginTop: 4 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
                </label>
              </div>
              {target.kind === 'wo' && target.runId && (
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, fontSize: 10.5, color: 'var(--mt)' }}>
                  <input type="checkbox" checked={onOrder} onChange={(e) => setOnOrder(e.target.checked)} />
                  File on the whole production order {target.runNumber} (every flavour sees it) rather than on {target.batchCode} alone
                </label>
              )}
              {files.length > 0 && <div style={{ fontSize: 10.5, color: 'var(--mt)', marginTop: 6 }}>{files.map((f) => f.name).join(' · ')}</div>}
              <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 6 }}>{DOC_KINDS.find((k) => k.kind === kind)?.hint}</div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button type="button" style={btnSecondary()} disabled={busy} onClick={() => { setAdding(false); setFiles([]); }}>Cancel</button>
                <button type="button" style={btnPrimary()} disabled={busy || files.length === 0} onClick={() => void submit()}>File {files.length || ''} document{files.length === 1 ? '' : 's'}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
