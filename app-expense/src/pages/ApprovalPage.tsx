import { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ClipboardList, CheckCircle, XCircle, Loader2, AlertTriangle,
  Eraser, ShoppingCart,
} from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import SignatureCanvas from 'react-signature-canvas';

type PageState = 'loading' | 'ready' | 'decided' | 'expired' | 'error';

interface RequestData {
  id: string;
  request_type: 'expense' | 'purchase_request';
  status: string;
  vendor_name?: string | null;
  total_amount?: number | null;
  receipt_date?: string | null;
  cogs_account_label?: string | null;
  department?: string | null;
  customer_name?: string | null;
  job_number?: string | null;
  memo?: string | null;
  submitter_name?: string | null;
  submitter_email?: string | null;
  line_items?: Array<{ description?: string; qty?: number; unit_price?: number; amount?: number }>;
  manager_email?: string | null;
}

export default function ApprovalPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [state, setState] = useState<PageState>('loading');
  const [request, setRequest] = useState<RequestData | null>(null);
  const [decided, setDecided] = useState<{ action: string; signer_name?: string } | null>(null);

  const [signerName, setSignerName] = useState('');
  const [signerInitials, setSignerInitials] = useState('');
  const [declineReason, setDeclineReason] = useState('');
  const [declineMode, setDeclineMode] = useState(false);
  const [submitting, setSubmitting] = useState<'' | 'approve' | 'decline'>('');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const sigRef = useRef<SignatureCanvas | null>(null);

  // Load request by token
  useEffect(() => {
    if (!token) {
      setState('error');
      setErrorMessage('Missing approval link. Please use the link from your email.');
      return;
    }
    (async () => {
      try {
        const r = await fetch(`/expense/api/expense-request-decide?token=${encodeURIComponent(token)}`);
        const d = await r.json();
        if (!r.ok) {
          setState('error');
          setErrorMessage(d.error || 'Invalid approval link');
          return;
        }
        if (d.already_decided) {
          setRequest(d.request);
          setDecided({
            action: d.request?.status === 'denied' ? 'denied' : 'approved',
            signer_name: d.approval?.decided_by,
          });
          setState('decided');
          return;
        }
        setRequest(d.request);
        setState('ready');
      } catch (e) {
        setState('error');
        setErrorMessage(e instanceof Error ? e.message : 'Connection error');
      }
    })();
  }, [token]);

  const clearSig = useCallback(() => sigRef.current?.clear(), []);

  async function submit(decision: 'approve' | 'decline') {
    if (!token || !request) return;
    setErrorMessage('');
    if (!signerName.trim() || signerName.trim().length < 2) {
      setErrorMessage('Please type your full name.');
      return;
    }
    if (!signerInitials.trim()) {
      setErrorMessage('Please type your initials.');
      return;
    }
    if (decision === 'decline' && !declineReason.trim()) {
      setErrorMessage('Please explain why you are declining.');
      return;
    }
    setSubmitting(decision);

    let signatureDataUrl: string | null = null;
    if (sigRef.current && !sigRef.current.isEmpty()) {
      try {
        signatureDataUrl = sigRef.current.getTrimmedCanvas().toDataURL('image/png');
      } catch {
        signatureDataUrl = sigRef.current.toDataURL('image/png');
      }
    }

    try {
      const r = await fetch('/expense/api/expense-request-decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          decision,
          signer_name: signerName.trim(),
          signer_initials: signerInitials.trim(),
          signature_data_url: signatureDataUrl,
          decline_reason: decision === 'decline' ? declineReason.trim() : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setErrorMessage(d.error || 'Submission failed');
        setSubmitting('');
        return;
      }
      setDecided({ action: d.action, signer_name: signerName.trim() });
      setState('decided');
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Submission failed');
      setSubmitting('');
    }
  }

  // ── Loading
  if (state === 'loading') {
    return (
      <div className="ap-wrap">
        <div className="ap-loading">
          <Loader2 className="spin" size={36} />
          <p>Loading request…</p>
        </div>
      </div>
    );
  }

  // ── Error
  if (state === 'error') {
    return (
      <div className="ap-wrap">
        <div className="ap-card ap-banner ap-banner-denied">
          <AlertTriangle size={36} />
          <h1>Link invalid</h1>
          <p>{errorMessage || 'This approval link is no longer valid.'}</p>
        </div>
      </div>
    );
  }

  // ── Decided
  if (state === 'decided') {
    const approved = decided?.action === 'approved' || decided?.action === 'approve';
    return (
      <div className="ap-wrap">
        <div className={`ap-card ap-banner ${approved ? 'ap-banner-approved' : 'ap-banner-denied'}`}>
          {approved ? <CheckCircle size={36} /> : <XCircle size={36} />}
          <h1>{approved ? '✓ Request Approved' : '✗ Request Declined'}</h1>
          <p>
            {request?.vendor_name ? `${request.vendor_name} · ` : ''}
            {request?.total_amount ? formatCurrency(request.total_amount) : ''}
          </p>
          {decided?.signer_name && (
            <p className="ap-banner-sub">Signed by <strong>{decided.signer_name}</strong></p>
          )}
          <p className="ap-banner-note">You may close this window.</p>
        </div>
      </div>
    );
  }

  // ── Ready
  if (!request) return null;
  const isPR = request.request_type === 'purchase_request';

  return (
    <div className="ap-wrap">
      {/* Header */}
      <div className="ap-card">
        <div className="ap-header">
          <ClipboardList className="ap-header-icon" size={28} />
          <div>
            <h1>{isPR ? 'Purchase Request Approval' : 'Expense Approval'}</h1>
            <p className="ap-meta">
              {request.submitter_name || 'A team member'} ·
              {request.total_amount ? ` ${formatCurrency(request.total_amount)}` : ''}
            </p>
          </div>
        </div>

        <p className="ap-intro">
          <strong>{request.submitter_name || 'A team member'}</strong> submitted this {isPR ? 'purchase request' : 'expense'} and routed it to you for approval. Please review and sign below.
        </p>

        {isPR && (
          <div className="ap-warn">
            <ShoppingCart size={16} />
            <span><strong>Time-sensitive:</strong> Approve promptly to avoid delays in procurement.</span>
          </div>
        )}

        {request.memo && (
          <div className="ap-note">
            <span className="ap-note-label">Note from submitter</span>
            <p>{request.memo}</p>
          </div>
        )}

        <div className="ap-summary">
          <div><span className="ap-sum-label">Vendor</span><span className="ap-sum-value">{request.vendor_name || '—'}</span></div>
          <div><span className="ap-sum-label">Department</span><span className="ap-sum-value">{request.department || '—'}</span></div>
          <div><span className="ap-sum-label">Account</span><span className="ap-sum-value">{request.cogs_account_label || '—'}</span></div>
          {request.customer_name && <div><span className="ap-sum-label">Customer</span><span className="ap-sum-value">{request.customer_name}</span></div>}
          {request.job_number && <div><span className="ap-sum-label">Job #</span><span className="ap-sum-value">{request.job_number}</span></div>}
          {request.receipt_date && <div><span className="ap-sum-label">{isPR ? 'Needed By' : 'Date'}</span><span className="ap-sum-value">{formatDate(request.receipt_date)}</span></div>}
          <div><span className="ap-sum-label">Total</span><span className="ap-sum-value ap-sum-total">{request.total_amount ? formatCurrency(request.total_amount) : '—'}</span></div>
        </div>

        {request.line_items && request.line_items.length > 0 && (
          <table className="ap-items">
            <thead><tr>
              <th>Item</th>
              <th className="r">Qty</th>
              <th className="r">Price</th>
              <th className="r">Line</th>
            </tr></thead>
            <tbody>
              {request.line_items.map((li, i) => {
                const amt = li.amount ?? (li.qty || 1) * (li.unit_price || 0);
                return (
                  <tr key={i}>
                    <td>{li.description || `Line ${i + 1}`}</td>
                    <td className="r">{li.qty || 1}</td>
                    <td className="r">{formatCurrency(li.unit_price || 0)}</td>
                    <td className="r" style={{ fontWeight: 600 }}>{formatCurrency(amt)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr>
              <td colSpan={3} className="r">Total</td>
              <td className="r ap-items-total">{request.total_amount ? formatCurrency(request.total_amount) : '—'}</td>
            </tr></tfoot>
          </table>
        )}
      </div>

      {/* Signature card */}
      <div className="ap-card">
        <div className="ap-section-title">Your signature</div>
        <p className="ap-helptext">
          Sign below with your mouse or finger. If your device makes drawing difficult, just type your name and initials — both are legally valid as an electronic signature.
        </p>

        <div className="ap-sig-box">
          <SignatureCanvas
            ref={sigRef}
            penColor="#5BB5F0"
            canvasProps={{
              className: 'ap-sig-canvas',
              style: { width: '100%', height: '180px' },
            }}
          />
          <button type="button" className="ap-sig-clear" onClick={clearSig}>
            <Eraser size={14} /> Clear
          </button>
        </div>

        <div className="ap-name-grid">
          <div className="ap-field">
            <label htmlFor="signerName">Full name <span className="ap-required">*</span></label>
            <input
              id="signerName"
              type="text"
              placeholder="Jane Doe"
              autoComplete="name"
              maxLength={200}
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
            />
          </div>
          <div className="ap-field">
            <label htmlFor="signerInitials">Initials <span className="ap-required">*</span></label>
            <input
              id="signerInitials"
              type="text"
              placeholder="JD"
              maxLength={10}
              value={signerInitials}
              onChange={(e) => setSignerInitials(e.target.value)}
            />
          </div>
        </div>

        <div className="ap-date">Date of signature: <strong>{new Date().toLocaleString()}</strong></div>

        <div className="ap-actions">
          <button
            type="button"
            className="ap-btn ap-btn-decline"
            onClick={() => setDeclineMode(true)}
            disabled={!!submitting}
          >
            Decline
          </button>
          <button
            type="button"
            className="ap-btn ap-btn-approve"
            onClick={() => submit('approve')}
            disabled={!!submitting}
          >
            {submitting === 'approve' && <Loader2 className="spin" size={16} />}
            ✓ Approve
          </button>
        </div>

        {declineMode && (
          <div className="ap-decline-wrap">
            <label htmlFor="declineReason">Reason for declining <span className="ap-required">*</span></label>
            <textarea
              id="declineReason"
              placeholder="Please explain why you are declining…"
              rows={3}
              maxLength={2000}
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
            />
            <button
              type="button"
              className="ap-btn ap-btn-decline"
              onClick={() => submit('decline')}
              disabled={!!submitting}
              style={{ marginTop: 10 }}
            >
              {submitting === 'decline' && <Loader2 className="spin" size={16} />}
              Submit decline
            </button>
          </div>
        )}

        {errorMessage && <div className="ap-error">{errorMessage}</div>}
      </div>

      <p className="ap-footer">
        Approval link for {request.manager_email || 'the chosen approver'}.
      </p>
    </div>
  );
}
