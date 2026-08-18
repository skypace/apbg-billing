import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  AgreementStatus,
  MAX_AGREEMENT_FILE_BYTES,
  NewAgreement,
  SubDistributor,
  SubDistributorAgreement,
  SubDistributorModel,
  createAgreement,
  downloadAgreementFile,
  fetchAgreements,
  sendAgreement,
  updateAgreement,
  uploadAgreementFile,
} from '../../lib/subDistributors';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { Chip, errMsg, LField, Modal, Td, Th } from './common';

const AGREEMENT_STATUS_COLOR: Record<AgreementStatus, string> = {
  draft:   'var(--mt)',
  sent:    'var(--am)',
  signed:  'var(--gn)',
  expired: 'var(--rd)',
  void:    '#64748b',
};

export function DistributorAgreementsTab({ dist }: { dist: SubDistributor }) {
  const toast = useToast();
  const [rows, setRows] = useState<SubDistributorAgreement[] | null>(null);
  const [editing, setEditing] = useState<SubDistributorAgreement | 'new' | null>(null);
  const [busy, setBusy] = useState(false);

  function reload() {
    setRows(null);
    fetchAgreements(dist.id).then(setRows).catch((e) => { setRows([]); toast.error(errMsg(e)); });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [dist.id]);

  async function markSent(a: SubDistributorAgreement) {
    const sentTo = prompt('Sent to (email)?', dist.contact_email ?? '');
    if (sentTo == null) return;
    setBusy(true);
    try {
      await sendAgreement(a.id, sentTo.trim());
      toast.success(`Agreement v${a.version} marked sent`);
      reload();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function download(a: SubDistributorAgreement) {
    if (!a.file_path) return;
    try {
      await downloadAgreementFile(a.file_path, a.file_name ?? undefined);
    } catch (e) { toast.error(errMsg(e)); }
  }

  const nextVersion = rows && rows.length ? Math.max(...rows.map((r) => r.version)) + 1 : 1;

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: 'var(--mt)', fontSize: 11 }}>
            {rows === null ? 'Loading…' : `${rows.length} agreement${rows.length === 1 ? '' : 's'}`}
          </span>
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <button onClick={() => setEditing('new')} style={btnPrimary()}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> New Agreement
          </button>
        </div>
      </div>

      <div className="cd" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--sf)', borderBottom: '1px solid var(--bd)' }}>
              <Th>Ver</Th>
              <Th>Title</Th>
              <Th>Model</Th>
              <Th>Fee/case</Th>
              <Th>Effective</Th>
              <Th>Expires</Th>
              <Th>Status</Th>
              <Th>Signed by</Th>
              <Th>File</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {rows !== null && rows.length === 0 && (
              <tr><td colSpan={10} style={{ padding: 14, color: 'var(--mt)', textAlign: 'center' }}>
                No agreements yet.
              </td></tr>
            )}
            {(rows ?? []).map((a) => (
              <tr key={a.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <Td><code style={{ fontFamily: 'var(--ff-mono)', color: 'var(--ac)' }}>v{a.version}</code></Td>
                <Td><span style={{ fontWeight: 600 }}>{a.title ?? '—'}</span></Td>
                <Td><span style={{ color: 'var(--mt)', fontSize: 10.5 }}>
                  {a.model === 'sell_in' ? 'Sell-In' : 'Consignment'}
                </span></Td>
                <Td>{a.per_case_delivery_fee == null ? '—' : `$${Number(a.per_case_delivery_fee).toFixed(2)}`}</Td>
                <Td>{a.effective_date ?? '—'}</Td>
                <Td>{a.expiry_date ?? '—'}</Td>
                <Td><Chip label={a.status} color={AGREEMENT_STATUS_COLOR[a.status] ?? 'var(--mt)'} /></Td>
                <Td>
                  {a.status === 'signed' && a.signer_name ? (
                    <div>
                      <div style={{ fontSize: 11 }}>{a.signer_name}</div>
                      <div style={{ fontSize: 9.5, color: 'var(--mt)' }}>
                        {a.signed_at ? new Date(a.signed_at).toLocaleString() : ''}
                      </div>
                    </div>
                  ) : '—'}
                </Td>
                <Td>
                  {a.file_path ? (
                    <button onClick={() => download(a)} style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color: 'var(--ac)', fontSize: 11, padding: 0, textDecoration: 'underline',
                    }}>{a.file_name ?? 'Download'}</button>
                  ) : <span style={{ color: 'var(--mt)' }}>—</span>}
                </Td>
                <Td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => setEditing(a)} style={btnSecondary()}>Edit</button>
                    {a.status === 'draft' && (
                      <button onClick={() => markSent(a)} disabled={busy} style={btnPrimary()}>Mark sent</button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Signed signature preview */}
      {(rows ?? []).filter((a) => a.status === 'signed' && a.signature_data).map((a) => (
        <div key={a.id} className="cd" style={{ padding: 12, marginTop: 12 }}>
          <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
            v{a.version} signature — {a.signer_name} ({a.signer_email ?? 'no email'})
            {a.signed_at ? ` · ${new Date(a.signed_at).toLocaleString()}` : ''}
          </div>
          <img
            src={a.signature_data as string}
            alt={`Signature of ${a.signer_name ?? 'signer'}`}
            style={{ maxWidth: 320, maxHeight: 110, background: '#fff', borderRadius: 4, padding: 6 }}
          />
        </div>
      ))}

      {editing && (
        <AgreementDialog
          dist={dist}
          agreement={editing === 'new' ? null : editing}
          nextVersion={nextVersion}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

// ── New / Edit dialog ─────────────────────────────────────────────────────

function AgreementDialog({ dist, agreement, nextVersion, onClose, onSaved }: {
  dist: SubDistributor;
  agreement: SubDistributorAgreement | null;
  nextVersion: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const [version, setVersion] = useState(String(agreement?.version ?? nextVersion));
  const [title, setTitle] = useState(agreement?.title ?? '');
  const [model, setModel] = useState<SubDistributorModel>(agreement?.model ?? dist.model);
  const [fee, setFee] = useState(
    agreement?.per_case_delivery_fee == null
      ? (dist.per_case_delivery_fee == null || agreement ? '' : String(dist.per_case_delivery_fee))
      : String(agreement.per_case_delivery_fee),
  );
  const [effective, setEffective] = useState(agreement?.effective_date ?? '');
  const [expiry, setExpiry] = useState(agreement?.expiry_date ?? '');
  const [terms, setTerms] = useState(agreement?.terms ?? '');
  const [status, setStatus] = useState<AgreementStatus>(agreement?.status ?? 'draft');
  const [file, setFile] = useState<File | null>(null);

  const canSave = !!version.trim() && Number(version) > 0 && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      let filePatch: { file_path?: string; file_name?: string } = {};
      if (file) {
        if (file.size > MAX_AGREEMENT_FILE_BYTES) {
          throw new Error('File exceeds the 25 MB limit');
        }
        const up = await uploadAgreementFile(dist.id, file);
        filePatch = { file_path: up.path, file_name: up.name };
      }
      if (agreement) {
        await updateAgreement(agreement.id, {
          version: Number(version),
          title: title.trim() || null,
          model,
          per_case_delivery_fee: fee === '' ? null : Number(fee),
          effective_date: effective || null,
          expiry_date: expiry || null,
          terms: terms.trim() || null,
          status,
          ...filePatch,
        });
        toast.success('Agreement saved');
      } else {
        const row: NewAgreement = {
          sub_distributor_id: dist.id,
          version: Number(version),
          title: title.trim() || null,
          model,
          per_case_delivery_fee: fee === '' ? null : Number(fee),
          effective_date: effective || null,
          expiry_date: expiry || null,
          terms: terms.trim() || null,
          status: 'draft',
          ...filePatch,
        };
        await createAgreement(row);
        toast.success('Agreement created');
      }
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={agreement ? `Edit Agreement v${agreement.version}` : 'New Agreement'} onClose={onClose} maxWidth={640}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <LField label="Version">
          <input type="number" min={1} style={{ ...inp(), width: '100%' }} value={version}
            onChange={(e) => setVersion(e.target.value)} />
        </LField>
        <LField label="Title">
          <input style={{ ...inp(), width: '100%' }} value={title}
            onChange={(e) => setTitle(e.target.value)} placeholder="Distribution agreement" />
        </LField>
        <LField label="Model">
          <select style={{ ...inp(), width: '100%' }} value={model}
            onChange={(e) => setModel(e.target.value as SubDistributorModel)}>
            <option value="consignment">Consignment</option>
            <option value="sell_in">Sell-In</option>
          </select>
        </LField>
        <LField label="Fee per case ($)">
          <input type="number" min={0} step="any" style={{ ...inp(), width: '100%' }} value={fee}
            onChange={(e) => setFee(e.target.value)} />
        </LField>
        <LField label="Effective date">
          <input type="date" style={{ ...inp(), width: '100%' }} value={effective}
            onChange={(e) => setEffective(e.target.value)} />
        </LField>
        <LField label="Expiry date">
          <input type="date" style={{ ...inp(), width: '100%' }} value={expiry}
            onChange={(e) => setExpiry(e.target.value)} />
        </LField>
        {agreement && (
          <LField label="Status">
            <select style={{ ...inp(), width: '100%' }} value={status}
              onChange={(e) => setStatus(e.target.value as AgreementStatus)}>
              <option value="draft">Draft</option>
              <option value="sent">Sent</option>
              <option value="signed">Signed</option>
              <option value="expired">Expired</option>
              <option value="void">Void</option>
            </select>
          </LField>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <LField label="Terms (shown in the distributor portal)">
          <textarea rows={4} style={{ ...inp(), width: '100%', resize: 'vertical', minHeight: 70 }}
            value={terms} onChange={(e) => setTerms(e.target.value)} />
        </LField>
      </div>

      <div style={{ marginTop: 12 }}>
        <LField label={agreement?.file_name ? `PDF (current: ${agreement.file_name})` : 'PDF'}>
          <input type="file" accept="application/pdf" style={{ fontSize: 11, color: 'var(--tx)' }}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </LField>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button onClick={onClose} style={btnSecondary()}>Cancel</button>
        <button onClick={save} disabled={!canSave} style={btnPrimary()}>
          {saving ? 'Saving…' : agreement ? 'Save' : 'Create'}
        </button>
      </div>
    </Modal>
  );
}
