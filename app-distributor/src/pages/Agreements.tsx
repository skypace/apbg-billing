import { useRef, useState } from 'react';
import { Download, FileSignature, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useDistributor } from '@/lib/distributor';
import { useLoad } from '@/lib/hooks';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { Spinner, ErrorNote, EmptyNote, AgreementStatusChip, Chip } from '@/components/ui';
import { SignaturePad, type SignaturePadHandle } from '@/components/SignaturePad';
import type { Agreement } from '@/lib/types';

function modelLabel(m: string) {
  return m === 'sell_in' ? 'Sell-in' : 'Consignment';
}

function AgreementCard({ agreement, onSigned }: { agreement: Agreement; onSigned: () => void }) {
  const a = agreement;
  const [signerName, setSignerName] = useState('');
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);
  const padRef = useRef<SignaturePadHandle>(null);

  async function downloadPdf() {
    if (!a.file_path) return;
    setDownloading(true);
    setDlError(null);
    // Members may read their own <sub_distributor_id>/ prefix of the private
    // 'distributor-docs' bucket — download with the user session, then open a
    // blob URL.
    const { data, error } = await supabase.storage
      .from('distributor-docs')
      .download(a.file_path);
    setDownloading(false);
    if (error || !data) {
      setDlError(error?.message ?? 'Download failed');
      return;
    }
    const url = URL.createObjectURL(data);
    const link = document.createElement('a');
    link.href = url;
    link.download = a.file_name ?? a.file_path.split('/').pop() ?? 'agreement.pdf';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function sign() {
    if (!signerName.trim()) {
      setSignError('Type your full legal name first.');
      return;
    }
    setSigning(true);
    setSignError(null);
    const signature = padRef.current?.toDataURL() ?? null;
    const { error } = await supabase.rpc('fn_distributor_sign_agreement', {
      p_agreement_id: a.id,
      p_signer_name: signerName.trim(),
      p_signature_data: signature,
    });
    setSigning(false);
    if (error) {
      setSignError(error.message);
      return;
    }
    onSigned();
  }

  return (
    <div className="glass-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 className="mt-0">
          {a.title ?? `Distribution agreement v${a.version}`}
        </h3>
        <AgreementStatusChip status={a.status} />
        <Chip tone="neutral">v{a.version}</Chip>
      </div>

      <div className="def-grid" style={{ marginBottom: 14 }}>
        <div><span className="def-label">Model</span><span className="def-value">{modelLabel(a.model)}</span></div>
        {a.per_case_delivery_fee !== null && (
          <div>
            <span className="def-label">Your per-case delivery fee</span>
            <span className="def-value">{fmtMoney(a.per_case_delivery_fee)}</span>
          </div>
        )}
        <div><span className="def-label">Effective</span><span className="def-value">{fmtDate(a.effective_date)}</span></div>
        <div><span className="def-label">Expires</span><span className="def-value">{fmtDate(a.expiry_date)}</span></div>
      </div>

      {a.status === 'sent' && a.terms && (
        <div style={{ marginBottom: 14 }}>
          <div className="def-label" style={{ marginBottom: 6 }}>Terms</div>
          <div
            style={{
              whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6,
              maxHeight: 320, overflowY: 'auto',
              border: '1px solid var(--bd)', borderRadius: 12, padding: '14px 16px',
              background: 'var(--glass-input)',
            }}
          >
            {a.terms}
          </div>
        </div>
      )}

      {a.file_path && (
        <div style={{ marginBottom: 14 }}>
          <button type="button" className="btn btn-outline btn-sm" onClick={downloadPdf} disabled={downloading}>
            {downloading ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            Download PDF{a.file_name ? ` — ${a.file_name}` : ''}
          </button>
          {dlError && <div className="err-note">{dlError}</div>}
        </div>
      )}

      {a.status === 'sent' && (
        <div style={{ borderTop: '1px solid var(--bd-light)', paddingTop: 16 }}>
          <h3 style={{ fontSize: 16, marginBottom: 6 }}>Sign this agreement</h3>
          <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--tx2)' }}>
            Type your full legal name, and (optionally) sign in the box below.
            Your signature is recorded with your login email and a timestamp.
          </p>
          <div className="field-col" style={{ marginBottom: 12, maxWidth: 420 }}>
            <label className="fld" htmlFor={`sig-name-${a.id}`}>Full legal name *</label>
            <input
              id={`sig-name-${a.id}`}
              type="text"
              placeholder="Full name"
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
            />
          </div>
          <SignaturePad ref={padRef} />
          {signError && <div className="err-note">{signError}</div>}
          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn btn-green"
              disabled={signing || !signerName.trim()}
              onClick={sign}
            >
              {signing ? <Loader2 size={16} className="spin" /> : <FileSignature size={16} />}
              Sign agreement
            </button>
          </div>
        </div>
      )}

      {a.status === 'signed' && (
        <div style={{ borderTop: '1px solid var(--bd-light)', paddingTop: 14 }}>
          <div className="def-grid">
            <div>
              <span className="def-label">Signed by</span>
              <span className="def-value">
                {a.signer_name ?? '—'}
                {a.signer_email ? ` (${a.signer_email})` : ''}
              </span>
            </div>
            <div>
              <span className="def-label">Signed at</span>
              <span className="def-value">{fmtDateTime(a.signed_at)}</span>
            </div>
          </div>
          {a.signature_data && (
            <div style={{ marginTop: 12 }}>
              <div className="def-label" style={{ marginBottom: 6 }}>Signature</div>
              <img src={a.signature_data} alt="Recorded signature" className="sig-img" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Agreements() {
  const { distributor } = useDistributor();
  const distId = distributor?.id ?? null;

  const { data, loading, error, reload } = useLoad<Agreement[]>(async () => {
    if (!distId) return [];
    // RLS gives members every non-draft agreement for their distributor.
    const { data: rows, error: err } = await supabase
      .from('sub_distributor_agreements')
      .select(
        'id, sub_distributor_id, version, title, model, per_case_delivery_fee, effective_date, expiry_date, terms, file_path, file_name, status, sent_at, signed_at, signer_name, signer_email, signature_data'
      )
      .eq('sub_distributor_id', distId)
      .order('version', { ascending: false });
    if (err) throw new Error(err.message);
    return (rows ?? []) as Agreement[];
  }, [distId]);

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;

  const agreements = data ?? [];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Agreements</h1>
          <p>
            Your distribution agreements with Brix Beverage. Agreements sent to
            you can be reviewed and signed right here.
          </p>
        </div>
      </div>

      {agreements.length === 0 ? (
        <div className="glass-card">
          <EmptyNote>
            No agreements on file yet — your Brix Beverage rep will send one
            when it&rsquo;s ready to review.
          </EmptyNote>
        </div>
      ) : (
        agreements.map((a) => (
          <AgreementCard key={a.id} agreement={a} onSigned={reload} />
        ))
      )}
    </div>
  );
}
