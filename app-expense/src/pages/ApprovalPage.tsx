import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
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
} from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ExpenseRequest } from '@/types/expense';
import SignatureCanvas from 'react-signature-canvas';

type PageState = 'loading' | 'ready' | 'decided' | 'expired' | 'error';

export default function ApprovalPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<PageState>('loading');
  const [request, setRequest] = useState<ExpenseRequest | null>(null);
  const [decision, setDecision] = useState<'approved' | 'denied' | null>(null);
  const [reasonNote, setReasonNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState('');
  const sigRef = useRef<SignatureCanvas | null>(null);

  // Load the request by magic token
  useEffect(() => {
    async function load() {
      if (!token) {
        setState('error');
        return;
      }

      try {
        // Call the Netlify function to validate and return the request
        const res = await fetch(
          `/.netlify/functions/expense-request-decide?token=${encodeURIComponent(token)}`
        );
        if (res.status === 410) {
          setState('expired');
          return;
        }
        if (!res.ok) {
          setState('error');
          return;
        }
        const data = await res.json();
        if (data.already_decided) {
          setResultMessage(
            `This request was already ${data.decision} on ${formatDate(data.decided_at)}.`
          );
          setState('decided');
          return;
        }
        setRequest(data.request as ExpenseRequest);
        setState('ready');
      } catch {
        setState('error');
      }
    }
    load();
  }, [token]);

  const clearSignature = useCallback(() => {
    sigRef.current?.clear();
  }, []);

  async function handleDecision(d: 'approved' | 'denied') {
    if (!token || !request) return;
    setSubmitting(true);
    setDecision(d);

    let signatureDataUrl: string | null = null;
    if (d === 'approved' && sigRef.current && !sigRef.current.isEmpty()) {
      signatureDataUrl = sigRef.current.getTrimmedCanvas().toDataURL('image/png');
    }

    try {
      const res = await fetch('/.netlify/functions/expense-request-decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          decision: d,
          reason_note: reasonNote || null,
          signature_data: signatureDataUrl,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to submit decision');
      }

      setResultMessage(
        d === 'approved'
          ? 'Request approved. The submitter has been notified.'
          : 'Request denied. The submitter has been notified.'
      );
      setState('decided');
    } catch (err) {
      setResultMessage(
        err instanceof Error ? err.message : 'Something went wrong.'
      );
      setState('error');
    } finally {
      setSubmitting(false);
    }
  }

  // LOADING
  if (state === 'loading') {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-gradient-to-b from-primary/5 to-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // EXPIRED
  if (state === 'expired') {
    return (
      <CenteredCard
        icon={<AlertTriangle className="h-8 w-8 text-amber-500" />}
        title="Link Expired"
        description="This approval link is no longer valid. Please ask the submitter to re-send the request."
      />
    );
  }

  // ERROR
  if (state === 'error') {
    return (
      <CenteredCard
        icon={<XCircle className="h-8 w-8 text-destructive" />}
        title="Something went wrong"
        description={resultMessage || 'Unable to load this approval request.'}
      />
    );
  }

  // DECIDED
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
        title={decision === 'denied' ? 'Request Denied' : 'Request Approved'}
        description={resultMessage}
      />
    );
  }

  // READY — show the request + approval form
  if (!request) return null;

  return (
    <div className="min-h-[100dvh] bg-gradient-to-b from-primary/5 to-background p-4">
      <div className="max-w-md mx-auto space-y-4">
        {/* Header */}
        <div className="text-center pt-4 pb-2">
          <ClipboardList className="h-8 w-8 text-primary mx-auto mb-2" />
          <h1 className="text-lg font-semibold">Approval Required</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review and sign to approve or deny this{' '}
            {request.type === 'purchase_request' ? 'purchase request' : 'expense'}.
          </p>
        </div>

        {/* Request summary */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{request.vendor_name || 'No vendor'}</CardTitle>
              <Badge variant="warning">
                {request.type === 'purchase_request' ? 'Purchase Request' : 'Expense'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Amount" value={request.total_amount ? formatCurrency(request.total_amount) : '—'} bold />
            <Row label="Category" value={request.cogs_account_label || '—'} />
            <Row label="Department" value={request.department || '—'} />
            <Row label="Tag" value={request.tag || '—'} />
            {request.customer_name && <Row label="Customer" value={request.customer_name} />}
            {request.job_number && <Row label="Job #" value={request.job_number} />}
            {request.memo && <Row label="Memo" value={request.memo} />}
            {request.receipt_date && <Row label="Date" value={formatDate(request.receipt_date)} />}

            {/* Line items */}
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

        {/* Signature pad */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Your Signature</CardTitle>
            <CardDescription>Sign below to approve this request.</CardDescription>
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

            {/* Optional denial reason */}
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

        {/* Action buttons */}
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
          Your decision, IP address, and signature are logged for audit.
        </p>
      </div>
    </div>
  );
}

/** Reusable detail row */
function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={bold ? 'font-semibold' : ''}>{value}</span>
    </div>
  );
}

/** Centered status card for terminal states */
function CenteredCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-gradient-to-b from-primary/5 to-background p-4">
      <Card className="w-full max-w-sm text-center">
        <CardContent className="pt-8 pb-6 space-y-3">
          <div className="mx-auto">{icon}</div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </CardContent>
      </Card>
    </div>
  );
}
