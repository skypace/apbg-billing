// The ONE lifecycle vocabulary for every expense list (Sky, 2026-08-25:
// "all expense inboxes and everything should have the same tabs").
//
//   Open           — a human still has something to do: attach the bill,
//                    submit, approve, post. (draft / pending / approved /
//                    awaiting_invoice)
//   Posted         — in QuickBooks, money still owed. Bills leave this tab
//                    with no clicks: the daily bill-paid-sync asks QuickBooks
//                    and stamps paid_at when the balance hits zero.
//   Paid & closed  — done, never needs another look: paid bills, posted
//                    Purchases (paid before they ever posted), and terminal
//                    states (denied, fulfilled PRs).
//
// One rule, one component — a page that needs different buckets is a sign the
// page wants something other than lifecycle tabs, not a reason to fork this.

export type LifecycleTab = 'open' | 'posted' | 'paid';

export const LIFECYCLE_TABS: { key: LifecycleTab; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'posted', label: 'Posted' },
  { key: 'paid', label: 'Paid & closed' },
];

export function lifecycleBucket(r: {
  status?: string | null;
  as_bill?: boolean | null;
  paid_at?: string | null;
}): LifecycleTab {
  const s = r.status || '';
  if (s === 'posted') {
    // paid_at is the decision (stamped by us at payment, or by bill-paid-sync
    // when QuickBooks reports the balance at zero). A posted Purchase
    // (as_bill === false) was paid before it ever posted.
    return r.as_bill === false || r.paid_at ? 'paid' : 'posted';
  }
  // Terminal states are closed — nothing will ever happen to them again.
  if (s === 'denied' || s === 'fulfilled') return 'paid';
  return 'open';
}
