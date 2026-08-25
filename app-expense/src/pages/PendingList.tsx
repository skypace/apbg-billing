import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { postToQuickBooks as postExpenseToQbo, DuplicateBillError } from '@/lib/postToQbo';
import { useSession } from '@/lib/hooks';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DueBadge, DuplicateBadge } from '@/components/BillFlags';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Loader2, Clock, Receipt, Send, Banknote } from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useIsSuperadmin } from '@/lib/useIsSuperadmin';
// `statusLabel` is aliased — this page already has its own for expense status.
import { paymentsForExpenses, statusLabel as paymentStatusLabel, RAIL_LABEL, type VendorPayment } from '@/lib/vendorPay';
import { PayBillPanel } from '@/components/PayBillPanel';
import type { ExpenseRequest } from '@/types/expense';

export default function PendingList() {
  const navigate = useNavigate();
  const { session } = useSession();
  const [requests, setRequests] = useState<ExpenseRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  // Paying a posted bill. Superadmin-only — /api/vendor-pay refuses everyone
  // else, so the trigger stays hidden rather than 403-ing.
  const isSuperadmin = useIsSuperadmin();
  const [payments, setPayments] = useState<Map<string, VendorPayment>>(new Map());
  const [payingId, setPayingId] = useState<string | null>(null);

  // Which of these already have a payment against them, so a bill can't be
  // paid twice by eye.
  const loadPayments = async (rows: ExpenseRequest[]) => {
    const ids = rows.filter((r) => r.status === 'posted' && r.qbo_bill_id).map((r) => r.id);
    try {
      setPayments(await paymentsForExpenses(ids));
    } catch { /* the list must render even if the ledger read fails */ }
  };

  useEffect(() => {
    async function load() {
      if (!session) return;
      const { data } = await supabase
        .from('expense_requests')
        .select('*')
        .eq('submitted_by', session.user.id)
        .order('created_at', { ascending: false });
      const rows = (data as ExpenseRequest[]) ?? [];
      setRequests(rows);
      setLoading(false);
      await loadPayments(rows);
    }
    load();
  }, [session]);


  // Expenses only auto-approve now — nothing reaches QuickBooks until someone
  // explicitly posts it here. This IS the "pay attention to the bill" gate:
  // one deliberate click, separate from Submit, per expense.
  const postToQuickBooks = async (req: ExpenseRequest) => {
    setPostingId(req.id);
    setPostError(null);
    try {
      const data = await postExpenseToQbo(req.id);
      setRequests((prev) => prev.map((r) => (r.id === req.id ? { ...r, status: 'posted', qbo_bill_id: (data.qbo_bill_id || data.qbo_purchase_id) as string, autopost_error: null } : r)));
    } catch (e) {
      // Declining the duplicate prompt is a decision, not a failure — leave the
      // row exactly as it was rather than stamping it with an error.
      if (e instanceof DuplicateBillError) return;
      const reason = e instanceof Error ? e.message : 'Could not reach the server.';
      setPostError(reason);
      setRequests((prev) => prev.map((r) => (r.id === req.id ? { ...r, autopost_error: reason } : r)));
    } finally {
      setPostingId(null);
    }
  };

  const statusVariant: Record<string, 'default' | 'success' | 'warning' | 'destructive' | 'info' | 'secondary'> = {
    draft: 'secondary',
    pending: 'warning',
    approved: 'success',
    denied: 'destructive',
    awaiting_invoice: 'info',
    fulfilled: 'info',
    posted: 'success',
  };

  const statusLabel: Record<string, string> = {
    draft: 'Draft',
    pending: 'Pending',
    approved: 'Approved',
    denied: 'Denied',
    awaiting_invoice: 'Awaiting Invoice',
    fulfilled: 'Fulfilled',
    posted: 'Posted',
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="page-title">Expense History</h1>
      </div>

      {postError && (
        <div className="text-sm rounded-lg p-3 border border-destructive/40 bg-destructive/10 text-destructive">
          {postError}
        </div>
      )}

      {loading ? (
        <div className="feedback-state">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="feedback-state">
            <Clock className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No submissions yet.
            </p>
            <Button className="mt-4" onClick={() => navigate('')}>
              Submit Something
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {requests.map((req) => {
            // PRs in 'awaiting_invoice' status are approved-and-ready-to-be-fulfilled.
            // The "Log Receipt" CTA below opens ExpenseForm pre-filled from this PR
            // so the submitter doesn't have to re-type vendor/amount/accounts after
            // they actually buy the thing. Receipt + payment account close the loop.
            const isReadyForReceipt =
              req.request_type === 'purchase_request' && req.status === 'awaiting_invoice';
            // Auto-approve no longer posts to QBO — every 'approved' expense
            // sits here until someone deliberately posts it.
            const isReadyToPost =
              req.request_type === 'expense' && req.status === 'approved' && !req.qbo_bill_id;
            // A QuickBooks BillPayment needs a Bill to attach to, so pay is
            // only offered once the bill is actually posted — and only while
            // no payment already covers it.
            const pay = payments.get(req.id);
            const isPayable =
              isSuperadmin && req.status === 'posted' && !!req.qbo_bill_id && !pay && !req.paid_at;
            return (
              <div key={req.id} className="space-y-2">
              <Card
                className="cursor-pointer hover:shadow-sm transition-shadow"
                onClick={() => navigate(`/edit/${req.id}`)}
              >
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[15px] font-semibold truncate">
                        {req.vendor_name || 'No vendor'}
                      </p>
                      <Badge variant={statusVariant[req.status] ?? 'secondary'}>
                        {statusLabel[req.status] ?? req.status}
                      </Badge>
                      <DueBadge request={req} />
                      <DuplicateBadge request={req} />
                      {pay && (
                        <Badge variant={paymentStatusLabel(pay).variant}>
                          {paymentStatusLabel(pay).label} · {RAIL_LABEL[pay.rail].split(' (')[0]}
                        </Badge>
                      )}
                    </div>
                    <p className="text-[13px] text-muted-foreground mt-1">
                      {req.request_type === 'purchase_request' ? 'PR' : 'Expense'}
                      {req.receipt_date ? ` · ${formatDate(req.receipt_date)}` : ''}
                      {req.cogs_account_label ? ` · ${req.cogs_account_label}` : ''}
                    </p>
                    {req.duplicate_of && !req.duplicate_cleared_by && req.duplicate_reason && (
                      <p className="text-[12px] text-amber-400 mt-1 truncate" title={req.duplicate_reason}>
                        ⚠ Possible duplicate — {req.duplicate_reason}
                      </p>
                    )}
                    {req.status === 'approved' && req.autopost_error && (
                      <p className="text-[12px] text-amber-500 mt-1 truncate" title={req.autopost_error}>
                        ⚠ Last post attempt failed: {req.autopost_error}
                      </p>
                    )}
                  </div>
                  <span className="text-[15px] font-bold tabular-nums shrink-0">
                    {req.total_amount ? formatCurrency(req.total_amount) : '—'}
                  </span>
                  {isReadyForReceipt && (
                    <Button
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/new?fromPR=${req.id}`);
                      }}
                      title="Log the receipt for this approved purchase"
                    >
                      <Receipt className="h-4 w-4 mr-1" />
                      Log Receipt
                    </Button>
                  )}
                  {isReadyToPost && (
                    <Button
                      size="sm"
                      disabled={postingId === req.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        postToQuickBooks(req);
                      }}
                      title="Review complete — send this to QuickBooks"
                    >
                      {postingId === req.id
                        ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        : <Send className="h-4 w-4 mr-1" />}
                      Post to QuickBooks
                    </Button>
                  )}
                  {isPayable && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => { e.stopPropagation(); setPayingId(payingId === req.id ? null : req.id); }}
                      title="Pay this bill — bank transfer, or record a payment you already sent"
                    >
                      <Banknote className="h-4 w-4 mr-1" />
                      Pay
                    </Button>
                  )}
                </CardContent>
              </Card>
              {payingId === req.id && (
                <PayBillPanel
                  expenseId={req.id}
                  onClose={() => setPayingId(null)}
                  onPaid={() => { setPayingId(null); void loadPayments(requests); }}
                />
              )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
