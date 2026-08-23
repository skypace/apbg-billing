import { Badge } from '@/components/ui/badge';

// Two things about a bill that a list has to show but no existing column
// carries: is it late, and have we seen it before.
//
// One component so the answer reads identically on My Inbox, the Vendor Inbox
// and Expense History. A row that says "31 days late" in one place and nothing
// in another is worse than either.
//
// Props are the structural minimum rather than ExpenseRequest, because the
// Vendor Inbox renders a server-side PROJECTION of an expense, not the row
// itself. Typing against the full record would have forced a cast there, and a
// cast is how a field silently goes missing from a projection later.

export interface BillFlagFields {
  as_bill?: boolean | null;
  paid_at?: string | null;
  due_date?: string | null;
  duplicate_of?: string | null;
  duplicate_reason?: string | null;
  duplicate_cleared_by?: string | null;
}

/** Whole days past due. Both dates are calendar dates, so this is compared in
 *  UTC — the same rule the server-side view uses. A local-midnight parse would
 *  make a bill due today read as one day late for anyone west of UTC. */
export function daysOverdue(dueDate?: string | null): number | null {
  if (!dueDate) return null;
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due)) return null;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - due) / 86_400_000);
}

export function DueBadge({ request }: { request: BillFlagFields }) {
  // Only unpaid bills have a due date worth showing. Once it's paid the date
  // is history, and once it's a paid-expense receipt it never had one.
  if (!request.due_date || request.paid_at || !request.as_bill) return null;
  const n = daysOverdue(request.due_date);
  if (n === null) return null;

  if (n > 0) {
    return <Badge variant="destructive">{n} day{n === 1 ? '' : 's'} overdue</Badge>;
  }
  if (n === 0) return <Badge variant="warning">Due today</Badge>;
  if (n >= -7) return <Badge variant="warning">Due in {-n} day{n === -1 ? '' : 's'}</Badge>;
  return <Badge variant="secondary">Due {request.due_date}</Badge>;
}

export function DuplicateBadge({ request }: { request: BillFlagFields }) {
  if (!request.duplicate_of) return null;
  const cleared = !!request.duplicate_cleared_by;
  return (
    <Badge
      variant={cleared ? 'secondary' : 'warning'}
      title={request.duplicate_reason || undefined}
    >
      {cleared ? 'Duplicate — cleared' : 'Possible duplicate'}
    </Badge>
  );
}

/** The explanation under the row. Shown only while the flag is live, because
 *  once someone has decided it isn't a duplicate, restating the case for it is
 *  just noise. */
export function DuplicateNote({ request }: { request: BillFlagFields }) {
  if (!request.duplicate_of || !request.duplicate_reason) return null;
  return (
    <div className="text-xs text-amber-300/90 bg-amber-500/10 rounded px-2.5 py-1.5">
      {request.duplicate_cleared_by
        ? `Flagged as a possible duplicate (${request.duplicate_reason}) — cleared by ${request.duplicate_cleared_by}.`
        : `Possible duplicate — ${request.duplicate_reason}. Check before posting.`}
    </div>
  );
}
