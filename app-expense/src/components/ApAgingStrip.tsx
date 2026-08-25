import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { checkQuickBooksPaid } from '@/lib/billPaidSync';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Banknote, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useIsSuperadmin } from '@/lib/useIsSuperadmin';
import { paymentsForExpenses, statusLabel, RAIL_LABEL, type VendorPayment } from '@/lib/vendorPay';
import { PayBillPanel } from '@/components/PayBillPanel';

// What we owe, how late it is, and — the point of the thing — a way to pay it.
//
// Reads ops.v_ap_aging directly. That view is security_invoker, so RLS decides
// what each person sees: the AP desk gets the company's payables, an ordinary
// submitter gets their own. One component, correct for both, with no
// per-audience endpoint to keep in sync.
//
// A bucket expands into the bills behind it. That expansion is what makes this
// an AP screen rather than a poster: the number was already right, but the
// only way to act on an overdue bill was to go hunting for it by name in
// another list. Pay is superadmin-only (/api/vendor-pay refuses anyone else)
// and only offered on a POSTED bill — a QuickBooks BillPayment needs a Bill to
// attach to, so an unposted row gets a nudge to post it first instead of a
// button that would fail.
//
// It renders nothing at all when there is nothing outstanding. An empty aging
// panel is a permanent zero that teaches people to stop reading the row.

type Bucket = 'current' | '1-30' | '31-60' | '61-90' | '90+' | 'no due date';

const ORDER: Bucket[] = ['90+', '61-90', '31-60', '1-30', 'current', 'no due date'];

const LOOK: Record<Bucket, { label: string; tone: string }> = {
  '90+':          { label: '90+ days late', tone: 'text-red-300' },
  '61-90':        { label: '61–90 late',    tone: 'text-red-300/90' },
  '31-60':        { label: '31–60 late',    tone: 'text-amber-300' },
  '1-30':         { label: '1–30 late',     tone: 'text-amber-300/90' },
  current:        { label: 'Not due yet',   tone: 'text-muted-foreground' },
  'no due date':  { label: 'No due date',   tone: 'text-muted-foreground' },
};

interface Row {
  id: string;
  vendor_name: string | null;
  bill_number: string | null;
  total_amount: number | null;
  due_date: string | null;
  days_overdue: number | null;
  posted: boolean;
  qbo_bill_id: string | null;
  qbo_balance: number | null;
  aging_bucket: Bucket;
}

// Reading rows and summing in the browser is fine at this scale (35 unpaid
// bills today) and keeps the RLS story simple — but a total that silently
// stops counting is exactly the kind of number people trust and shouldn't.
// If the cap is ever hit, the strip says so rather than under-reporting.
const ROW_CAP = 2000;

export function ApAgingStrip() {
  const navigate = useNavigate();
  const isSuperadmin = useIsSuperadmin();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [open, setOpen] = useState<Bucket | null>(null);
  const [payments, setPayments] = useState<Map<string, VendorPayment>>(new Map());
  const [payingId, setPayingId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('v_ap_aging')
      .select('id,vendor_name,bill_number,total_amount,due_date,days_overdue,posted,qbo_bill_id,qbo_balance,aging_bucket')
      .limit(ROW_CAP);
    const got = (data as Row[]) ?? [];
    setRows(got);
    setTruncated(got.length >= ROW_CAP);
    // An in-flight payout still counts as owed, but the row must say so —
    // otherwise the same bill looks payable twice while Stripe settles.
    try {
      setPayments(await paymentsForExpenses(got.filter((r) => r.qbo_bill_id).map((r) => r.id)));
    } catch { /* the strip must render even if the ledger read fails */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!rows || rows.length === 0) return null;

  const totals = new Map<Bucket, { n: number; amt: number }>();
  for (const r of rows) {
    const b = (r.aging_bucket || 'no due date') as Bucket;
    const cur = totals.get(b) ?? { n: 0, amt: 0 };
    totals.set(b, { n: cur.n + 1, amt: cur.amt + Number(r.total_amount || 0) });
  }
  const shown = ORDER.filter((b) => totals.has(b));
  const owed = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0);
  const overdue = shown
    .filter((b) => b !== 'current' && b !== 'no due date')
    .reduce((s, b) => s + (totals.get(b)?.amt ?? 0), 0);

  const openRows = open
    ? rows
        .filter((r) => (r.aging_bucket || 'no due date') === open)
        .sort((a, b) => Number(b.total_amount || 0) - Number(a.total_amount || 0))
    : [];

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <div>
            <h2 className="text-sm font-semibold">Unpaid bills</h2>
            <p className="text-[11px] text-muted-foreground">
              {overdue > 0
                ? `${formatCurrency(overdue)} of it is past due.`
                : 'Nothing past due.'}
              {' '}Pick a bucket to see the bills in it.
              {truncated && ` Showing the first ${ROW_CAP} — the real total is higher.`}
            </p>
          </div>
          <div className="flex items-start gap-3">
            {isSuperadmin && (
              <Button
                size="sm"
                variant="outline"
                disabled={checking}
                onClick={async () => {
                  setChecking(true); setCheckNote(null);
                  try {
                    const r = await checkQuickBooksPaid();
                    setCheckNote(
                      r.paid > 0
                        ? `${r.paid} bill${r.paid === 1 ? '' : 's'} already paid in QuickBooks — cleared.`
                        : 'Nothing new — QuickBooks still shows these as unpaid.',
                    );
                    await load();
                  } catch (e) {
                    setCheckNote(e instanceof Error ? e.message : 'Could not reach QuickBooks.');
                  } finally {
                    setChecking(false);
                  }
                }}
                title="Ask QuickBooks whether any of these have been paid outside Brixpense"
              >
                {checking
                  ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
                Check QuickBooks
              </Button>
            )}
            <div className="text-right">
              <div className="text-[15px] font-bold tabular-nums">{formatCurrency(owed)}</div>
              <div className="text-[11px] text-muted-foreground">{rows.length} bill{rows.length === 1 ? '' : 's'}</div>
            </div>
          </div>
        </div>

        {checkNote && (
          <div className="mb-3 text-[12px] text-muted-foreground rounded-lg bg-white/[0.03] px-3 py-2">
            {checkNote}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {shown.map((b) => {
            const t = totals.get(b)!;
            const active = open === b;
            return (
              <button
                key={b}
                type="button"
                aria-expanded={active}
                onClick={() => { setOpen(active ? null : b); setPayingId(null); }}
                className={`rounded-lg px-2.5 py-2 text-left transition-colors ${
                  active ? 'bg-white/[0.10] ring-1 ring-white/20' : 'bg-white/[0.03] hover:bg-white/[0.06]'
                }`}
              >
                <div className={`text-[11px] font-semibold flex items-center gap-1 ${LOOK[b].tone}`}>
                  <span className="truncate">{LOOK[b].label}</span>
                  <ChevronDown className={`h-3 w-3 flex-shrink-0 transition-transform ${active ? 'rotate-180' : ''}`} />
                </div>
                <div className="text-[13px] font-bold tabular-nums mt-0.5">{formatCurrency(t.amt)}</div>
                <div className="text-[10px] text-muted-foreground">{t.n}</div>
              </button>
            );
          })}
        </div>

        {open && (
          <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
            {openRows.map((r) => {
              const pay = payments.get(r.id);
              return (
                <div key={r.id}>
                  <div className="flex items-center gap-3 rounded-lg bg-white/[0.02] px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-semibold truncate">{r.vendor_name || 'No vendor'}</span>
                        {!r.posted && <Badge variant="secondary">Not in QuickBooks yet</Badge>}
                        {r.qbo_balance !== null && r.qbo_balance !== undefined
                          && Number(r.qbo_balance) > 0
                          && Number(r.qbo_balance) < Number(r.total_amount ?? Infinity) && (
                          <Badge variant="warning">
                            Partly paid · {formatCurrency(Number(r.qbo_balance))} left
                          </Badge>
                        )}
                        {pay && (
                          <Badge variant={statusLabel(pay).variant}>
                            {statusLabel(pay).label} · {RAIL_LABEL[pay.rail].split(' (')[0]}
                          </Badge>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {r.bill_number ? `Bill #${r.bill_number} · ` : ''}
                        {r.due_date ? `due ${formatDate(r.due_date)}` : 'no due date'}
                        {typeof r.days_overdue === 'number' && r.days_overdue > 0
                          ? ` · ${r.days_overdue} day${r.days_overdue === 1 ? '' : 's'} late`
                          : ''}
                      </div>
                    </div>
                    <span className="text-[13px] font-bold tabular-nums flex-shrink-0">
                      {formatCurrency(r.total_amount ?? 0)}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => navigate(`/edit/${r.id}`)}>Open</Button>
                    {isSuperadmin && r.posted && !pay && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setPayingId(payingId === r.id ? null : r.id)}
                        title="Pay this bill — bank transfer, or record a payment you already sent"
                      >
                        <Banknote className="h-4 w-4 mr-1" /> Pay
                      </Button>
                    )}
                  </div>
                  {payingId === r.id && (
                    <div className="mt-2">
                      <PayBillPanel
                        expenseId={r.id}
                        onClose={() => setPayingId(null)}
                        onPaid={() => { setPayingId(null); void load(); }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
