// Who has to approve this expense, and can this person approve it at all.
//
// The rule (Sky, 2026-09-02):
//   drivers and office staff approve up to $500
//   techs approve up to $800
//   Marco / Joel / Anthony V / Whitney are managers, up to $2,500
//   anything above $2,500 is Sky's
//   techs route to Anthony V · drivers route to Joel · office routes to Marco
//
// Two things this deliberately does NOT do.
//
// It does not let anyone approve their own spend above their own limit by
// walking the chain to themselves — the walk starts at the submitter's
// APPROVER, never at the submitter. A $2,400 expense from Marco is Sky's to
// approve, not Marco's, because "approve up to $2,500" is authority over the
// team's spending, not a self-service allowance.
//
// And it never silently drops an expense that nobody can approve. If the chain
// runs out, that is reported as a routing gap for a human to fix, not
// auto-approved and not left in a queue nobody owns — the failure mode that
// makes an approval limit worthless.

export const LIMITS_BY_JOB = Object.freeze({
  driver: 500,
  office: 500,
  tech: 800,
  manager: 2500,
  owner: null,      // unlimited
});

/**
 * Read an amount strictly.
 *
 * ⚠ `Number(null)` and `Number('')` are both 0, which is FINITE — so a plain
 * Number.isFinite() guard lets an expense whose amount we could not read sail
 * through as "$0, within your limit" and auto-approve. Caught by the test for
 * exactly that, and it is the same trap the bill rules hit: unknown is not
 * zero.
 */
function amountOf(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A person's limit; null means unlimited, 0 means "approves nothing". */
export function limitFor(person) {
  if (!person || person.active === false) return 0;
  if (person.approval_limit === null || person.approval_limit === undefined) {
    // Only an owner may be unlimited. A NULL on anyone else is a data fault,
    // and reading it as "unlimited" would turn a typo into a blank cheque.
    return person.job === 'owner' ? null : 0;
  }
  const n = Number(person.approval_limit);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Can this person sign off this amount? */
export function canApprove(person, amount) {
  const lim = limitFor(person);
  if (lim === null) return true;
  const amt = amountOf(amount);
  if (amt === null) return false;            // an unreadable amount is not "zero"
  return amt <= lim;
}

function index(people) {
  const by = new Map();
  for (const p of people || []) {
    if (p?.email) by.set(String(p.email).toLowerCase(), p);
  }
  return by;
}

/**
 * The approver chain ABOVE someone, nearest first. Cycle-guarded: a → b → a
 * must not loop, and the DB CHECKs only catch the self-referencing case.
 */
export function chainAbove(email, people) {
  const by = index(people);
  const seen = new Set();
  const out = [];
  let cur = by.get(String(email || '').toLowerCase());
  let guard = 0;
  while (cur && guard++ < 20) {
    const next = String(cur.approver_email || '').toLowerCase();
    if (!next || seen.has(next)) break;
    seen.add(next);
    const person = by.get(next);
    if (!person || person.active === false) break;
    out.push(person);
    cur = person;
  }
  return out;
}

/**
 * Where does this expense go?
 *
 * @returns {{autoApprove: boolean, approver: object|null, reason: string,
 *            limit: number|null, gap: boolean}}
 *   gap: true means nobody in the chain can approve it — surfaced, never
 *   auto-approved.
 */
export function routeForApproval({ amount, submitterEmail, people }) {
  const by = index(people);
  const me = by.get(String(submitterEmail || '').toLowerCase()) || null;
  const amt = amountOf(amount);
  const lim = limitFor(me);

  if (!me) {
    const owner = (people || []).find((p) => p.active !== false && limitFor(p) === null) || null;
    return {
      autoApprove: false, approver: owner, limit: 0, gap: !owner,
      reason: owner
        ? `${submitterEmail || 'This submitter'} is not on the Brixpense roster yet, so it needs sign-off.`
        : `${submitterEmail || 'This submitter'} is not on the Brixpense roster and nobody is set up to approve.`,
    };
  }

  // An unreadable amount must never auto-approve — unknown is not zero. This
  // is the same rule the bill rules follow for amount bounds.
  if (amt === null) {
    const up = chainAbove(me.email, people);
    const approver = up.find((p) => limitFor(p) === null) || up[0] || null;
    return {
      autoApprove: false, approver, limit: lim, gap: !approver,
      reason: 'The amount could not be read, so this needs a human to look at it.',
    };
  }

  if (lim === null || amt <= lim) {
    return {
      autoApprove: true, approver: null, limit: lim, gap: false,
      reason: lim === null
        ? 'Approved — no limit on this account.'
        : `Approved — $${amt.toFixed(2)} is within your $${Number(lim).toFixed(2)} limit.`,
    };
  }

  const up = chainAbove(me.email, people);
  const approver = up.find((p) => canApprove(p, amt)) || null;
  if (!approver) {
    return {
      autoApprove: false, approver: null, limit: lim, gap: true,
      reason: `$${amt.toFixed(2)} is over your $${Number(lim).toFixed(2)} limit and nobody above you can approve it. `
        + 'Set an approver on the Brixpense roster.',
    };
  }
  return {
    autoApprove: false, approver, limit: lim, gap: false,
    reason: `$${amt.toFixed(2)} is over your $${Number(lim).toFixed(2)} limit — sent to `
      + `${approver.full_name || approver.email} to approve.`,
  };
}
