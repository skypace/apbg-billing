import { useEffect, useState } from 'react';
import { FileText, Pencil, Plus, RefreshCw, Upload } from 'lucide-react';
import { useToast } from '../lib/toast';
import {
  DOC_ACCEPT, DOC_MAX_BYTES, DOC_TYPES, archiveDocument, docExpiryStatus, docTypeLabel,
  fetchDocuments, fetchOrdersCustomer, fileToDataUrl, onOrdersCustomerChanged, updateDocument, uploadDocument,
  type CustomerDocument, type DocType, type OrdersCustomer,
} from '../lib/customerMaster';
import { CardShell, Note, PushNotes, btn, chip, ctl, lbl } from './customerMasterUi';

/**
 * The document vault, on the Refractor customer page — tax id, resale
 * certificate, the signed account application, the ACH form, anything else
 * filed against the account.
 *
 * ⚠ A FILE UPLOADED HERE IS ALSO ATTACHED TO THE QUICKBOOKS CUSTOMER (as an
 * Attachable, visible under the customer's Attachments in QuickBooks) — once,
 * at upload, by brix-order's endpoint. The "in QuickBooks" tag on a row is
 * the proof; a row with a file and no tag was filed before this shipped, or
 * the push was refused (which comes back as an amber note, and the file
 * stays filed here regardless — losing the document because QuickBooks was
 * unreachable would be the worse outcome).
 *
 * ⚠ Reads come through brix-order, not PostgREST: the signed file URLs are
 * minted from the service-role bucket key, which the browser must not hold.
 * Archive is soft — a superseded document stays as history.
 */

interface Props { qboCustomerId: string; customerName?: string | null }

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function CustomerDocumentsCard({ qboCustomerId, customerName }: Props) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [cust, setCust] = useState<OrdersCustomer | null | undefined>(undefined);
  const [docs, setDocs] = useState<CustomerDocument[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // upload draft
  const [uType, setUType] = useState<DocType>('resale_cert');
  const [uLabel, setULabel] = useState('');
  const [uNumber, setUNumber] = useState('');
  const [uExpires, setUExpires] = useState('');
  const [uNotes, setUNotes] = useState('');
  const [uFile, setUFile] = useState<File | null>(null);
  // edit draft
  const [eLabel, setELabel] = useState('');
  const [eNumber, setENumber] = useState('');
  const [eExpires, setEExpires] = useState('');
  const [eNotes, setENotes] = useState('');

  async function load(showArchived = archived) {
    setErr('');
    try {
      const c = await fetchOrdersCustomer(qboCustomerId);
      setCust(c);
      if (!c) { setDocs([]); return; }
      setDocs(await fetchDocuments(c.id, showArchived));
    } catch (e) {
      setErr((e as Error).message); setDocs([]);
    }
  }
  // The customer handle loads on mount (shared, memoised); the document list
  // waits for the card to open — it is a cross-origin call that mints signed
  // URLs, and there is no point minting them for a folded card.
  useEffect(() => {
    setCust(undefined); setDocs(null);
    void fetchOrdersCustomer(qboCustomerId).then(setCust).catch((e) => { setErr((e as Error).message); setCust(null); });
  }, [qboCustomerId]);
  useEffect(() => { if (open && cust && docs === null) void load(); },
    [open, cust]); // eslint-disable-line react-hooks/exhaustive-deps
  // Re-read when another card changes the record (e.g. Set up in the portal).
  useEffect(() => onOrdersCustomerChanged(qboCustomerId, () => {
    setDocs(null);
    void fetchOrdersCustomer(qboCustomerId).then(setCust).catch(() => setCust(null));
  }), [qboCustomerId]);

  async function run(what: string, fn: () => Promise<{ push_notes?: string[] }>) {
    setBusy(what); setNotes([]);
    try {
      const res = await fn();
      if (res.push_notes?.length) setNotes(res.push_notes);
      toast.success('Saved.');
      setEditing(null); setAdding(false);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function submitUpload() {
    if (!cust) return;
    if (!uFile && !uNumber.trim()) {
      toast.error('Attach a file or enter the document number — one of the two is needed.');
      return;
    }
    if (uFile && uFile.size > DOC_MAX_BYTES) {
      toast.error(`That file is ${(uFile.size / 1048576).toFixed(1)} MB — the limit is 4 MB.`);
      return;
    }
    let file: { name: string; data: string } | null = null;
    if (uFile) {
      try { file = { name: uFile.name, data: await fileToDataUrl(uFile) }; }
      catch (e) { toast.error((e as Error).message); return; }
    }
    await run('upload', () => uploadDocument(cust.id, {
      doc_type: uType, label: uLabel.trim() || null, doc_number: uNumber.trim() || null,
      expires_on: uExpires || null, notes: uNotes.trim() || null, file,
    }));
    setULabel(''); setUNumber(''); setUExpires(''); setUNotes(''); setUFile(null);
  }

  const active = (docs ?? []);
  const summary = cust === undefined ? 'Refractor'
    : cust === null ? 'not set up in the portal'
    : docs === null ? 'open to load'
    : archived ? `${active.length} archived`
    : `${active.length} document${active.length === 1 ? '' : 's'}`
      + (active.some((d) => docExpiryStatus(d.expires_on) === 'expired') ? ' · EXPIRED on file'
        : active.some((d) => docExpiryStatus(d.expires_on) === 'expiring') ? ' · one expiring soon' : '');

  return (
    <CardShell title="Documents & attachments" open={open} onToggle={() => setOpen((o) => !o)} summary={summary}>
      {err ? (
        <Note tone="red">
          <div style={{ fontWeight: 600, color: 'var(--rd)' }}>Could not load documents</div>
          <div style={{ marginTop: 2 }}>{err}</div>
          <button type="button" style={{ ...btn(), marginTop: 6 }} onClick={() => void load()}>
            <RefreshCw size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Try again
          </button>
        </Note>
      ) : cust === undefined || (cust && docs === null) ? (
        <div style={{ fontSize: 11, color: 'var(--mt)' }}>Loading…</div>
      ) : cust === null ? (
        <Note tone="plain">
          <strong>{customerName ?? 'This customer'}</strong> has no portal record, so there is no vault to
          file into yet. Set the customer up from the Billing card above.
        </Note>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 10, color: 'var(--mt)', flex: 1, minWidth: 220 }}>
              Tax ID, resale certificate, the signed application, the ACH form. A file uploaded here is
              also attached to the customer in QuickBooks.
            </div>
            <label style={{ fontSize: 10, color: 'var(--mt)', display: 'flex', gap: 5, alignItems: 'center' }}>
              <input type="checkbox" checked={archived}
                onChange={(e) => { setArchived(e.target.checked); setDocs(null); void load(e.target.checked); }} />
              show archived instead
            </label>
          </div>

          <div style={{ marginTop: 6 }}>
            {active.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--mt)' }}>
                {archived ? 'Nothing archived.' : 'Nothing on file.'}
              </div>
            )}
            {active.map((d) => {
              const status = docExpiryStatus(d.expires_on);
              const isEditing = editing === d.id;
              return (
                <div key={d.id} data-document-id={d.id} style={{ padding: '8px 0', borderTop: '1px solid var(--bd)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <FileText size={12} strokeWidth={2.3} color="var(--mt)" aria-hidden="true" />
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tx)' }}>
                      {d.label || docTypeLabel(d.doc_type)}
                    </span>
                    {d.label && <span style={chip('plain')}>{docTypeLabel(d.doc_type)}</span>}
                    {d.doc_number && <span style={{ fontSize: 11, color: 'var(--tx2)', fontFamily: 'ui-monospace, monospace' }}>{d.doc_number}</span>}
                    {status === 'expired' && <span style={chip('red')}>expired {d.expires_on}</span>}
                    {status === 'expiring' && <span style={chip('amber')}>expires {d.expires_on}</span>}
                    {status === 'current' && <span style={chip('plain')}>expires {d.expires_on}</span>}
                    {d.file_path && (d.qbo_attachable_id
                      ? <span style={chip('green')} title={`QuickBooks Attachable ${d.qbo_attachable_id}`}>in QuickBooks</span>
                      : <span style={chip('amber')} title="The file is here but was never pushed onto the QuickBooks Customer">not in QuickBooks</span>)}
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      {d.file_url && (
                        <a href={d.file_url} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: 'none' }}>
                          Open {d.file_name ? '' : 'file'}
                        </a>
                      )}
                      {!archived && !isEditing && (
                        <button type="button" style={btn()} disabled={!!busy}
                          onClick={() => {
                            setAdding(false); setEditing(d.id); setNotes([]);
                            setELabel(d.label ?? ''); setENumber(d.doc_number ?? '');
                            setEExpires(d.expires_on ?? ''); setENotes(d.notes ?? '');
                          }}>
                          <Pencil size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Edit
                        </button>
                      )}
                      {!archived && (
                        <button type="button" style={btn('danger')} disabled={!!busy}
                          onClick={() => {
                            const ok = window.confirm(
                              `Archive “${d.label || docTypeLabel(d.doc_type)}”?\n\nIt stays on record under `
                              + '“show archived” and is not deleted. A copy already pushed to QuickBooks stays there.');
                            if (ok) void run('archive:' + d.id, () => archiveDocument(d.id));
                          }}>
                          {busy === 'archive:' + d.id ? '…' : 'Archive'}
                        </button>
                      )}
                    </span>
                  </div>
                  {!isEditing && (
                    <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3, paddingLeft: 20 }}>
                      {d.file_name ? d.file_name : <span style={{ color: 'var(--am)' }}>no file — number only</span>}
                      {' · '}filed {fmtDate(d.created_at)}{d.uploaded_by ? ` by ${d.uploaded_by}` : ''}
                      {d.notes && <div style={{ marginTop: 2, color: 'var(--tx2)' }}>{d.notes}</div>}
                    </div>
                  )}
                  {isEditing && (
                    <div style={{ marginTop: 8, padding: '10px 12px', border: '1px solid var(--bd)', borderRadius: 4 }}>
                      <div className="gr" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10 }}>
                        <div><div style={lbl}>Label</div>
                          <input style={{ ...ctl, width: '100%', marginTop: 3 }} value={eLabel} onChange={(e) => setELabel(e.target.value)} /></div>
                        <div><div style={lbl}>Document number</div>
                          <input style={{ ...ctl, width: '100%', marginTop: 3 }} value={eNumber} onChange={(e) => setENumber(e.target.value)} /></div>
                        <div><div style={lbl}>Expires</div>
                          <input type="date" style={{ ...ctl, width: '100%', marginTop: 3 }} value={eExpires} onChange={(e) => setEExpires(e.target.value)} /></div>
                        <div><div style={lbl}>Notes</div>
                          <input style={{ ...ctl, width: '100%', marginTop: 3 }} value={eNotes} onChange={(e) => setENotes(e.target.value)} /></div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button type="button" style={btn('primary')} disabled={busy === 'edit:' + d.id}
                          onClick={() => void run('edit:' + d.id, () => updateDocument(d.id, {
                            label: eLabel.trim() || null, doc_number: eNumber.trim() || null,
                            expires_on: eExpires || null, notes: eNotes.trim() || null,
                          }))}>
                          {busy === 'edit:' + d.id ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" style={btn()} onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 6 }}>
                        The file itself is not replaceable — file a new document and archive this one.
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!archived && !adding && (
            <button type="button" style={{ ...btn('primary'), marginTop: 10 }} disabled={!!busy}
              onClick={() => { setEditing(null); setAdding(true); setNotes([]); }}>
              <Plus size={11} style={{ verticalAlign: -1, marginRight: 4 }} />File a document
            </button>
          )}
          {adding && (
            <div style={{ marginTop: 8, padding: '10px 12px', border: '1px solid var(--bd)', borderRadius: 4 }}>
              <div className="gr" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10 }}>
                <div>
                  <div style={lbl}>Type</div>
                  <select style={{ ...ctl, width: '100%', marginTop: 3 }} value={uType}
                    onChange={(e) => setUType(e.target.value as DocType)}>
                    {DOC_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select>
                </div>
                <div><div style={lbl}>Label (optional)</div>
                  <input style={{ ...ctl, width: '100%', marginTop: 3 }} value={uLabel} onChange={(e) => setULabel(e.target.value)} placeholder="e.g. Account application" /></div>
                <div><div style={lbl}>Document number</div>
                  <input style={{ ...ctl, width: '100%', marginTop: 3 }} value={uNumber} onChange={(e) => setUNumber(e.target.value)} placeholder="EIN, permit #…" /></div>
                <div><div style={lbl}>Expires</div>
                  <input type="date" style={{ ...ctl, width: '100%', marginTop: 3 }} value={uExpires} onChange={(e) => setUExpires(e.target.value)} /></div>
                <div style={{ gridColumn: '1 / -1' }}><div style={lbl}>Notes</div>
                  <input style={{ ...ctl, width: '100%', marginTop: 3 }} value={uNotes} onChange={(e) => setUNotes(e.target.value)} /></div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={lbl}>File — PDF, PNG, JPEG or WebP, up to 4 MB</div>
                  <input type="file" accept={DOC_ACCEPT} style={{ fontSize: 11, marginTop: 4 }}
                    onChange={(e) => setUFile(e.target.files?.[0] ?? null)} />
                  {uFile && <span style={{ fontSize: 10, color: 'var(--mt)', marginLeft: 8 }}>
                    {uFile.name} · {(uFile.size / 1024).toFixed(0)} KB
                  </span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button type="button" style={btn('primary')} disabled={busy === 'upload'} onClick={() => void submitUpload()}>
                  <Upload size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                  {busy === 'upload' ? 'Filing…' : uFile ? 'File it & attach in QuickBooks' : 'File it (number only)'}
                </button>
                <button type="button" style={btn()} disabled={busy === 'upload'} onClick={() => setAdding(false)}>Cancel</button>
              </div>
              <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 6 }}>
                A file or a document number is required — a resale certificate can be filed by its
                permit number before the paper arrives.
              </div>
            </div>
          )}

          <PushNotes notes={notes} />

          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 14, borderTop: '1px solid var(--bd)', paddingTop: 8 }}>
            Files live in the private customer-docs bucket; the Open link is a one-hour signed URL.
            Same vault as Brix Order’s Account documents card — one table, one writer. Archive is soft.
          </div>
        </>
      )}
    </CardShell>
  );
}
