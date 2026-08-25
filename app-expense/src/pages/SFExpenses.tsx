import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { postToQuickBooks as postExpenseToQbo, DuplicateBillError } from '@/lib/postToQbo';
import { useSession } from '@/lib/hooks';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Archive, ArrowLeft, Banknote, Loader2, Send, Wrench } from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ExpenseRequest } from '@/types/expense';
import { PayBillPanel } from '@/components/PayBillPanel';
import { paymentsForExpenses, statusLabel, RAIL_LABEL, type VendorPayment } from '@/lib/vendorPay';

// Service Fusion expenses: ops.expense_requests rows tagged 'Service Fusion',
// landed by the sf-receipt-sync crawl when a job is invoiced. Each draft goes
// through OCR (sf-expense-ocr-background) against its attached receipt, which
// promotes a bill_number when found — but NOTHING here auto-posts to QBO
// (gate, Sky 2026-08-13: every expense requires a human to look at the actual
// bill before it becomes a real QuickBooks transaction). The flow is always
// two deliberate steps: open the card → review/attach/adjust → Submit (moves
// draft → approved, no QBO write) → "Post to QuickBooks" (the actual write).
// Staff-only (RLS ops.fn_is_staff()). Archive hides a row from every list
// without deleting it — the sync's dedup key survives, so an archived
// expense can never re-land. Once a bill is posted, QBO is the source of
// truth; edits happen there.
export default function SFExpenses() {
  const navigate = useNavigate();
  const { session } = useSession();
  const [requests, setRequests] = useState<ExpenseRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  // Payments (Phase 3): the Pay panel is superadmin-only — /api/vendor-pay
  // refuses anyone else, so the trigger stays hidden rather than 403-ing.
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  const [payments, setPayments] = useState<Map<string, VendorPayment>>(new Map());
  const [payingId, setPayingId] = useState<string | null>(null);

  const loadPayments = async (rows: ExpenseRequest[]) => {
    const ids = rows.filter((r) => r.status === 'posted' && r.qbo_bill_id).map((r) => r.id);
    try {
      setPayments(await paymentsForExpenses(ids));
    } catch { /* the list must render even if the ledger read fails */ }
  };

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const role =
        (data.user?.app_metadata as { role?: string } | undefined)?.role ||
        (data.user?.user_metadata as { role?: string } | undefined)?.role || '';
      setIsSuperadmin(role === 'superadmin');
    });
  }, []);

  useEffect(() => {
    async function load() {
      if (!session) return;
      const { data } = await supabase
        .from('expense_requests')
        .select('*')
        .eq('tag', 'Service Fusion')
        .is('archived_at', null)
        .order('created_at', { ascending: false });
      const rows = (data as ExpenseRequest[]) ?? [];
      setRequests(rows);
      setLoading(false);
      loadPayments(rows);
    }
    load();
  }, [session]);

  const archiveRow = async (req: ExpenseRequest) => {
    if (!session) return;
    if (!window.confirm(`Archive this ${req.status === 'posted' ? 'posted' : 'draft'} expense (${req.vendor_name || 'no vendor'})? It stays on record${req.qbo_bill_id ? ' — the QBO bill is untouched' : ''}, just leaves this list.`)) return;
    setArchiving(req.id);
    const { error } = await supabase
      .from('expense_requests')
      .update({
        archived_at: new Date().toISOString(),
        archived_by: session.user.email ?? session.user.id,
      })
      .eq('id', req.id);
    setArchiving(null);
    if (!error) setRequests((prev) => prev.filter((r) => r.id !== req.id));
  };

  // Submit (draft -> approved) never touches QBO now — that's a separate,
  // explicit "Post to QuickBooks" click, right here, once a human's looked
  // at it (either just now via Submit, or earlier — either way it sits as
  // 'approved' until someone posts it).
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

  const total = requests.reduce((sum, r) => sum + (r.total_amount ?? 0), 0);

  function draftBadge(req: ExpenseRequest): { label: string; variant: 'success' | 'secondary' | 'warning' } {
    if (req.status === 'posted') return { label: 'Posted', variant: 'success' };
    if (req.status === 'approved') return { label: 'Approved — ready to post', variant: 'secondary' };
    if (req.ocr_status === 'no_attachment') return { label: 'Needs review — no receipt', variant: 'warning' };
    if (req.ocr_status === 'failed') return { label: 'Needs review — OCR failed', variant: 'warning' };
    if (req.ocr_status === 'processed' && !req.bill_number) return { label: 'Needs review — no bill #', variant: 'warning' };
    if (req.ocr_status === 'processed' && req.bill_number) return { label: 'Ready to submit', variant: 'secondary' };
    return { label: 'Draft — pending OCR', variant: 'secondary' };
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="page-title">SF Expenses</h1>
          <p className="page-description">
            Service Fusion job expenses — landed in Brixpense when the job is invoiced.
          </p>
        </div>
        {!loading && requests.length > 0 && (
          <div className="text-right">
            <div className="text-[15px] font-bold tabular-nums">{formatCurrency(total)}</div>
            <div className="text-[11px] text-muted-foreground">{requests.length} expense{requests.length === 1 ? '' : 's'}</div>
          </div>
        )}
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
            <Wrench className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No Service Fusion expenses yet.
            </p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              They appear here once a SF job is billed and invoiced.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {requests.map((req) => (
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
                    <Badge variant={draftBadge(req).variant}>
                      {draftBadge(req).label}
                    </Badge>
                  </div>
                  <p className="text-[13px] text-muted-foreground mt-1 truncate">
                    {req.customer_name || 'No customer'}
                    {req.job_number ? (
                      <>
                        {' · '}
                        {req.sf_admin_job_id ? (
                          <a
                            href={`https://admin.servicefusion.com/jobs/jobView?id=${req.sf_admin_job_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-primary hover:underline font-medium"
                            title="Open this job in Service Fusion (must be logged in)"
                          >
                            SF #{req.job_number} ↗
                          </a>
                        ) : (
                          `SF #${req.job_number}`
                        )}
                      </>
                    ) : ''}
                    {req.posted_at ? ` · ${formatDate(req.posted_at)}` : (req.created_at ? ` · ${formatDate(req.created_at)}` : '')}
                  </p>
                  {req.status === 'approved' && req.autopost_error && (
                    <p className="text-[12px] text-amber-500 mt-1 truncate" title={req.autopost_error}>
                      ⚠ Last post attempt failed: {req.autopost_error}
                    </p>
                  )}
                </div>
                <span className="text-[15px] font-bold tabular-nums shrink-0">
                  {req.total_amount ? formatCurrency(req.total_amount) : '—'}
                </span>
                {/* Payment state (Phase 3) — a paid bill can't be paid twice by eye. */}
                {req.status === 'posted' && payments.get(req.id) && (
                  <Badge variant={statusLabel(payments.get(req.id)!).variant}>
                    {statusLabel(payments.get(req.id)!).label}
                    {` · ${RAIL_LABEL[payments.get(req.id)!.rail].split(' (')[0]}`}
                  </Badge>
                )}
                {isSuperadmin && req.status === 'posted' && req.qbo_bill_id && !payments.get(req.id) && (
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
                {req.status === 'approved' && (
                  <Button
                    size="sm"
                    disabled={postingId === req.id}
                    onClick={(e) => { e.stopPropagation(); postToQuickBooks(req); }}
                    title="Review complete — send this to QuickBooks"
                  >
                    {postingId === req.id
                      ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      : <Send className="h-4 w-4 mr-1" />}
                    Post to QuickBooks
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  title="Archive — hide from this list (kept on record; posted bills stay in QBO)"
                  disabled={archiving === req.id}
                  onClick={(e) => { e.stopPropagation(); archiveRow(req); }}
                >
                  {archiving === req.id
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Archive className="h-4 w-4" />}
                </Button>
              </CardContent>
            </Card>
            {payingId === req.id && (
              <PayBillPanel
                expenseId={req.id}
                onClose={() => setPayingId(null)}
                onPaid={() => loadPayments(requests)}
              />
            )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
