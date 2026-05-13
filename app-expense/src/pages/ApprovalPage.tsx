import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase, getAccessToken } from '@/lib/supabase';
import { useSession } from '@/lib/hooks';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  ClipboardList,
  CheckCircle,
  XCircle,
  Loader2,
  AlertTriangle,
  Eraser,
  ArrowLeft,
} from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ExpenseRequest } from '@/types/expense';
import SignatureCanvas from 'react-signature-canvas';

type PageState = 'loading' | 'ready' | 'decided' | 'notfound' | 'error' | 'forbidden';

export default function ApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { session } = useSession();

  const [state, setState] = useState<PageState>('loading');
  const [request, setRequest] = useState<ExpenseRequest | null>(null);
  const [decision, setDecision] = useState<'approved' | 'denied' | null>(null);
  const [reasonNote, setReasonNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const sigRef = useRef<SignatureCanvas | null>(null);

  const myEmail = (session?.user?.email || '').toLowerCase();
  const myDisplayName = (session?.user?.user_metadata as { full_name?: string } | undefined)?.full_name
    || session?.user?.email
    || '';

  // Load the request by id (RLS gates to submitter + matched manager_email)
  useEffect(() => {
    async function load() {
      if (!id) {
        setState('notfound');
        return;
      }
      const { data, error } = await supabase
        .from('expense_requests')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !data) {
        setState('notfound');
        return;
      }

      const req = data as ExpenseRequest;
      setRequest(req);

      if (req.status !== 'pending') {
        setResultMessage(`This request is "${req.status}" and can no longer be acted on.`);
        setState('decided');
        return;
      }

      const routedTo = (req.manager_email || '').toLowerCase();
      if (!routedTo || routedTo !== myEmail) {
        setState('forbidden');
        return;
      }
      if (req.submitted_by === session?.user?.id) {
        setState('forbidden');
        setResultMessage('You cannot approve your own request.');
        return;
      }

      setState('ready');
    }
    if (session) load();
  }, [id, session, myEmail]);

  const clearSignature = useCallback(() => {
    sigRef.current?.clear();
  }, []);

  async function handleDecision(d: 'approved' | 'denied') {
    if (!id || !request) return;
    setSubmitting(true);
    setDecision(d);

    let signatureDataUrl: string | null = null;
    if (d === 'approved' && sigRef.current && !sigRef.current.isEmpty()) {
      signatureDataUrl = sigRef.current.getTrimmedCanvas().toDataURL('image/png');
    }

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error('Your session expired. Please log in again.');

      const res = await fetch('/api/expense-request-decide', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          requestId: id,
          action: d,
          notes: reasonNote || null,
          signatureUrl: signatureDataUrl,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Failed (${res.status})`);
      }

      setResultMessage(
        d === 'approved'
          ? 'Approved. The submitter will see the status update next time they refresh.'
          : 'Denied. The submitter will see the status update next time they refresh.'
      );
      setState('decided');
    } catch (e) {
      setResultMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setState('error');
    } finally {
      setSubmitting(false);
    }
  }

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (state === 'notfound') {
    return (
      <CenteredCard
        icon={<AlertTriangle className="h-8 w-8 text-amber-500" />}
        title="Request not found"
        description="This request doesn't exist or isn't visible to you."
        onBack={() => navigate('/expense/queue')}
      />
    );
  }

  if (state === 'forbidden') {
    return (
      <CenteredCard
        icon={<XCircle className="h-8 w-8 text-destructive" />}
        title="Not your request"
        description={resultMessage || `This purchase request is routed to ${request?.manager_email || 'someone else'}.`}
        onBack={() => navigate('/expense/queue')}
      />
    );
  }

  if (state === 'error') {
    return (
      <CenteredCard
        icon={<XCircle className="h-8 w-8 text-destructive" />}
        title="Something went wrong"
        description={resultMessage}
        onBack={() => navigate('/expense/queue')}
      />
    );
  }

  if (state === 'decided') {
    return (
      <CenteredCard
        icon={
          decision === 'denied' ? (
            <XCircle className="h-8 w-8 text-destructive" />
          ) : (
            <CheckCircle className="h-8 w-8 text-emerald-500" />
          )
        }
        title={
          decision === 'denied' ? 'Request Denied'
            : decision === 'approved' ? 'Request Approved'
            : 'Already Decided'
        }
        description={resultMessage}
        onBack={() => navigate('/expense/queue')}
      />
    );
  }

  if (!request) return null;

  return (
    <div className="space-y-4 max-w-md mx-auto">
      <div className="flex items-center gap-3 pt-2">
        <Button variant="ghost" size="icon" onClick={() => navigate('/expense/queue')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-primary" />
            Approve Request
          </h1>
          <p className="text-xs text-muted-foreground">
            Reviewing as {myDisplayName}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{request.vendor_name || 'No vendor'}</CardTitle>
            <Badge variant="warning">
              {request.request_type === 'purchase_request' ? 'Purchase Request' : 'Expense'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Amount" value={request.total_amount ? formatCurrency(request.total_amount) : '—'} bold />
          <Row label="Submitter" value={request.submitter_name || request.submitter_email || '—'} />
          <Row label="Category" value={request.cogs_account_label || '—'} />
          <Row label="Department" value={request.department || '—'} />
          <Row label="Tag" value={request.tag || '—'} />
          {request.customer_name && <Row label="Customer" value={request.customer_name} />}
          {request.job_number && <Row label="Job #" value={request.job_number} />}
          {request.memo && <Row label="Memo" value={request.memo} />}
          {request.receipt_date && <Row label="Date" value={formatDate(request.receipt_date)} />}

          {request.line_items && request.line_items.length > 0 && (
            <div className="pt-2 border-t">
              <p className="font-medium mb-1">Line Items</p>
              {request.line_items.map((li, i) => (
                <div key={i} className="flex justify-between text-xs text-muted-foreground">
                  <span className="truncate flex-1">{li.description}</span>
                  <span className="tabular-nums ml-2">
                    {li.qty} × {formatCurrency(li.unit_price)} = {formatCurrency(li.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Sign to Approve</CardTitle>
          <CardDescription>Required for approvals; optional for denials.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <SignatureCanvas
              ref={sigRef}
              penColor="#1F4E79"
              canvasProps={{
                className: 'sig-canvas w-full',
                height: 150,
                style: { width: '100%', height: '150px' },
              }}
            />
            <button
              type="button"
              onClick={clearSignature}
              className="absolute top-2 right-2 p-1 rounded bg-white/80 hover:bg-white text-muted-foreground"
            >
              <Eraser className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reason">Note (optional, required for denial)</Label>
            <Textarea
              id="reason"
              placeholder="Reason for approval or denial..."
              value={reasonNote}
              onChange={(e) => setReasonNote(e.target.value)}
              rows={2}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="destructive"
          size="lg"
          onClick={() => handleDecision('denied')}
          disabled={submitting}
        >
          {submitting && decision === 'denied' && (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
          <XCircle className="h-4 w-4" />
          Deny
        </Button>
        <Button
          variant="success"
          size="lg"
          onClick={() => handleDecision('approved')}
          disabled={submitting}
        >
          {submitting && decision === 'approved' && (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
          <CheckCircle className="h-4 w-4" />
          Approve
        </Button>
      </div>

      <p className="text-xs text-center text-muted-foreground pb-4">
        Your decision, IP, and signature are logged for audit.
      </p>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={bold ? 'font-semibold' : ''}>{value}</span>
    </div>
  );
}

function CenteredCard({
  icon,
  title,
  description,
  onBack,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onBack?: () => void;
}) {
  return (
    <div className="flex items-center justify-center py-12">
      <Card className="w-full max-w-sm text-center">
        <CardContent className="pt-8 pb-6 space-y-3">
          <div className="mx-auto">{icon}</div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
          {onBack && (
            <Button variant="outline" size="sm" onClick={onBack}>
              Back to queue
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
