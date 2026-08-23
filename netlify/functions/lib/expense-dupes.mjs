// expense-dupes.mjs — "have we already got this bill?"
//
// Shared by the two places it matters, which are deliberately different:
//
//   bill-email-process-background  advisory. A new emailed bill gets stamped
//                                  with what it looks like, and an EXACT match
//                                  drops it back to draft so a human looks
//                                  before it is one click from QuickBooks.
//
//   expense-request-link-bill      the real gate. This is where the QBO
//                                  transaction is actually created, so an
//                                  exact match REFUSES unless the caller says,
//                                  explicitly, that they have looked and it is
//                                  not a duplicate.
//
// Both call ops.fn_bill_duplicate_candidates, so the matching rules live in
// exactly one place — the database — and cannot drift between the automated
// path and the human one.
//
// Nothing here throws on failure. A duplicate check that cannot run must not
// stop a bill being filed or posted: the cost of a missed flag is a
// conversation, the cost of a lost invoice is a vendor calling about it.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Rows that no longer mean anything. A denied or cancelled expense is not
// something this bill is a duplicate OF — it is the reason someone re-sent it.
const DEAD_STATUSES = new Set(['denied', 'cancelled', 'canceled', 'rejected']);

function reasonFor(hit) {
  if (hit.match_kind === 'exact') {
    return `same vendor and bill #${hit.bill_number}${hit.qbo_bill_id ? ` — already in QuickBooks as Bill ${hit.qbo_bill_id}` : ''}`;
  }
  const amt = Number(hit.total_amount || 0).toFixed(2);
  return `same vendor and amount ($${amt}) around ${hit.receipt_date}${hit.qbo_bill_id ? ` — already in QuickBooks as Bill ${hit.qbo_bill_id}` : ''}`;
}

/**
 * @returns {Promise<null | {id, match_kind:'exact'|'likely', reason, posted, all}>}
 *   null when nothing plausible was found OR the check could not run.
 */
export async function findDuplicate({ vendor, bill_number, amount, date, job_number, exclude } = {}) {
  if (!vendor || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fn_bill_duplicate_candidates`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Content-Profile': 'ops',
        'Accept-Profile': 'ops',
      },
      body: JSON.stringify({
        p_vendor: vendor,
        p_bill_number: bill_number || null,
        p_amount: amount ?? null,
        p_date: date || null,
        p_exclude: exclude || null,
        p_job_number: job_number || null,
      }),
    });
    if (!res.ok) {
      console.warn('[dupes] check failed:', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const rows = (await res.json()) || [];
    const live = rows.filter((r) => !DEAD_STATUSES.has(String(r.status || '').toLowerCase()));
    if (!live.length) return null;

    // fn_bill_duplicate_candidates already orders exact matches first.
    const hit = live[0];
    return {
      id: hit.id,
      match_kind: hit.match_kind,
      reason: reasonFor(hit),
      posted: !!(hit.qbo_bill_id || hit.qbo_purchase_id),
      all: live,
    };
  } catch (e) {
    console.warn('[dupes] check errored (non-fatal):', e?.message || e);
    return null;
  }
}
