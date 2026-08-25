// Inline pay panel for a posted vendor bill (Vendor Portal Phase 3).
// Superadmin-only by construction — /api/vendor-pay refuses everyone else;
// callers hide the trigger for non-superadmins so nobody clicks into a 403.
//
// No dialog primitives exist in this app, so this expands in place (the
// CardMatch editor pattern). It always shows the confirm facts BEFORE any
// money moves: vendor, rail, amount, and whatever is blocking.
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select-field';
import { Loader2, Send, X } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import {
  previewPayment, payViaStripe, recordManualPayment,
  MANUAL_RAILS, RAIL_LABEL, type PayPreview, type PaymentRail,
} from '@/lib/vendorPay';

const MANUAL_OPTS = MANUAL_RAILS.map((r) => ({ value: r, label: RAIL_LABEL[r] }));

export function PayBillPanel({
  expenseId, onClose, onPaid,
}: {
  expenseId: string;
  onClose: () => void;
  onPaid: () => void;
}) {
  const [preview, setPreview] = useState<PayPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [rail, setRail] = useState<PaymentRail>('check_manual');
  const [reference, setReference] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setPreview(await previewPayment(expenseId));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load the payment preview.');
      } finally {
        setLoading(false);
      }
    })();
  }, [expenseId]);

  const payStripe = async () => {
    if (!preview?.vendor) return;
    if (!window.confirm(
      `Send ${formatCurrency(preview.amount)} to ${preview.vendor.display_name} by bank transfer (Stripe)?\n\n`
      + 'This moves real money now. It cannot be undone from here.',
    )) return;
    setBusy('stripe');
    setError(null);
    try {
      const r = await payViaStripe(expenseId);
      setDone(`Sent — Stripe payout ${r.payout_id}. QuickBooks records the payment automatically once it posts.`);
      onPaid();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment failed.');
    } finally {
      setBusy(null);
    }
  };

  const record = async () => {
    if (!preview?.vendor) return;
    if (!window.confirm(
      `Record ${formatCurrency(preview.amount)} to ${preview.vendor.display_name} as already paid by ${RAIL_LABEL[rail]}?\n\n`
      + (rail === 'qbo_billpay'
        ? 'QuickBooks Bill Pay already booked its own payment, so this only files it in Brixpense.'
        : 'This books the payment in QuickBooks so the bill reads paid.'),
    )) return;
    setBusy('record');
    setError(null);
    try {
      const r = await recordManualPayment(expenseId, rail, reference.trim() || undefined);
      setDone(r.qbo_billpayment_id
        ? `Recorded — QuickBooks BillPayment ${r.qbo_billpayment_id}.`
        : 'Recorded in Brixpense (QuickBooks Bill Pay already booked its own payment).');
      onPaid();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the payment.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="border-primary/40">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold tracking-tight flex-1">Pay this bill</h3>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            {done && (
              <div className="text-sm rounded-lg p-2.5 border border-emerald-500/40 bg-emerald-500/10 text-emerald-500">
                {done}
              </div>
            )}
            {error && (
              <div className="text-sm rounded-lg p-2.5 border border-destructive/40 bg-destructive/10 text-destructive">
                {error}
              </div>
            )}

            {preview && !done && (
              <>
                <div className="text-sm">
                  <span className="font-semibold">{preview.vendor?.display_name || 'Unlinked vendor'}</span>
                  {' · '}
                  <span className="font-bold tabular-nums">{formatCurrency(preview.amount)}</span>
                  {preview.vendor?.payment_method_pref && (
                    <Badge variant="secondary" className="ml-2">
                      prefers {RAIL_LABEL[preview.vendor.payment_method_pref as PaymentRail] || preview.vendor.payment_method_pref}
                    </Badge>
                  )}
                </div>

                {preview.problems.length > 0 && (
                  <div className="text-sm rounded-lg p-2.5 border border-amber-500/40 bg-amber-500/10 text-amber-500">
                    {preview.problems.map((p, i) => <p key={i}>{p}</p>)}
                  </div>
                )}

                {/* Stripe rail */}
                <div className="rounded-lg border border-border p-3 space-y-2">
                  <p className="text-[13px] font-semibold">Bank transfer (Stripe)</p>
                  {!preview.stripe.configured ? (
                    <p className="text-xs text-muted-foreground">Stripe payouts aren&rsquo;t configured on this site yet.</p>
                  ) : !preview.vendor?.stripe_recipient_id || !preview.stripe.ready ? (
                    <p className="text-xs text-amber-500">
                      This vendor hasn&rsquo;t finished Stripe bank setup — use &ldquo;Set up bank payouts&rdquo; on their
                      vendor page, or record a manual payment below.
                    </p>
                  ) : (
                    <>
                      {preview.stripe.funded === false && (
                        <p className="text-xs text-amber-500">
                          Payout balance {formatCurrency((preview.stripe.balance_cents ?? 0) / 100)} can&rsquo;t cover this —
                          add funds in the Stripe Dashboard first.
                        </p>
                      )}
                      <Button
                        size="sm"
                        disabled={busy !== null || preview.problems.length > 0 || preview.stripe.funded === false}
                        onClick={payStripe}
                      >
                        {busy === 'stripe' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />}
                        Pay {formatCurrency(preview.amount)} now
                      </Button>
                    </>
                  )}
                </div>

                {/* Manual rails */}
                <div className="rounded-lg border border-border p-3 space-y-2">
                  <p className="text-[13px] font-semibold">Already paid another way?</p>
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
                  <Button
                    size="sm" variant="outline"
                    disabled={busy !== null || preview.problems.length > 0}
                    onClick={record}
                  >
                    {busy === 'record' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                    Record payment
                  </Button>
                  <p className="text-[11px] text-muted-foreground">
                    Books the QuickBooks BillPayment so the bill reads paid — except QuickBooks Bill Pay, which already
                    posted its own.
                  </p>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
