import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { postToQuickBooks as postExpenseToQbo, DuplicateBillError } from '@/lib/postToQbo';
import { useSession } from '@/lib/hooks';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DueBadge, DuplicateBadge, DuplicateNote } from '@/components/BillFlags';
import { ApAgingStrip } from '@/components/ApAgingStrip';
import { Button } from '@/components/ui/button';
import { AlertTriangle, ArrowLeft, Inbox, Loader2, Send } from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { ExpenseRequest } from '@/types/expense';

// My Inbox — the things that are actually waiting on ME.
//
// Deliberately NOT another list of everything. Expense History is the archive;
// the Vendor Inbox is the shared pile. This page answers one question: what do
// I have to do? It is scoped by RLS to rows where I am the submitter or the
// named owner (expense_requests_select), so there is no cross-user leakage to
// filter out client-side.
//
// Three buckets, in the order you act on them:
//   Waiting on you  — pending, routed to you: approve it
//   Ready to post   — approved and unposted: one click to QuickBooks
//   Needs a fix     — a post that QuickBooks refused, with the reason

type Bucket = 'approve' | 'post' | 'fix';

type Row = ExpenseRequest;

export default function MyInbox() {
  const navigate = useNavigate();
  const { session } = useSession();
  const email = (session?.user?.email || '').toLowerCase();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    // RLS already limits this to my rows; the status filter is what makes it
    // an inbox rather than a history.
    const { data, error: err } = await supabase
      .from('expense_requests')
      .select('*')
      .is('archived_at', null)
      .in('status', ['pending', 'approved', 'awaiting_invoice'])
      .is('qbo_bill_id', null)
      .order('created_at', { ascending: false })
      .limit(200);
    if (err) setError(err.message);
    setRows((data as Row[]) ?? []);
    setLoading(false);
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  const bucketOf = (r: Row): Bucket => {
    if (r.autopost_error) return 'fix';
    if (r.status === 'pending' && (r.manager_email || '').toLowerCase() === email) return 'approve';
    return 'post';
  };

  const post = async (r: Row) => {
    setBusy(r.id);
    setError(null);
    try {
      await postExpenseToQbo(r.id);
      await load();
    } catch (e) {
      if (e instanceof DuplicateBillError) { setError(null); return; }
      setError(e instanceof Error ? e.message : 'Could not post to QuickBooks.');
    } finally {
      setBusy(null);
    }
  };

  const groups: { key: Bucket; title: string; hint: string; rows: Row[] }[] = [
    { key: 'approve', title: 'Waiting on you', hint: 'Routed to you for approval.', rows: [] },
    { key: 'fix', title: 'Needs a fix', hint: 'QuickBooks refused these — open and correct them.', rows: [] },
    { key: 'post', title: 'Ready to post', hint: 'Approved and not yet in QuickBooks.', rows: [] },
  ];
  for (const r of rows) groups.find((g) => g.key === bucketOf(r))!.rows.push(r);
  const live = groups.filter((g) => g.rows.length > 0);
  const total = rows.reduce((s, r) => s + (r.total_amount ?? 0), 0);

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold tracking-tight">My Inbox</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Everything waiting on you. Filed and posted expenses live in Expense History.
          </p>
        </div>
        {rows.length > 0 && (
          <div className="text-right">
            <div className="text-[15px] font-bold tabular-nums">{formatCurrency(total)}</div>
            <div className="text-[11px] text-muted-foreground">{rows.length} open</div>
          </div>
        )}
      </div>

      {error && (
        <Card className="border-red-500/40">
          <CardContent className="p-3 text-sm text-red-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </CardContent>
        </Card>
      )}

      <ApAgingStrip />

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
        </div>
      ) : live.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            <Inbox className="h-8 w-8 mx-auto mb-3 opacity-40" />
            Nothing waiting on you. Anything you've already filed is in{' '}
            <button type="button" className="underline hover:text-foreground" onClick={() => navigate('pending')}>
              Expense History
            </button>.
          </CardContent>
        </Card>
      ) : (
        live.map((g) => (
          <div key={g.key} className="space-y-2">
            <div className="flex items-baseline gap-2 pt-1">
              <h2 className="text-sm font-semibold">{g.title}</h2>
              <span className="text-[11px] text-muted-foreground">{g.hint}</span>
            </div>
            {g.rows.map((r) => (
              <Card key={r.id}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold truncate">{r.vendor_name || 'No vendor'}</span>
                        {r.tag && <Badge variant="secondary">{r.tag}</Badge>}
                        <DueBadge request={r} />
                        <DuplicateBadge request={r} />
                        {g.key === 'approve' && <Badge variant="info">Approve</Badge>}
                        {g.key === 'fix' && <Badge variant="destructive">Post failed</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 truncate">
                        {r.bill_number ? `Bill #${r.bill_number} · ` : ''}
                        {r.receipt_date || formatDate(r.created_at)}
                        {r.job_number ? ` · Job ${r.job_number}` : ''}
                      </div>
                    </div>
                    <div className="text-[15px] font-bold tabular-nums flex-shrink-0">
                      {formatCurrency(r.total_amount ?? 0)}
                    </div>
                  </div>

                  <DuplicateNote request={r} />
                  {r.autopost_error && (
                    <div className="text-xs text-red-300 bg-red-500/10 rounded px-2.5 py-1.5">
                      {r.autopost_error}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 pt-0.5">
                    <Button size="sm" variant="outline" onClick={() => navigate(`edit/${r.id}`)}>Open</Button>
                    {g.key === 'approve' ? (
                      <Button size="sm" onClick={() => navigate(`review/${r.id}`)}>Review &amp; approve</Button>
                    ) : (
                      <Button size="sm" onClick={() => void post(r)} disabled={busy === r.id}>
                        {busy === r.id
                          ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                          : <Send className="h-4 w-4 mr-1.5" />}
                        Post to QuickBooks
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
