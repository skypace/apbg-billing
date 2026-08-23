// The Stripe vendor-funding float (Vendor Portal Phase 3b) — superadmin only.
//
// Why this card exists: vendor payouts draw on a Stripe balance, and Stripe
// CANNOT auto-pull when it runs low (their bank pull is manual per transfer and
// settles in 2–6 business days). So this is where you see the float, top it up
// ahead of the bills you know are coming, and confirm QuickBooks got told —
// each funding event books a Transfer into the "Stripe Vendor Funding" bank
// account, and that account's QBO balance should match the number shown here.
//
// Collapsed by default: it's a control surface, not the point of the page.
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ChevronDown, ChevronUp, Landmark, Loader2, RefreshCw } from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import {
  fundingStatus, topUpFunding, syncFundingNow, saveFundingConfig,
  fundingChip, FUNDING_KIND_LABEL, type FundingStatusResponse,
} from '@/lib/vendorFunding';

export function VendorFundingCard() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<FundingStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [floor, setFloor] = useState('');
  const [target, setTarget] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await fundingStatus();
      setData(d);
      setFloor(String(d.config.floor));
      setTarget(String(d.config.target));
      if (d.balance !== undefined && d.balance < d.config.target) {
        setAmount(String(Math.max(0, Math.round(d.config.target - d.balance))));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the funding status.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open && !data) load(); }, [open]);

  const topUp = async () => {
    const amt = Number(amount);
    if (!(amt > 0)) { setError('Enter an amount to pull.'); return; }
    if (!window.confirm(
      `Pull ${formatCurrency(amt)} from the linked bank account into Stripe?\n\n`
      + `This moves real money. It settles in ${data?.settlement_days || '2–6 business days'}, `
      + 'and the QuickBooks transfer (Chase → Stripe Vendor Funding) books itself once it lands.',
    )) return;
    setBusy('top_up');
    setError(null);
    setNotice(null);
    try {
      const res = await topUpFunding(amt);
      setNotice(res.note);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The top-up failed.');
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy('sync');
    setError(null);
    setNotice(null);
    try {
      const r = await syncFundingNow();
      setNotice(`Reconciled: ${r.seen} funding event(s) in Stripe, ${r.inserted} new, ${r.booked} booked to QuickBooks`
        + (r.errors.length ? ` — ${r.errors.length} error(s): ${r.errors[0]}` : '.'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The reconcile failed.');
    } finally {
      setBusy(null);
    }
  };

  const saveConfig = async (patch: { floor?: number; target?: number; auto_top_up?: boolean }) => {
    setBusy('config');
    setError(null);
    try {
      const res = await saveFundingConfig(patch);
      setData((d) => (d ? { ...d, config: res.config, below_floor: d.balance !== undefined && d.balance < res.config.floor } : d));
      setNotice('Funding settings saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the settings.');
    } finally {
      setBusy(null);
    }
  };

  const balanceChip = () => {
    if (!data) return null;
    if (!data.configured) return <Badge variant="secondary">Stripe not configured</Badge>;
    if (data.balance === undefined) return <Badge variant="destructive">Balance unavailable</Badge>;
    return data.below_floor
      ? <Badge variant="warning">{formatCurrency(data.balance)} — below floor</Badge>
      : <Badge variant="success">{formatCurrency(data.balance)} available</Badge>;
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <button
          type="button"
          className="w-full flex items-center gap-2 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <Landmark className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-[15px] font-semibold flex-1">Stripe vendor funding</span>
          {open && balanceChip()}
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>

        {open && (
          <div className="space-y-4 pt-1">
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              Vendor payouts draw on this Stripe balance. QuickBooks mirrors it as the{' '}
              <b>Stripe Vendor Funding</b> bank account — each funding event books a transfer from Chase,
              and every vendor payment is a bill payment out of it, so the two balances should agree.
              Stripe can't top itself up on a low balance: a bank pull is a deliberate act and takes{' '}
              {data?.settlement_days || '2–6 business days'}, so fund ahead of the bills you know are coming.
            </p>

            {loading && !data ? (
              <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : !data ? null : (
              <>
                {(!data.configured || !data.bank_configured || !data.qbo_account_configured) && (
                  <div className="text-[12px] rounded-lg p-3 border border-amber-500/40 bg-amber-500/10 text-amber-500 space-y-1">
                    <div className="font-semibold">Setup still needed before this can move money:</div>
                    {!data.configured && <div>· Stripe key (<code>STRIPE_PAYOUTS_KEY</code>) — needs Money Management inbound-transfer write.</div>}
                    {!data.bank_configured && <div>· Verified bank account in Stripe → Settings → Global Payouts, then <code>STRIPE_FUNDING_BANK_ACCOUNT_ID</code>.</div>}
                    {!data.qbo_account_configured && <div>· The "Stripe Vendor Funding" bank account in QuickBooks, then <code>QBO_VENDOR_PAY_BANK_ACCOUNT_ID</code>.</div>}
                  </div>
                )}

                {data.balance_error && (
                  <div className="text-[12px] rounded-lg p-3 border border-destructive/40 bg-destructive/10 text-destructive">
                    Stripe balance read failed: {data.balance_error}
                  </div>
                )}

                {data.unbooked > 0 && (
                  <div className="text-[12px] rounded-lg p-3 border border-destructive/40 bg-destructive/10 text-destructive">
                    {data.unbooked} settled funding event(s) not booked to QuickBooks — the two balances don't match. Reconcile below.
                  </div>
                )}

                {error && <div className="text-[13px] rounded-lg p-3 border border-destructive/40 bg-destructive/10 text-destructive">{error}</div>}
                {notice && <div className="text-[13px] rounded-lg p-3 border border-primary/30 bg-primary/10">{notice}</div>}

                {/* Top up */}
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-40">
                    <Label htmlFor="fund-amt" className="text-[12px]">Pull from bank</Label>
                    <Input
                      id="fund-amt" type="number" min="1" step="1" value={amount}
                      onChange={(e) => setAmount(e.target.value)} placeholder="0"
                    />
                  </div>
                  <Button size="sm" onClick={topUp} disabled={busy !== null || !data.configured || !data.bank_configured}>
                    {busy === 'top_up' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                    Top up
                  </Button>
                  <Button size="sm" variant="outline" onClick={sync} disabled={busy !== null || !data.configured}>
                    {busy === 'sync' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
                    Reconcile with QuickBooks
                  </Button>
                  <span className="text-[11px] text-muted-foreground pb-2">
                    {formatCurrency(data.pulled_today)} pulled today of a {formatCurrency(data.config.max_per_day)} cap
                    {' · '}Stripe caps one pull at {formatCurrency(data.max_per_txn)}
                  </span>
                </div>

                {/* Floor / target / automation */}
                <div className="flex flex-wrap items-end gap-2 pt-1 border-t border-border/60">
                  <div className="w-32">
                    <Label htmlFor="fund-floor" className="text-[12px]">Alert below</Label>
                    <Input id="fund-floor" type="number" min="0" step="100" value={floor} onChange={(e) => setFloor(e.target.value)} />
                  </div>
                  <div className="w-32">
                    <Label htmlFor="fund-target" className="text-[12px]">Top up to</Label>
                    <Input id="fund-target" type="number" min="1" step="100" value={target} onChange={(e) => setTarget(e.target.value)} />
                  </div>
                  <Button
                    size="sm" variant="outline" disabled={busy !== null}
                    onClick={() => saveConfig({ floor: Number(floor), target: Number(target) })}
                  >
                    {busy === 'config' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                    Save
                  </Button>
                  <label className="flex items-center gap-2 text-[12px] pb-2 cursor-pointer">
                    <input
                      type="checkbox" checked={data.config.auto_top_up} disabled={busy !== null}
                      onChange={(e) => {
                        if (e.target.checked && !window.confirm(
                          'Let the daily job pull money by itself when the balance falls below the floor?\n\n'
                          + `It will top up to ${formatCurrency(Number(target) || data.config.target)}, capped at `
                          + `${formatCurrency(data.config.max_per_day)} a day. You'll get an email either way.`,
                        )) return;
                        saveConfig({ auto_top_up: e.target.checked });
                      }}
                    />
                    Auto top-up when below the floor
                  </label>
                </div>

                {/* History */}
                {data.events.length > 0 && (
                  <div className="pt-2 border-t border-border/60 space-y-1.5">
                    <div className="text-[12px] font-semibold text-muted-foreground">Funding history</div>
                    {data.events.map((e) => {
                      const chip = fundingChip(e);
                      return (
                        <div key={e.id} className="flex items-center gap-2 text-[12px]">
                          <span className="font-semibold tabular-nums w-20 shrink-0">{formatCurrency(e.amount)}</span>
                          <Badge variant={chip.variant}>{chip.label}</Badge>
                          <span className="text-muted-foreground truncate">
                            {FUNDING_KIND_LABEL[e.kind]}
                            {e.source === 'app' ? '' : ' · from Stripe'}
                            {e.stripe_created_at || e.created_at ? ` · ${formatDate(e.stripe_created_at || e.created_at)}` : ''}
                            {e.initiated_by ? ` · ${e.initiated_by}` : ''}
                          </span>
                          {(e.book_error || e.failure_reason) && (
                            <span className="text-amber-500 truncate" title={e.book_error || e.failure_reason || ''}>
                              ⚠ {(e.book_error || e.failure_reason || '').slice(0, 60)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
