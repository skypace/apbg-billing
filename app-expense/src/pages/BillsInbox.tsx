import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAccessToken, supabase } from '@/lib/supabase';
import { PayBillPanel } from '@/components/PayBillPanel';
import { paymentsForExpenses, RAIL_LABEL, type VendorPayment } from '@/lib/vendorPay';
import { useSession } from '@/lib/hooks';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, Inbox, Loader2,
  Banknote, Mail, RefreshCw, Send, Settings2, UserPlus, X,
} from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';

// Vendor Inbox — the master inbox for bills emailed to bills@alamedapointbg.com.
//
// Open to EVERYONE in Brixpense (ops.fn_has_brixpense), not just staff:
// unassigned vendor mail is everybody's problem, and a pile only two people
// can see is how it stops being worked. Your OWN bills live in My Inbox.
//
// Each row is ONE inbound email. The pipeline (bill-email-intake →
// bill-email-process-background) OCRs the attachment and lands an unpaid bill
// DRAFT tagged "AP Inbox". Nothing reaches QuickBooks until someone clicks
// "Post to QuickBooks" here or on the bill itself — the same human gate every
// other expense goes through (Sky, 2026-08-14), and the reason it is safe for
// this address to accept mail from vendors directly.
//
// Emails that failed are rows too, with the literal reason. "No attachment"
// and "we couldn't read the attachment" are deliberately different statuses:
// they have completely different fixes, and showing them the same way is how
// a credential problem hides as a vendor problem.

type IntakeStatus =
  | 'received' | 'processing' | 'drafted' | 'no_attachment'
  | 'attachment_fetch_failed' | 'ocr_failed' | 'sender_rejected' | 'ignored' | 'failed';

interface LinkedRequest {
  id: string;
  vendor_name: string | null;
  bill_number: string | null;
  total_amount: number | null;
  receipt_date: string | null;
  status: string;
  posted: boolean;
  qbo_bill_id: string | null;
  post_error: string | null;
  archived: boolean;
  owner_email: string | null;
  approved_by: string | null;
  approved_at: string | null;
  awaiting_approval: boolean;
  unassigned: boolean;
  can_post: boolean;
}

interface IntakeItem {
  id: string;
  received_at: string;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  status: IntakeStatus;
  status_detail: string | null;
  diagnostics: string | null;
  attachment_count: number;
  file_name: string | null;
  file_url: string | null;
  reprocess_count: number;
  request: LinkedRequest | null;
  ocr_preview: { vendor?: string; total?: number; bill_number?: string; date?: string } | null;
}

interface InboxSettings {
  enabled: boolean;
  inbox: string;
  notify: string[];
  allow_senders: string[];
  block_senders: string[];
  ack_sender: boolean;
  require_approval: boolean;
  default_approver: string | null;
  sender_routes: Record<string, string>;
}

interface SetupCheck {
  armed: boolean;
  blockers: string[];
  caveat: string;
}

const NEEDS_ATTENTION: IntakeStatus[] = [
  'no_attachment', 'attachment_fetch_failed', 'ocr_failed', 'failed', 'sender_rejected',
];

type Filter = 'mine' | 'approval' | 'ready' | 'unassigned' | 'attention' | 'posted' | 'unpaid' | 'all';

async function api(body?: unknown) {
  const token = await getAccessToken();
  const res = await fetch('/expense/api/bills-inbox', {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function statusBadge(item: IntakeItem): { label: string; variant: 'success' | 'secondary' | 'warning' | 'destructive' | 'info' } {
  if (item.request?.posted) return { label: 'Posted to QuickBooks', variant: 'success' };
  if (item.request?.unassigned) return { label: 'Needs assigning', variant: 'warning' };
  if (item.request?.awaiting_approval) return { label: 'Awaiting approval', variant: 'info' };
  if (item.request?.can_post) return { label: 'Approved — ready to post', variant: 'secondary' };
  switch (item.status) {
    case 'drafted': return { label: 'Ready to review', variant: 'info' };
    case 'received':
    case 'processing': return { label: 'Reading the bill…', variant: 'secondary' };
    case 'no_attachment': return { label: 'No invoice attached', variant: 'warning' };
    case 'attachment_fetch_failed': return { label: "Couldn't read the attachment", variant: 'destructive' };
    case 'ocr_failed': return { label: 'OCR failed', variant: 'warning' };
    case 'sender_rejected': return { label: 'Sender blocked', variant: 'secondary' };
    case 'ignored': return { label: 'Dismissed', variant: 'secondary' };
    default: return { label: 'Failed', variant: 'destructive' };
  }
}

export default function BillsInbox() {
  const navigate = useNavigate();
  const { session } = useSession();
  const [items, setItems] = useState<IntakeItem[]>([]);
  const [settings, setSettings] = useState<InboxSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('ready');
  const [me, setMe] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<SetupCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [showDiag, setShowDiag] = useState<string | null>(null);
  // Paying a posted bill (Vendor Portal Phase 3). Superadmin-only —
  // /api/vendor-pay refuses everyone else, so the trigger is hidden rather
  // than left to 403.
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  const [payments, setPayments] = useState<Map<string, VendorPayment>>(new Map());
  const [payingId, setPayingId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const role =
        (data.user?.app_metadata as { role?: string } | undefined)?.role ||
        (data.user?.user_metadata as { role?: string } | undefined)?.role || '';
      setIsSuperadmin(role === 'superadmin');
    });
  }, []);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const data = await api();
      const rows: IntakeItem[] = data.items ?? [];
      setItems(rows);
      setSettings(data.settings ?? null);
      setMe(data.me ?? null);
      setError(null);
      const paid = rows.map((i) => i.request).filter((r): r is LinkedRequest => !!r?.posted).map((r) => r.id);
      try { setPayments(await paymentsForExpenses(paid)); }
      catch { /* the queue must render even if the payment ledger read fails */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the AP inbox.');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  // With the approval gate on, the useful landing view is what is waiting on
  // you; with it off there is no such thing, so it is what is ready to post.
  useEffect(() => {
    if (settings?.require_approval) setFilter((f) => (f === 'ready' ? 'mine' : f));
  }, [settings?.require_approval]);

  // Rows land seconds after an email arrives, so a slow poll keeps the queue
  // honest while someone is watching it. Only while something is mid-flight.
  useEffect(() => {
    const pending = items.some((i) => i.status === 'received' || i.status === 'processing');
    if (!pending) return;
    const t = setInterval(() => { void load(); }, 8000);
    return () => clearInterval(t);
  }, [items, load]);

  const runCheck = async () => {
    setChecking(true);
    try { setCheck((await api({ action: 'check' })).check); }
    catch (e) { setError(e instanceof Error ? e.message : 'Check failed.'); }
    finally { setChecking(false); }
  };

  const reprocess = async (id: string) => {
    setBusy(id);
    try { await api({ action: 'reprocess', intake_id: id }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not re-run that email.'); }
    finally { setBusy(null); }
  };

  const dismiss = async (item: IntakeItem) => {
    if (!window.confirm(`Dismiss this email from ${item.from_email || 'unknown sender'}? It stays on record and can't come back in.`)) return;
    setBusy(item.id);
    try { await api({ action: 'dismiss', intake_id: item.id }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not dismiss.'); }
    finally { setBusy(null); }
  };

  const approve = async (item: IntakeItem) => {
    if (!item.request) return;
    setBusy(item.id);
    setError(null);
    try { await api({ action: 'approve', request_id: item.request.id }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not approve.'); }
    finally { setBusy(null); }
  };

  const assign = async (item: IntakeItem) => {
    if (!item.request) return;
    const to = window.prompt(
      'Who should approve this bill? Enter their Brixpense email address.',
      settings?.default_approver ?? '',
    );
    if (!to || !to.includes('@')) return;
    setBusy(item.id);
    setError(null);
    try { await api({ action: 'assign', request_id: item.request.id, approver_email: to.trim() }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not assign.'); }
    finally { setBusy(null); }
  };

  const postToQuickBooks = async (item: IntakeItem) => {
    if (!item.request) return;
    setBusy(item.id);
    setError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch('/expense/api/expense-request-link-bill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ requestId: item.request.id, mode: 'create' }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.message || data.error || 'Could not post to QuickBooks.');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post to QuickBooks.');
    } finally {
      setBusy(null);
    }
  };

  const isMine = (i: IntakeItem) =>
    !!i.request?.awaiting_approval &&
    !!me &&
    (i.request?.owner_email ?? '').toLowerCase() === me.toLowerCase();

  const match = (i: IntakeItem, f: Filter) => {
    switch (f) {
      case 'all': return true;
      case 'mine': return isMine(i);
      case 'approval': return !!i.request?.awaiting_approval;
      case 'ready': return !!i.request?.can_post;
      case 'unassigned': return !!i.request?.unassigned;
      case 'attention': return NEEDS_ATTENTION.includes(i.status);
      case 'posted': return !!i.request?.posted;
      // Posted to QuickBooks but no payment recorded yet — the pay-run list.
      case 'unpaid': return !!i.request?.posted && !payments.get(i.request.id);
      default: return true;
    }
  };

  const visible = items.filter((i) => match(i, filter));
  const countOf = (f: Filter) => items.filter((i) => match(i, f)).length;
  const counts = {
    mine: countOf('mine'),
    approval: countOf('approval'),
    ready: countOf('ready'),
    unassigned: countOf('unassigned'),
    attention: countOf('attention'),
    posted: countOf('posted'),
    unpaid: countOf('unpaid'),
    all: items.length,
  };
  const openRows = items.filter((i) => i.request && !i.request.posted && !i.request.archived);
  const dueTotal = openRows.reduce((s, i) => s + (i.request?.total_amount ?? 0), 0);
  const openCount = openRows.length;

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold tracking-tight">Vendor Inbox</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Bills emailed to{' '}
            <span className="font-mono">{settings?.inbox ?? 'bills@alamedapointbg.com'}</span>
            {' '}— read, coded, and queued for a human to post.
          </p>
        </div>
        {openCount > 0 && (
          <div className="text-right">
            <div className="text-[15px] font-bold tabular-nums">{formatCurrency(dueTotal)}</div>
            <div className="text-[11px] text-muted-foreground">{openCount} open</div>
          </div>
        )}
      </div>

      {settings && !settings.enabled && (
        <Card className="border-amber-500/40">
          <CardContent className="p-3 text-sm flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 flex-shrink-0" />
            <span>The AP inbox is switched off — emails to that address are recorded but not processed.</span>
          </CardContent>
        </Card>
      )}

      {/* Forwarding hint + the honest setup check */}
      <Card>
        <CardContent className="p-4 space-y-3 text-sm">
          <div className="flex items-start gap-3">
            <Mail className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <div className="font-medium text-foreground mb-1">Send bills here</div>
              <p className="text-muted-foreground">
                Forward a vendor invoice — or have the vendor email it directly — to{' '}
                <span className="font-mono text-foreground">{settings?.inbox ?? 'bills@alamedapointbg.com'}</span>.
                The PDF is read automatically and lands below as a draft bill.
                <strong className="text-foreground"> It lands with whoever it belongs to, ready to post — but nothing reaches QuickBooks until a human clicks Post.</strong>
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={runCheck} disabled={checking}>
              {checking ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Settings2 className="h-4 w-4 mr-1.5" />}
              Check the intake
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4 mr-1.5" /> Refresh
            </Button>
          </div>
          {check && (
            <div className={`rounded-lg p-3 text-[13px] ${check.armed ? 'bg-emerald-500/10 text-emerald-200' : 'bg-amber-500/10 text-amber-100'}`}>
              <div className="font-medium mb-1">
                {check.armed ? 'Armed — the pieces are in place.' : 'Not ready yet:'}
              </div>
              {check.blockers.length > 0 && (
                <ul className="list-disc list-inside space-y-1">
                  {check.blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
              )}
              <div className="mt-2 opacity-70">{check.caveat}</div>
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <Card className="border-red-500/40">
          <CardContent className="p-3 text-sm text-red-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-1.5">
        {(([
          // The approval views only exist when the gate is switched on;
          // showing two permanently-empty pills would just read as broken.
          ...(settings?.require_approval
            ? [['mine', `Waiting on you (${counts.mine})`],
               ['approval', `Awaiting approval (${counts.approval})`]] as [Filter, string][]
            : []),
          ['ready', `Ready to post (${counts.ready})`],
          ['unassigned', `Unassigned (${counts.unassigned})`],
          ['attention', `Needs attention (${counts.attention})`],
          ['posted', `Posted (${counts.posted})`],
          ['unpaid', `Awaiting payment (${counts.unpaid})`],
          ['all', `Everything (${counts.all})`],
        ] as [Filter, string][])).map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={filter === key ? 'default' : 'outline'}
            onClick={() => setFilter(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading the inbox…
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            <Inbox className="h-8 w-8 mx-auto mb-3 opacity-40" />
            {filter === 'mine' || filter === 'ready'
              ? 'Nothing waiting. Forward a bill to the address above and it will show up here.'
              : 'Nothing in this view.'}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {visible.map((item) => {
            const badge = statusBadge(item);
            const r = item.request;
            const mine = isMine(item);
            const vendor = r?.vendor_name || item.ocr_preview?.vendor || item.from_name || item.from_email || 'Unknown sender';
            const amount = r?.total_amount ?? item.ocr_preview?.total ?? null;
            return (
              <Card key={item.id}>
                <CardContent className="p-4 space-y-2.5">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold truncate">{vendor}</span>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        {item.reprocess_count > 0 && (
                          <span className="text-[11px] text-muted-foreground">re-run ×{item.reprocess_count}</span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                        {item.subject && <div className="truncate">{item.subject}</div>}
                        <div className="truncate">
                          From {item.from_email || 'unknown'} · {formatDate(item.received_at)}
                          {(r?.bill_number || item.ocr_preview?.bill_number) &&
                            ` · Bill #${r?.bill_number || item.ocr_preview?.bill_number}`}
                        </div>
                        {r && !r.posted && (
                          <div className="truncate">
                            {r.owner_email
                              ? <>Waiting on <span className="text-foreground">{mine ? 'you' : r.owner_email}</span></>
                              : <span className="text-amber-300">Not assigned to anyone yet</span>}
                          </div>
                        )}
                        {r?.approved_by && (
                          <div className="truncate text-emerald-400/80">Approved by {r.approved_by}</div>
                        )}
                      </div>
                    </div>
                    {amount != null && (
                      <div className="text-right flex-shrink-0">
                        <div className="text-[15px] font-bold tabular-nums">{formatCurrency(amount)}</div>
                        {r?.receipt_date && <div className="text-[11px] text-muted-foreground">{r.receipt_date}</div>}
                      </div>
                    )}
                  </div>

                  {item.status_detail && !r?.posted && (
                    <div className="text-xs text-amber-300/90 bg-amber-500/10 rounded px-2.5 py-1.5">
                      {item.status_detail}
                    </div>
                  )}
                  {r?.post_error && (
                    <div className="text-xs text-red-300 bg-red-500/10 rounded px-2.5 py-1.5">
                      QuickBooks refused it: {r.post_error}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    {r && !r.posted && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => navigate(`edit/${r.id}`)}>
                          Open bill
                        </Button>

                        {r.unassigned && (
                          <Button size="sm" variant="outline" onClick={() => void assign(item)} disabled={busy === item.id}>
                            <UserPlus className="h-4 w-4 mr-1.5" /> Assign an approver
                          </Button>
                        )}

                        {/* Approve is only offered to the person it is waiting
                            on. Everyone else sees who that is, so a bill can't
                            be quietly cleared by whoever opened the page. */}
                        {r.awaiting_approval && mine && (
                          <Button size="sm" onClick={() => void approve(item)} disabled={busy === item.id}>
                            {busy === item.id
                              ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                              : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
                            Approve
                          </Button>
                        )}

                        <Button
                          size="sm"
                          variant={r.can_post ? 'default' : 'outline'}
                          onClick={() => void postToQuickBooks(item)}
                          disabled={busy === item.id || !r.can_post}
                          title={r.can_post ? undefined : 'This bill has to be approved before it can post.'}
                        >
                          {busy === item.id
                            ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                            : <Send className="h-4 w-4 mr-1.5" />}
                          Post to QuickBooks
                        </Button>
                      </>
                    )}
                    {r?.posted && (
                      <span className="text-xs text-emerald-400 flex items-center gap-1.5">
                        <CheckCircle2 className="h-4 w-4" />
                        QBO bill {r.qbo_bill_id}
                      </span>
                    )}
                    {r?.posted && payments.get(r.id) && (
                      <Badge variant="success">
                        Paid · {RAIL_LABEL[payments.get(r.id)!.rail].split(' (')[0]}
                      </Badge>
                    )}
                    {isSuperadmin && r?.posted && r.qbo_bill_id && !payments.get(r.id) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setPayingId(payingId === r.id ? null : r.id)}
                        title="Pay this bill — bank transfer, or record a payment you already sent"
                      >
                        <Banknote className="h-4 w-4 mr-1.5" /> Pay
                      </Button>
                    )}
                    {item.file_url && (
                      <a
                        href={item.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-sky-400 hover:underline inline-flex items-center gap-1"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        {item.file_name || 'the original PDF'}
                      </a>
                    )}
                    {NEEDS_ATTENTION.includes(item.status) && (
                      <Button size="sm" variant="outline" onClick={() => void reprocess(item.id)} disabled={busy === item.id}>
                        {busy === item.id
                          ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                          : <RefreshCw className="h-4 w-4 mr-1.5" />}
                        Try again
                      </Button>
                    )}
                    {item.status !== 'ignored' && !r?.posted && (
                      <Button size="sm" variant="ghost" onClick={() => void dismiss(item)} disabled={busy === item.id}>
                        <X className="h-4 w-4 mr-1.5" /> Dismiss
                      </Button>
                    )}
                    {item.diagnostics && (
                      <button
                        type="button"
                        className="text-[11px] text-muted-foreground hover:text-foreground underline"
                        onClick={() => setShowDiag(showDiag === item.id ? null : item.id)}
                      >
                        {showDiag === item.id ? 'Hide' : 'Show'} diagnostics
                      </button>
                    )}
                  </div>

                  {showDiag === item.id && item.diagnostics && (
                    <pre className="text-[11px] bg-black/30 rounded p-2.5 overflow-x-auto whitespace-pre-wrap break-words text-muted-foreground">
                      {item.diagnostics}
                    </pre>
                  )}

                  {r && payingId === r.id && (
                    <PayBillPanel
                      expenseId={r.id}
                      onClose={() => setPayingId(null)}
                      onPaid={() => { setPayingId(null); void load(); }}
                    />
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
