import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase, getAccessToken } from '@/lib/supabase';
import { useSession } from '@/lib/hooks';
import {
  ClipboardList, CheckCircle, XCircle, Loader2, AlertTriangle,
  Eraser, ShoppingCart, ArrowLeft,
} from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import SignatureCanvas from 'react-signature-canvas';

type PageState = 'loading' | 'ready' | 'decided' | 'submitter' | 'notfound' | 'forbidden' | 'error';

interface RequestRow {
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
  manager_email?: string | null;
  submitted_by?: string | null;
  line_items?: Array<{ description?: string; qty?: number; unit_price?: number; amount?: number }>;
}

export default function ApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { session } = useSession();

  const [state, setState] = useState<PageState>('loading');
  const [request, setRequest] = useState<RequestRow | null>(null);
  const [decided, setDecided] = useState<{ action: string; signer_name?: string } | null>(null);

  const [signerName, setSignerName] = useState('');
  const [signerInitials, setSignerInitials] = useState('');
  const [declineReason, setDeclineReason] = useState('');
  const [declineMode, setDeclineMode] = useState(false);
  const [submitting, setSubmitting] = useState<'' | 'approve' | 'decline'>('');
  const [errorMessage, setErrorMessage] = useState('');

  const sigRef = useRef<SignatureCanvas | null>(null);

  const myEmail = (session?.user?.email || '').toLowerCase();
  const myName = (session?.user?.user_metadata as { full_name?: string } | undefined)?.full_name
    || session?.user?.email
    || '';
  // Server-controlled role (vs. user-editable user_metadata). Mirrors the
  // backend escape hatch in expense-request-decide.mjs so a superadmin who
  // routed a PR to themselves can actually reach the Approve button —
  // without this, the page-load gate below short-circuits to 'forbidden'
  // and the relaxed backend gate is unreachable through the UI.
  const myRole = (session?.user?.app_metadata as { role?: string } | undefined)?.role || null;
  const isSuperadmin = myRole === 'superadmin';

  useEffect(() => {
    if (myName && !signerName) setSignerName(myName);
  }, [myName]);

  useEffect(() => {
    if (!id || !session) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('expense_requests')
        .select('*')
        .eq('id', id)
        .single();
      if (cancelled) return;
      if (error || !data) {
        setState('notfound');
        return;
      }
      const req = data as RequestRow;
      setRequest(req);

      // Submitter view: the submitter clicked their own PR row from the
      // dashboard. ApprovalPage was originally manager-only — without
      // this branch a draft PR would hit the !pending guard and render
      // 'Approved' (wrong), and a pending PR would hit the routed-to
      // check below and render 'Not your request' (also wrong, since
      // they ARE the submitter). Render a read-only summary instead.
      // Superadmins fall through to the manager flow so they can approve
      // PRs they routed to themselves (mirrors the backend escape hatch).
      if (req.submitted_by === session.user.id && !isSuperadmin) {
        setState('submitter');
        return;
      }

      if (req.status !== 'pending') {
        setDecided({ action: req.status === 'denied' ? 'denied' : 'approved', signer_name: '' });
        setState('decided');
        return;
      }

      const routedTo = (req.manager_email || '').toLowerCase();
      if (!routedTo || routedTo !== myEmail) {
        setState('forbidden');
        return;
      }
      if (req.submitted_by === session.user.id && !isSuperadmin) {
        setState('forbidden');
        return;
      }

      setState('ready');
    })();
    return () => { cancelled = true; };
  }, [id, session, myEmail]);

  const clearSig = useCallback(() => sigRef.current?.clear(), []);

  async function submit(decision: 'approve' | 'decline') {
    if (!id || !request) return;
    setErrorMessage('');
    if (!signerName.trim() || signerName.trim().length < 2) { setErrorMessage('Please type your full name.'); return; }
    if (!signerInitials.trim()) { setErrorMessage('Please type your initials.'); return; }
    if (decision === 'decline' && !declineReason.trim()) { setErrorMessage('Please explain why you are declining.'); return; }
    setSubmitting(decision);

    let signatureDataUrl: string | null = null;
    if (sigRef.current && !sigRef.current.isEmpty()) {
      try { signatureDataUrl = sigRef.current.getTrimmedCanvas().toDataURL('image/png'); }
      catch { signatureDataUrl = sigRef.current.toDataURL('image/png'); }
    }

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error('Your session expired. Please log in again.');

      const r = await fetch('/expense/api/expense-request-decide', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          requestId: id,
          action: decision,
          signer_name: signerName.trim(),
          signer_initials: signerInitials.trim(),
          signature_data_url: signatureDataUrl,
          decline_reason: decision === 'decline' ? declineReason.trim() : null,
        }),
      });

      // Read as text first so we can show non-JSON bodies (HTML, plain-text 502s)
      const bodyText = await r.text();
      let body: any = null;
      try { body = bodyText ? JSON.parse(bodyText) : null; } catch { /* leave body null */ }

      if (!r.ok) {
        if (body?.error) {
          setErrorMessage(body.error);
        } else {
          // Non-JSON failure — surface what we got so we can debug
          const snippet = bodyText
            ? `: ${bodyText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`
            : '';
          setErrorMessage(`Server returned ${r.status} ${r.statusText}${snippet}`);
        }
        setSubmitting('');
        return;
      }

      if (!body) {
        setErrorMessage('Server returned an empty response. Please try again.');
        setSubmitting('');
        return;
      }

      setDecided({ action: body.action, signer_name: signerName.trim() });
      setState('decided');
    } catch (e) {
      // Network / CORS / fetch-throw
      setErrorMessage(e instanceof Error ? `Network error: ${e.message}` : 'Submission failed');
      setSubmitting('');
    }
  }

  if (state === 'loading') {
    return (
      <div className="ap-wrap">
        <div className="ap-loading"><Loader2 className="spin" size={36} /><p>Loading request…</p></div>
      </div>
    );
  }

  if (state === 'notfound') {
    return (
      <div className="ap-wrap">
        <div className="ap-card ap-banner ap-banner-denied">
          <AlertTriangle size={36} />
          <h1>Request not found</h1>
          <p>This request doesn't exist or isn't visible to you.</p>
          <button className="ap-btn ap-btn-decline" onClick={() => navigate('/expense/queue')} style={{ marginTop: 20 }}>Back to queue</button>
        </div>
      </div>
    );
  }

  if (state === 'submitter' && request) {
    const statusLabel = (() => {
      switch (request.status) {
        case 'draft':            return { label: 'Draft — not yet submitted to your approver', tone: 'denied' as const };
        case 'pending':          return { label: 'Pending approval', tone: 'ready' as const };
        case 'approved':         return { label: 'Approved', tone: 'approved' as const };
        case 'denied':           return { label: 'Declined', tone: 'denied' as const };
        case 'awaiting_invoice': return { label: 'Approved — waiting for invoice', tone: 'approved' as const };
        case 'fulfilled':        return { label: 'Fulfilled', tone: 'approved' as const };
        case 'posted':           return { label: 'Posted to QBO', tone: 'approved' as const };
        default:                 return { label: request.status, tone: 'ready' as const };
      }
    })();
    const isPR = request.request_type === 'purchase_request';
    return (
      <div className="ap-wrap">
        <div className="ap-card">
          <div className="ap-header">
            <button type="button" onClick={() => navigate('/expense/')} style={{ background: 'transparent', border: 'none', color: 'var(--tx2)', cursor: 'pointer', padding: 0, marginRight: 4 }} aria-label="Back">
              <ArrowLeft size={20} />
            </button>
            <ClipboardList className="ap-header-icon" size={28} />
            <div>
              <h1>{isPR ? 'Purchase Request' : 'Expense'}</h1>
              <p className="ap-meta">
                Status: <strong>{statusLabel.label}</strong>
                {request.total_amount ? ` · ${formatCurrency(request.total_amount)}` : ''}
              </p>
            </div>
          </div>
          {request.manager_email && request.status === 'pending' && (
            <p className="ap-intro">
              Routed to <strong>{request.manager_email}</strong> for approval.
            </p>
          )}
          {request.status === 'draft' && (
            <div className="ap-warn">
              <AlertTriangle size={16} />
              <span>This {isPR ? 'purchase request' : 'expense'} hasn't been sent to your approver yet — notify likely failed during submit.</span>
            </div>
          )}
          {request.memo && (
            <div className="ap-note">
              <span className="ap-note-label">Memo</span>
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
              <thead><tr><th>Item</th><th className="r">Qty</th><th className="r">Price</th><th className="r">Line</th></tr></thead>
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
              <tfoot><tr><td colSpan={3} className="r">Total</td><td className="r ap-items-total">{request.total_amount ? formatCurrency(request.total_amount) : '—'}</td></tr></tfoot>
            </table>
          )}
          <button className="ap-btn ap-btn-approve" onClick={() => navigate('/expense/')} style={{ marginTop: 20 }}>Back to dashboard</button>
        </div>
        <p className="ap-footer">Viewing as {myName} (submitter)</p>
      </div>
    );
  }

  if (state === 'forbidden') {
    return (
      <div className="ap-wrap">
        <div className="ap-card ap-banner ap-banner-denied">
          <XCircle size={36} />
          <h1>Not your request</h1>
          <p>This purchase request is routed to {request?.manager_email || 'someone else'}.</p>
          <button className="ap-btn ap-btn-decline" onClick={() => navigate('/expense/queue')} style={{ marginTop: 20 }}>Back to queue</button>
        </div>
      </div>
    );
  }

  if (state === 'decided') {
    const approved = decided?.action === 'approved' || decided?.action === 'approve';
    return (
      <div className="ap-wrap">
        <div className={`ap-card ap-banner ${approved ? 'ap-banner-approved' : 'ap-banner-denied'}`}>
          {approved ? <CheckCircle size={36} /> : <XCircle size={36} />}
          <h1>{approved ? '✓ Request Approved' : '✗ Request Declined'}</h1>
          <p>{request?.vendor_name ? `${request.vendor_name} · ` : ''}{request?.total_amount ? formatCurrency(request.total_amount) : ''}</p>
          {decided?.signer_name && <p className="ap-banner-sub">Signed by <strong>{decided.signer_name}</strong></p>}
          <button className="ap-btn ap-btn-approve" onClick={() => navigate('/expense/queue')} style={{ marginTop: 20 }}>Back to queue</button>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="ap-wrap">
        <div className="ap-card ap-banner ap-banner-denied">
          <XCircle size={36} />
          <h1>Something went wrong</h1>
          <p>{errorMessage}</p>
        </div>
      </div>
    );
  }

  if (!request) return null;
  const isPR = request.request_type === 'purchase_request';

  return (
    <div className="ap-wrap">
      <div className="ap-card">
        <div className="ap-header">
          <button type="button" onClick={() => navigate('/expense/queue')} style={{ background: 'transparent', border: 'none', color: 'var(--tx2)', cursor: 'pointer', padding: 0, marginRight: 4 }} aria-label="Back">
            <ArrowLeft size={20} />
          </button>
          <ClipboardList className="ap-header-icon" size={28} />
          <div>
            <h1>{isPR ? 'Purchase Request Approval' : 'Expense Approval'}</h1>
            <p className="ap-meta">
              {request.submitter_name || 'A team member'}
              {request.total_amount ? ` · ${formatCurrency(request.total_amount)}` : ''}
            </p>
          </div>
        </div>

        <p className="ap-intro">
          <strong>{request.submitter_name || 'A team member'}</strong> submitted this {isPR ? 'purchase request' : 'expense'} and routed it to you for approval. Review the details below, then sign.
        </p>

        {isPR && (
          <div className="ap-warn">
            <ShoppingCart size={16} />
            <span><strong>Time-sensitive:</strong> Approve promptly to avoid procurement delays.</span>
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
              <th>Item</th><th className="r">Qty</th><th className="r">Price</th><th className="r">Line</th>
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

      <div className="ap-card">
        <div className="ap-section-title">Your signature</div>
        <p className="ap-helptext">
          Sign below with your mouse or finger. Your typed name and initials below are also legally valid as an electronic signature.
        </p>

        <div className="ap-sig-box">
          <SignatureCanvas
            ref={sigRef}
            penColor="#5BB5F0"
            canvasProps={{ className: 'ap-sig-canvas', style: { width: '100%', height: '180px' } }}
          />
          <button type="button" className="ap-sig-clear" onClick={clearSig}>
            <Eraser size={14} /> Clear
          </button>
        </div>

        <div className="ap-name-grid">
          <div className="ap-field">
            <label htmlFor="signerName">Full name <span className="ap-required">*</span></label>
            <input id="signerName" type="text" placeholder="Jane Doe" autoComplete="name" maxLength={200} value={signerName} onChange={(e) => setSignerName(e.target.value)} />
          </div>
          <div className="ap-field">
            <label htmlFor="signerInitials">Initials <span className="ap-required">*</span></label>
            <input id="signerInitials" type="text" placeholder="JD" maxLength={10} value={signerInitials} onChange={(e) => setSignerInitials(e.target.value)} />
          </div>
        </div>

        <div className="ap-date">Date of signature: <strong>{new Date().toLocaleString()}</strong></div>

        <div className="ap-actions">
          <button type="button" className="ap-btn ap-btn-decline" onClick={() => setDeclineMode(true)} disabled={!!submitting}>
            Decline
          </button>
          <button type="button" className="ap-btn ap-btn-approve" onClick={() => submit('approve')} disabled={!!submitting}>
            {submitting === 'approve' && <Loader2 className="spin" size={16} />}
            ✓ Approve
          </button>
        </div>

        {declineMode && (
          <div className="ap-decline-wrap">
            <label htmlFor="declineReason">Reason for declining <span className="ap-required">*</span></label>
            <textarea id="declineReason" placeholder="Please explain why you are declining…" rows={3} maxLength={2000} value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} />
            <button type="button" className="ap-btn ap-btn-decline" onClick={() => submit('decline')} disabled={!!submitting} style={{ marginTop: 10 }}>
              {submitting === 'decline' && <Loader2 className="spin" size={16} />}
              Submit decline
            </button>
          </div>
        )}

        {errorMessage && <div className="ap-error">{errorMessage}</div>}
      </div>

      <p className="ap-footer">Reviewing as {myName}</p>
    </div>
  );
}
