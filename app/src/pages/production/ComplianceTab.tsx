import { useEffect, useMemo, useRef, useState } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { Plus, X as XIcon, Paperclip, Archive, Download, UploadCloud } from 'lucide-react';
import {
  ComplianceCategory, ComplianceDocument, ComplianceDocumentInput,
  HolderEntity, InsuredParty, PartyType,
  CATEGORY_LABEL, ENTITY_LABEL, PARTY_TYPE_LABEL, MAX_FILE_BYTES,
  archiveComplianceDocument, createComplianceDocument, createInsuredParty,
  daysUntil, expiryStatus, fetchComplianceDocuments, fetchInsuredParties,
  guessFromFilename, openComplianceFile, updateComplianceDocument, uploadComplianceFile,
} from '../../lib/compliance';
import { sbAuth } from '../../lib/supabase';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { GRID_SX, GRID_DEFAULTS } from '../stock/stockStyles';

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  expired:   { color: '#ef4444', label: 'EXPIRED' },
  expiring:  { color: '#f59e0b', label: 'EXPIRING' },
  current:   { color: 'var(--gn)', label: 'CURRENT' },
  no_expiry: { color: 'var(--mt)', label: 'NO EXPIRY' },
};

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function ComplianceTab() {
  const toast = useToast();
  const [docs, setDocs] = useState<ComplianceDocument[] | null>(null);
  const [parties, setParties] = useState<InsuredParty[] | null>(null);
  const [category, setCategory] = useState<ComplianceCategory | 'all'>('all');
  const [editing, setEditing] = useState<ComplianceDocument | 'new' | null>(null);
  // Files dropped onto the tab are filed one at a time; the rest wait here.
  const [queue, setQueue] = useState<File[]>([]);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);

  function reload() {
    setDocs(null);
    fetchComplianceDocuments().then(setDocs).catch((e) => { setDocs([]); toast.error(errMsg(e)); });
    fetchInsuredParties().then(setParties).catch(() => setParties([]));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, []);

  const partyById = useMemo(() => {
    const m = new Map<string, InsuredParty>();
    for (const p of parties ?? []) m.set(p.id, p);
    return m;
  }, [parties]);

  const filtered = useMemo(
    () => (docs ?? []).filter((d) => category === 'all' || d.category === category),
    [docs, category],
  );

  const attention = (docs ?? []).filter((d) => {
    const s = expiryStatus(d);
    return s === 'expired' || s === 'expiring';
  }).length;

  // ── Drag-and-drop ───────────────────────────────────────────────────────
  // Drop ON a row  → attach/replace that document's file (one gesture, no form).
  // Drop anywhere else → open a pre-filled New Document form per dropped file.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [hoverRowId, setHoverRowId] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);

  function acceptFiles(list: FileList | null) {
    const files = Array.from(list ?? []).filter((f) => {
      if (f.size > MAX_FILE_BYTES) { toast.error(`${f.name} exceeds the 25MB limit`); return false; }
      return true;
    });
    if (!files.length) return;
    setQueue(files.slice(1));
    setPendingFile(files[0]);
    setEditing('new');
  }

  /** MUI renders each grid row with a data-id attribute — use it to resolve the drop target. */
  function rowIdFromEvent(e: React.DragEvent): string | null {
    const el = (e.target as HTMLElement | null)?.closest?.('.MuiDataGrid-row');
    return el?.getAttribute('data-id') ?? null;
  }

  async function attachToRow(rowId: string, file: File) {
    const target = (docs ?? []).find((d) => d.id === rowId);
    if (!target) return;
    if (file.size > MAX_FILE_BYTES) { toast.error('File exceeds the 25MB limit'); return; }
    setAttaching(true);
    try {
      const path = await uploadComplianceFile(rowId, file);
      await updateComplianceDocument(rowId, { storage_path: path, file_name: file.name });
      toast.success(`Attached ${file.name} to ${target.doc_type}`);
      reload();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setAttaching(false); }
  }

  function onDragEnter(e: React.DragEvent) {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepth.current += 1;
    setDropping(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (!dropping) return;
    e.preventDefault();
    setHoverRowId(rowIdFromEvent(e));
  }
  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) { setDropping(false); setHoverRowId(null); }
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    const rowId = rowIdFromEvent(e);
    setHoverRowId(null);
    const first = e.dataTransfer.files?.[0];
    // A row drop attaches exactly one file to that document.
    if (rowId && first) { void attachToRow(rowId, first); return; }
    acceptFiles(e.dataTransfer.files);
  }

  // After saving, pull the next queued file straight into a fresh modal.
  function afterSaved() {
    reload();
    if (queue.length) {
      const [next, ...rest] = queue;
      setQueue(rest);
      setPendingFile(next);
      setEditing('new');
    } else {
      setPendingFile(null);
      setEditing(null);
    }
  }

  function closeModal() {
    setEditing(null);
    setPendingFile(null);
    setQueue([]);
  }

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'doc_type', headerName: 'Document', flex: 1, minWidth: 190,
      renderCell: (p) => (
        <button onClick={() => setEditing(p.row as ComplianceDocument)} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--ac)', fontWeight: 700, padding: 0, fontSize: 12.5, textAlign: 'left',
        }}>{String(p.value ?? '')}</button>
      ),
    },
    {
      field: 'category', headerName: 'Category', width: 165,
      valueFormatter: (v) => CATEGORY_LABEL[v as ComplianceCategory] ?? String(v ?? ''),
    },
    {
      field: 'holder', headerName: 'Belongs to', width: 190,
      valueGetter: (_v, row) => {
        const d = row as ComplianceDocument;
        if (d.party_id) return partyById.get(d.party_id)?.name ?? 'Third party';
        return d.holder_entity ? ENTITY_LABEL[d.holder_entity] : '—';
      },
    },
    { field: 'facility', headerName: 'Facility', flex: 1, minWidth: 140,
      valueFormatter: (v) => v ? String(v) : '—' },
    { field: 'issuer', headerName: 'Issuer', width: 150,
      valueFormatter: (v) => v ? String(v) : '—' },
    { field: 'reference_number', headerName: 'Ref #', width: 115, cellClassName: 'mn',
      valueFormatter: (v) => v ? String(v) : '—' },
    {
      field: 'expiration_date', headerName: 'Expires', width: 170,
      renderCell: (p) => {
        const d = p.row as ComplianceDocument;
        const s = expiryStatus(d);
        const { color, label } = STATUS_STYLE[s];
        const days = d.expiration_date ? daysUntil(d.expiration_date) : null;
        return (
          <span>
            <span style={{
              background: 'rgba(255,255,255,0.04)', color, border: '1px solid ' + color,
              padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
              marginRight: 6,
            }}>{label}</span>
            {d.expiration_date && (
              <span style={{ fontSize: 11, color: s === 'current' ? 'var(--mt)' : color }}>
                {d.expiration_date}{s !== 'expired' && days != null ? ` (${days}d)` : ''}
              </span>
            )}
          </span>
        );
      },
    },
    {
      field: 'storage_path', headerName: 'File', width: 180,
      renderCell: (p) => p.value
        ? <button
            onClick={() => openComplianceFile(String(p.value)).catch((e) => toast.error(errMsg(e)))}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ac)', fontSize: 11, padding: 0 }}
            title="Download this document"
          ><Download size={11} style={{ verticalAlign: -1, marginRight: 4 }} />{String(p.row.file_name ?? 'download')}</button>
        : <span style={{ color: 'var(--mt)', fontSize: 11 }}>— drop a file to attach</span>,
    },
  ], [partyById, toast]);

  const chips: { id: ComplianceCategory | 'all'; label: string }[] = [
    { id: 'all', label: 'All' },
    ...Object.entries(CATEGORY_LABEL).map(([id, label]) => ({ id: id as ComplianceCategory, label })),
  ];

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{ position: 'relative' }}
    >
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {chips.map((c) => (
            <button key={c.id} onClick={() => setCategory(c.id)} style={{
              ...(category === c.id ? btnPrimary() : btnSecondary()),
              fontSize: 10.5, padding: '4px 10px',
            }}>{c.label}</button>
          ))}
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          {attention > 0 && (
            <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 700 }}>
              ⚠ {attention} document{attention === 1 ? '' : 's'} expired / expiring soon
            </span>
          )}
          <span style={{ fontSize: 10.5, color: 'var(--mt)' }}>
            <UploadCloud size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
            drag files anywhere to file them
          </span>
          <button onClick={() => { setPendingFile(null); setEditing('new'); }} style={btnPrimary()}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> New Document
          </button>
        </div>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        <DataGridPro
          rows={filtered}
          columns={columns}
          {...GRID_DEFAULTS}
          sx={{
            ...GRID_SX,
            // Highlight the row a dragged file is hovering over.
            ...(hoverRowId ? {
              [`& .MuiDataGrid-row[data-id="${hoverRowId}"]`]: {
                outline: '2px solid var(--ac)', outlineOffset: -2,
                background: 'rgba(59,130,246,0.14) !important',
              },
            } : {}),
          }}
          density="compact"
          loading={docs === null || attaching}
          disableRowSelectionOnClick
        />
      </div>

      {dropping && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none',
          background: hoverRowId ? 'transparent' : 'rgba(31,78,121,0.22)',
          border: `2px dashed ${hoverRowId ? 'transparent' : 'var(--ac)'}`, borderRadius: 8,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 40,
        }}>
          <div style={{
            background: 'var(--sf)', border: '1px solid var(--ac)', borderRadius: 8,
            padding: '12px 20px', textAlign: 'center', boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
          }}>
            <UploadCloud size={24} style={{ color: 'var(--ac)' }} />
            <div style={{ fontSize: 13, fontWeight: 700, marginTop: 6 }}>
              {hoverRowId ? 'Drop to attach the file to this document' : 'Drop to file compliance documents'}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--mt)', marginTop: 2 }}>
              {hoverRowId
                ? 'Replaces whatever file is on that row'
                : 'Drop on a row to attach · anywhere else files a new document · up to 25MB each'}
            </div>
          </div>
        </div>
      )}

      {editing && (
        <DocEditModal
          doc={editing === 'new' ? null : editing}
          parties={parties ?? []}
          initialFile={pendingFile}
          queuedCount={queue.length}
          onClose={closeModal}
          onSaved={afterSaved}
        />
      )}
    </div>
  );
}

// ── Edit / create modal ──────────────────────────────────────────────────

function DocEditModal({ doc, parties, initialFile, queuedCount, onClose, onSaved }: {
  doc: ComplianceDocument | null;
  parties: InsuredParty[];
  initialFile: File | null;
  queuedCount: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isNew = doc === null;
  const seed = initialFile ? guessFromFilename(initialFile.name) : null;
  const [category, setCategory] = useState<ComplianceCategory>(doc?.category ?? seed?.category ?? 'insurance');
  const [docType, setDocType] = useState(doc?.doc_type ?? seed?.doc_type ?? '');
  const [ownerKind, setOwnerKind] = useState<'ours' | 'party'>(doc?.party_id ? 'party' : 'ours');
  const [entity, setEntity] = useState<HolderEntity>(doc?.holder_entity ?? 'shared');
  const [partyId, setPartyId] = useState<string>(doc?.party_id ?? '');
  const [facility, setFacility] = useState(doc?.facility ?? '');
  const [issuer, setIssuer] = useState(doc?.issuer ?? '');
  const [refNum, setRefNum] = useState(doc?.reference_number ?? '');
  const [issueDate, setIssueDate] = useState(doc?.issue_date ?? '');
  const [expDate, setExpDate] = useState(doc?.expiration_date ?? '');
  const [notes, setNotes] = useState(doc?.notes ?? '');
  const [file, setFile] = useState<File | null>(initialFile);
  const [saving, setSaving] = useState(false);
  const [addingParty, setAddingParty] = useState(false);
  const [newPartyName, setNewPartyName] = useState('');
  const [newPartyType, setNewPartyType] = useState<PartyType>('contractor');
  const [localParties, setLocalParties] = useState<InsuredParty[]>(parties);
  const [fileHover, setFileHover] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setLocalParties(parties), [parties]);

  const canSave = docType.trim().length > 0 && (ownerKind === 'ours' || !!partyId);

  async function addParty() {
    if (!newPartyName.trim()) return;
    try {
      const p = await createInsuredParty({ name: newPartyName.trim(), party_type: newPartyType });
      setLocalParties((prev) => [...prev, p].sort((a, b) => a.name.localeCompare(b.name)));
      setPartyId(p.id);
      setAddingParty(false);
      setNewPartyName('');
      toast.success('Party added');
    } catch (e) { toast.error(errMsg(e)); }
  }

  function pickFile(f: File | null) {
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) { toast.error('File exceeds the 25MB limit'); return; }
    setFile(f);
    // Only auto-fill an empty form — never clobber what the operator typed.
    if (!docType.trim()) {
      const g = guessFromFilename(f.name);
      setCategory(g.category);
      setDocType(g.doc_type);
    }
  }

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      let storagePath = doc?.storage_path ?? null;
      let fileName = doc?.file_name ?? null;
      if (file) {
        storagePath = await uploadComplianceFile(doc?.id ?? 'inbox', file);
        fileName = file.name;
      }
      const input: ComplianceDocumentInput = {
        category,
        doc_type: docType.trim(),
        holder_entity: ownerKind === 'ours' ? entity : null,
        party_id: ownerKind === 'party' ? partyId : null,
        facility: facility.trim() || null,
        issuer: issuer.trim() || null,
        reference_number: refNum.trim() || null,
        issue_date: issueDate || null,
        expiration_date: expDate || null,
        storage_path: storagePath,
        file_name: fileName,
        notes: notes.trim() || null,
      };
      if (isNew) await createComplianceDocument(input);
      else await updateComplianceDocument(doc.id, input);
      toast.success(isNew ? 'Document filed' : 'Document saved');
      onSaved();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSaving(false); }
  }

  async function archive() {
    if (!doc) return;
    if (!window.confirm('Archive this document? It stays on record but leaves the list.')) return;
    try {
      const { data } = await sbAuth.auth.getSession();
      await archiveComplianceDocument(doc.id, data.session?.user?.email ?? 'unknown');
      toast.success('Document archived');
      onSaved();
    } catch (e) { toast.error(errMsg(e)); }
  }

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...panel, maxWidth: 720 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 10.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
            {isNew ? 'New Compliance Document' : `Edit · ${doc?.doc_type}`}
            {queuedCount > 0 && (
              <span style={{ color: 'var(--ac)', marginLeft: 8 }}>
                · {queuedCount} more file{queuedCount === 1 ? '' : 's'} queued
              </span>
            )}
          </div>
          <button onClick={onClose} style={xBtn}><XIcon size={16} /></button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <LField label="Category *">
            <select style={inp()} value={category} onChange={(e) => setCategory(e.target.value as ComplianceCategory)}>
              {Object.entries(CATEGORY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </LField>
          <LField label="Document type *">
            <input style={inp()} value={docType} onChange={(e) => setDocType(e.target.value)}
              placeholder="Health permit / GL COI / GMP audit report" />
          </LField>
          <LField label="Whose document?">
            <select style={inp()} value={ownerKind} onChange={(e) => setOwnerKind(e.target.value as 'ours' | 'party')}>
              <option value="ours">Ours (company)</option>
              <option value="party">Third party</option>
            </select>
          </LField>
          {ownerKind === 'ours' ? (
            <LField label="Entity">
              <select style={inp()} value={entity} onChange={(e) => setEntity(e.target.value as HolderEntity)}>
                {Object.entries(ENTITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </LField>
          ) : (
            <LField label="Party *">
              <div style={{ display: 'flex', gap: 6 }}>
                <select style={{ ...inp(), flex: 1 }} value={partyId} onChange={(e) => setPartyId(e.target.value)}>
                  <option value="">— select —</option>
                  {localParties.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({PARTY_TYPE_LABEL[p.party_type]})</option>
                  ))}
                </select>
                <button onClick={() => setAddingParty((v) => !v)} style={{ ...btnSecondary(), padding: '4px 8px' }} title="Add a new party">
                  <Plus size={12} />
                </button>
              </div>
            </LField>
          )}
        </div>

        {ownerKind === 'party' && addingParty && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 10, padding: 10,
            border: '1px dashed var(--bd)', borderRadius: 6 }}>
            <LField label="New party name">
              <input style={inp()} value={newPartyName} onChange={(e) => setNewPartyName(e.target.value)} placeholder="ACME Refrigeration" />
            </LField>
            <LField label="Type">
              <select style={inp()} value={newPartyType} onChange={(e) => setNewPartyType(e.target.value as PartyType)}>
                {Object.entries(PARTY_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </LField>
            <button onClick={addParty} style={btnPrimary()} disabled={!newPartyName.trim()}>Add</button>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginTop: 10 }}>
          <LField label="Facility covered">
            <input style={inp()} value={facility} onChange={(e) => setFacility(e.target.value)} placeholder="1951 Monarch St, Alameda" />
          </LField>
          <LField label="Issuer / carrier / auditor">
            <input style={inp()} value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Alameda County EH / PJRFSI" />
          </LField>
          <LField label="Reference / policy #">
            <input style={inp()} value={refNum} onChange={(e) => setRefNum(e.target.value)} />
          </LField>
          <LField label="Issue date">
            <input style={inp()} type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          </LField>
          <LField label="Expiration date">
            <input style={inp()} type="date" value={expDate} onChange={(e) => setExpDate(e.target.value)} />
          </LField>
        </div>

        <div style={{ marginTop: 10 }}>
          <LField label="Notes">
            <textarea style={{ ...inp(), minHeight: 54, resize: 'vertical' }} value={notes}
              onChange={(e) => setNotes(e.target.value)} />
          </LField>
        </div>

        {/* Drop zone / file picker — drag a file here or click to browse. */}
        <div
          onDragOver={(e) => { e.preventDefault(); setFileHover(true); }}
          onDragLeave={() => setFileHover(false)}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setFileHover(false); pickFile(e.dataTransfer.files?.[0] ?? null); }}
          onClick={() => fileRef.current?.click()}
          style={{
            marginTop: 12, padding: '14px 16px', borderRadius: 6, cursor: 'pointer',
            border: `1px dashed ${fileHover ? 'var(--ac)' : 'var(--bd)'}`,
            background: fileHover ? 'rgba(59,130,246,0.08)' : 'transparent',
            display: 'flex', alignItems: 'center', gap: 10,
          }}
        >
          <input ref={fileRef} type="file" style={{ display: 'none' }}
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
          <UploadCloud size={18} style={{ color: fileHover ? 'var(--ac)' : 'var(--mt)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>
              {file
                ? file.name
                : doc?.storage_path
                  ? (doc.file_name ?? 'Attached document')
                  : doc?.file_name
                    // Filed ahead of the file itself: name the document we're waiting on.
                    ? `Waiting on: ${doc.file_name}`
                    : 'Drag a file here, or click to browse'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>
              {file
                ? `${(file.size / 1024 / 1024).toFixed(2)} MB · uploads when you save`
                : doc?.storage_path
                  ? 'Attached — drop a new file to replace it'
                  : 'PDF, image, or spreadsheet · up to 25MB'}
            </div>
          </div>
          {doc?.storage_path && !file && (
            <button
              onClick={(e) => { e.stopPropagation(); openComplianceFile(doc.storage_path as string).catch((err) => toast.error(errMsg(err))); }}
              style={{ ...btnSecondary(), flexShrink: 0 }}
            >
              <Download size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Download
            </button>
          )}
        </div>

        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1 }} />
          {!isNew && (
            <button onClick={archive} style={{ ...btnSecondary(), color: '#ef4444' }}>
              <Archive size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Archive
            </button>
          )}
          <button onClick={onClose} style={btnSecondary()}>Cancel</button>
          <button onClick={submit} style={btnPrimary()} disabled={!canSave || saving}>
            {saving ? 'Saving…' : (isNew ? 'File Document' : 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Local styles (same conventions as FormulasTab) ───────────────────────

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

function LField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div>
    <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
    {children}
  </div>;
}
