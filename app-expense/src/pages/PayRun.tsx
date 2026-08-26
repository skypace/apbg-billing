import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select-field';
import { Banknote, Loader2, Mail, RefreshCw, Send, ShieldAlert } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { useIsSuperadmin } from '@/lib/useIsSuperadmin';
import {
  payRunList, payRunStripe, payRunRecord, payRunRemit, recentPaymentGroups,
  MANUAL_RAILS, RAIL_LABEL,
  type PayRunList, type PayRunVendorGroup, type PaymentRail, type VendorPaymentGroup,
} from '@/lib/vendorPay';

// Pay Bills — the pay run.
//
// Every posted, unpaid bill grouped by vendor. Tick the bills you're paying,
// and each vendor's selection goes out as ONE payment — one Stripe payout or
// one recorded check/Venmo/Zelle — which books ONE QuickBooks BillPayment
// covering all of them and sends the vendor ONE remittance advice listing
// every bill, so their AR desk can apply a single deposit across invoices.
//
// Money out is superadmin-only server side (/api/vendor-pay-run); this page
// only hides buttons the API would refuse anyway.

const MANUAL_OPTS = MANUAL_RAILS.map((r) => ({ value: r, label: RAIL_LABEL[r] }));

function dueBadge(due: string | null) {
  if (!due) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (due < today) return <Badge variant="destructive">overdue {due}</Badge>;
  return <Badge variant="secondary">due {due}</Badge>;
}

function VendorSection({
  group, selected, onToggle, onToggleAll, onPaid, stripeConfigured,
}: {
  group: PayRunVendorGroup;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], on: boolean) => void;
  onPaid: (msg: string) => void;
  stripeConfigured: boolean;
}) {
  const pickedBills = group.bills.filter((b) => selected.has(b.id));
  const pickedTotal = pickedBills.reduce((s, b) => s + b.amount, 0);
  const allPicked = group.bills.length > 0 && pickedBills.length === group.bills.length;
  const stripeReady = stripeConfigured && !!group.vendor?.stripe_recipient_id;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [rail, setRail] = useState<PaymentRail>('check_manual');
  const [reference, setReference] = useState('');
  const [remitTo, setRemitTo] = useState(group.vendor?.contact_email || '');

  const ids = pickedBills.map((b) => b.id);

  const payStripe = async () => {
    if (!window.confirm(
      `Send ${formatCurrency(pickedTotal)} to ${group.vendor_name} by bank transfer (Stripe)?\n\n`
      + `One payout covering ${pickedBills.length} bill(s). This moves real money now and cannot be undone from here.\n`
      + `The remittance advice goes to ${remitTo || 'nobody — no email on file'} once the transfer settles.`,
    )) return;
    setBusy('stripe'); setError(null);
    try {
      const r = await payRunStripe(ids, remitTo.trim() || undefined);
      onPaid(`Sent — Stripe payout ${r.payout_id} for ${formatCurrency(r.total)} covering ${r.bills} bill(s). `
        + 'QuickBooks records one payment and the vendor gets the remittance advice when it settles.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment failed.');
    } finally { setBusy(null); }
  };

  const record = async () => {
    if (!window.confirm(
      `Record ${formatCurrency(pickedTotal)} to ${group.vendor_name} as already paid by ${RAIL_LABEL[rail]}?\n\n`
      + `${pickedBills.length} bill(s), one QuickBooks payment`
      + (rail === 'qbo_billpay' ? ' (Bill Pay already booked its own — this only files it here)' : '')
      + `.\nRemittance advice goes to ${remitTo || 'nobody — no email on file'} now.`,
    )) return;
    setBusy('record'); setError(null);
    try {
      const r = await payRunRecord(ids, rail, {
        reference: reference.trim() || undefined,
        remitTo: remitTo.trim() || undefined,
      });
      const remitNote = r.remittance?.sent
        ? `Remittance advice sent to ${r.remittance.to}.`
        : `Remittance advice NOT sent (${r.remittance?.error || 'unknown'}) — resend it below.`;
      onPaid(`Recorded ${formatCurrency(r.total)} across ${r.bills} bill(s)`
        + (r.qbo_billpayment_id ? ` — QuickBooks BillPayment ${r.qbo_billpayment_id}. ` : '. ') + remitNote);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the payment.');
    } finally { setBusy(null); }
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={allPicked}
            disabled={group.bills.length === 0}
            onChange={(e) => onToggleAll(group.bills.map((b) => b.id), e.target.checked)}
            title="Select every bill for this vendor"
          />
          <h3 className="text-sm font-bold tracking-tight flex-1">{group.vendor_name}</h3>
          {group.vendor ? (
            <Badge variant={stripeReady ? 'default' : 'secondary'}>
              {stripeReady ? 'Bank transfer ready' : 'No bank setup'}
            </Badge>
          ) : (
            <Badge variant="destructive">Not in vendor registry</Badge>
          )}
          <span className="text-sm font-bold tabular-nums">
            {pickedBills.length > 0
              ? `${formatCurrency(pickedTotal)} of ${formatCurrency(group.total)}`
              : formatCurrency(group.total)}
          </span>
        </div>

        <div className="space-y-1">
          {group.bills.map((b) => (
            <label
              key={b.id}
              className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-sm cursor-pointer hover:bg-muted/40"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={selected.has(b.id)}
                onChange={() => onToggle(b.id)}
              />
              <span className="font-medium">{b.bill_number ? `Bill #${b.bill_number}` : 'No bill #'}</span>
              <span className="text-muted-foreground text-xs">
                {b.receipt_date || 'no date'}{b.job_number ? ` · job ${b.job_number}` : ''}
              </span>
              <span className="flex-1" />
              {dueBadge(b.due_date)}
              <span className="font-semibold tabular-nums">{formatCurrency(b.amount)}</span>
            </label>
          ))}
          {group.in_flight.map((b) => (
            <div key={b.id} className="flex items-center gap-2.5 rounded-lg border border-border/60 px-3 py-2 text-sm opacity-60">
              <span className="w-4" />
              <span className="font-medium">{b.bill_number ? `Bill #${b.bill_number}` : 'No bill #'}</span>
              <Badge variant="secondary">
                {b.payment_status === 'initiated' ? 'Payment sending…' : `Payment ${b.payment_status}`}
              </Badge>
              <span className="flex-1" />
              <span className="font-semibold tabular-nums">{formatCurrency(b.amount)}</span>
            </div>
          ))}
        </div>

        {error && (
          <div className="text-sm rounded-lg p-2.5 border border-destructive/40 bg-destructive/10 text-destructive">{error}</div>
        )}

        {pickedBills.length > 0 && (
          <div className="rounded-lg border border-primary/40 p-3 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <Label>Remittance advice goes to</Label>
                <Input
                  type="email"
                  placeholder="vendor's email"
                  value={remitTo}
                  onChange={(e) => setRemitTo(e.target.value)}
                />
              </div>
              <div className="flex items-end">
                <p className="text-[11px] text-muted-foreground pb-1.5">
                  One email listing every bill this payment covers, so they can apply one deposit across invoices.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={busy !== null || !stripeReady || !group.vendor}
                onClick={payStripe}
                title={stripeReady ? undefined : 'Vendor has not finished Stripe bank setup'}
              >
                {busy === 'stripe' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />}
                Pay {formatCurrency(pickedTotal)} by bank transfer
              </Button>
              <Button size="sm" variant="outline" disabled={busy !== null || !group.vendor} onClick={() => setRecordOpen((v) => !v)}>
                Already paid another way…
              </Button>
            </div>

            {recordOpen && (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <Label>How it was paid</Label>
                    <SelectField options={MANUAL_OPTS} value={rail} onChange={(e) => setRail(e.target.value as PaymentRail)} />
                  </div>
                  <div>
                    <Label>Reference (optional)</Label>
                    <Input placeholder="Check #, Venmo note…" value={reference} onChange={(e) => setReference(e.target.value)} />
                  </div>
                </div>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={record}>
                  {busy === 'record' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                  Record {formatCurrency(pickedTotal)} as paid
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Books ONE QuickBooks payment covering all {pickedBills.length} bill(s) — except QuickBooks Bill Pay,
                  which already posted its own.
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecentPayments({ groups, onResent }: {
  groups: (VendorPaymentGroup & { vendor_name: string })[];
  onResent: (msg: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resend = async (g: VendorPaymentGroup & { vendor_name: string }) => {
    const to = window.prompt(
      `Send the remittance advice for ${formatCurrency(g.total_amount)} to ${g.vendor_name} to which email?`,
      g.remittance_sent_to || g.remit_to || '',
    );
    if (!to || !to.trim()) return;
    setBusyId(g.id); setError(null);
    try {
      const r = await payRunRemit(g.id, to.trim());
      onResent(`Remittance advice sent to ${r.sent_to}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the remittance advice.');
    } finally { setBusyId(null); }
  };

  if (groups.length === 0) return null;
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <h3 className="text-sm font-bold tracking-tight">Recent payments</h3>
        {error && (
          <div className="text-sm rounded-lg p-2.5 border border-destructive/40 bg-destructive/10 text-destructive">{error}</div>
        )}
        <div className="space-y-1">
          {groups.map((g) => (
            <div key={g.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <span className="text-xs text-muted-foreground">{String(g.created_at).slice(0, 10)}</span>
              <span className="font-medium">{g.vendor_name}</span>
              <span className="text-xs text-muted-foreground">
                {g.bill_count} bill{g.bill_count === 1 ? '' : 's'} · {RAIL_LABEL[g.rail] || g.rail}
                {g.reference ? ` · ref ${g.reference}` : ''}
              </span>
              <Badge variant={g.status === 'settled' || g.status === 'recorded' ? 'default' : g.status === 'failed' ? 'destructive' : 'secondary'}>
                {g.status === 'initiated' ? 'Sending…' : g.status}
              </Badge>
              <span className="flex-1" />
              {g.remittance_sent_at ? (
                <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                  <Mail className="h-3 w-3" /> remitted to {g.remittance_sent_to}
                </span>
              ) : g.status === 'initiated' ? (
                <span className="text-[11px] text-muted-foreground">remittance sends at settlement</span>
              ) : g.remittance_error ? (
                <span className="text-[11px] text-destructive">remittance failed: {g.remittance_error}</span>
              ) : null}
              <span className="font-semibold tabular-nums">{formatCurrency(g.total_amount)}</span>
              {(g.status === 'settled' || g.status === 'recorded') && (
                <Button size="sm" variant="ghost" disabled={busyId !== null} onClick={() => resend(g)} title="Send the remittance advice (again)">
                  {busyId === g.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                </Button>
              )}
              {g.failure_reason && (
                <p className="w-full text-[11px] text-destructive">{g.failure_reason}</p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function PayRun() {
  const isSuperadmin = useIsSuperadmin();
  const [data, setData] = useState<PayRunList | null>(null);
  const [recent, setRecent] = useState<(VendorPaymentGroup & { vendor_name: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [list, groups] = await Promise.all([payRunList(), recentPaymentGroups()]);
      setData(list);
      setRecent(groups);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load payable bills.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = (ids: string[], on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });

  const paid = (msg: string) => { setFlash(msg); void load(); };

  const openTotal = useMemo(
    () => (data?.vendors || []).reduce((s, g) => s + g.total, 0),
    [data],
  );
  const balance = data?.stripe.balance_cents != null ? data.stripe.balance_cents / 100 : null;

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-center gap-3">
        <Banknote className="h-6 w-6 text-primary" />
        <div className="flex-1 min-w-[220px]">
          <h1 className="text-xl font-extrabold tracking-tight">Pay Bills</h1>
          <p className="text-sm text-muted-foreground">
            Tick the bills to pay — each vendor&rsquo;s selection goes out as one payment, one QuickBooks entry,
            and one remittance advice.
          </p>
        </div>
        {balance !== null && (
          <Badge variant="secondary" title="Stripe payout balance — top up from Vendors → Stripe vendor funding">
            Payout balance {formatCurrency(balance)}
          </Badge>
        )}
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading} title="Reload">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {!isSuperadmin && (
        <div className="text-sm rounded-lg p-3 border border-amber-500/40 bg-amber-500/10 text-amber-500 flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 mt-0.5" />
          <span>Paying vendors is superadmin-only. You can see what&rsquo;s owed here, but the pay buttons will be refused.</span>
        </div>
      )}

      {flash && (
        <div className="text-sm rounded-lg p-3 border border-emerald-500/40 bg-emerald-500/10 text-emerald-500">
          {flash}
        </div>
      )}
      {error && (
        <div className="text-sm rounded-lg p-3 border border-destructive/40 bg-destructive/10 text-destructive">{error}</div>
      )}

      {loading && !data ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : data && data.vendors.length === 0 ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">
          Nothing to pay — every posted bill is either paid or already has a payment in flight.
          Bills appear here once they&rsquo;re posted to QuickBooks and still unpaid.
        </CardContent></Card>
      ) : data ? (
        <>
          <p className="text-xs text-muted-foreground">
            {data.vendors.length} vendor{data.vendors.length === 1 ? '' : 's'} · {formatCurrency(openTotal)} open
          </p>
          {data.vendors.map((g) => (
            <VendorSection
              key={g.qbo_vendor_id ?? g.vendor_name}
              group={g}
              selected={selected}
              onToggle={toggle}
              onToggleAll={toggleAll}
              onPaid={paid}
              stripeConfigured={data.stripe.configured}
            />
          ))}
        </>
      ) : null}

      <RecentPayments groups={recent} onResent={paid} />
    </div>
  );
}
