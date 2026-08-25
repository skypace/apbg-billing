// expense-rules.mjs — auto-populate rules for inbound bills.
//
// A rule MATCHES on what we can see about a bill (vendor, sender, text,
// amount) and SETS the coding a human would otherwise retype every month:
// department, entity, GL account, tag, job, owner.
//
// ⚠ A rule NEVER posts anything. Auto-populate fills the form; the bill still
// waits for a human to click Post to QuickBooks. That is the 2026-08-14 gate
// and a rule is not an exception to it — a rule that could post would turn
// "a vendor emailed us a PDF" into "a vendor wrote to our general ledger".
//
// Matching is deliberately boring and inspectable: case-insensitive substring
// on text fields, inclusive bounds on amount, ALL specified conditions must
// hold, lowest `priority` wins. No regex (a bad one in a config field is a
// support call nobody can debug), no scoring, no ML. When a bill is coded by a
// rule the rule id is stamped on the row, so "why does this have that account"
// is always answerable.

/** Case-insensitive "does haystack contain needle", null-safe. */
function has(haystack, needle) {
  if (!needle) return true;                       // no condition = no opinion
  const h = String(haystack ?? '').toLowerCase();
  const n = String(needle).trim().toLowerCase();
  return !!n && h.includes(n);
}

/**
 * Sender match. A bare domain ("acme.com") matches anyone at that domain; a
 * full address matches only that person. Substring matching on an address
 * would let "acme.com" match "notacme.com.evil.net", which is the sort of
 * thing a routing rule must not do.
 */
export function senderMatches(fromEmail, pattern) {
  if (!pattern) return true;
  const from = String(fromEmail ?? '').trim().toLowerCase();
  const p = String(pattern).trim().toLowerCase().replace(/^@/, '');
  if (!from) return false;
  if (p.includes('@')) return from === p;
  return from.split('@')[1] === p;
}

/** The text a `match_text` rule is allowed to look at. */
export function billHaystack(bill) {
  const lines = Array.isArray(bill.line_items)
    ? bill.line_items.map((l) => l?.description ?? '').join(' ')
    : '';
  return [bill.vendor, bill.subject, bill.memo, bill.bill_number, lines]
    .filter(Boolean).join(' \n ');
}

/** Does one rule match this bill? Returns the reasons, for the audit trail. */
export function ruleMatches(rule, bill) {
  if (!rule || rule.active === false || rule.archived_at) return null;
  const why = [];

  if (rule.match_vendor) {
    if (!has(bill.vendor, rule.match_vendor)) return null;
    why.push(`vendor contains "${rule.match_vendor}"`);
  }
  if (rule.match_sender) {
    if (!senderMatches(bill.from_email, rule.match_sender)) return null;
    why.push(`sender is ${rule.match_sender}`);
  }
  if (rule.match_text) {
    if (!has(billHaystack(bill), rule.match_text)) return null;
    why.push(`text contains "${rule.match_text}"`);
  }

  const amount = bill.total == null ? null : Number(bill.total);
  const hasBound = rule.match_min_amount != null || rule.match_max_amount != null;
  if (hasBound) {
    // A rule with an amount bound must not silently claim a bill whose amount
    // we never read — an un-OCR'd total is unknown, not zero.
    if (amount == null || !Number.isFinite(amount)) return null;
    if (rule.match_min_amount != null && amount < Number(rule.match_min_amount)) return null;
    if (rule.match_max_amount != null && amount > Number(rule.match_max_amount)) return null;
    why.push(`amount within ${rule.match_min_amount ?? '−∞'}–${rule.match_max_amount ?? '∞'}`);
  }

  if (!why.length) return null;   // belt and braces; the CHECK also forbids it
  return { rule, why };
}

/** The winning rule for a bill: lowest priority, then oldest. */
export function pickRule(rules, bill) {
  const hits = (rules || [])
    .map((r) => ruleMatches(r, bill))
    .filter(Boolean)
    .sort((a, b) => {
      const p = (a.rule.priority ?? 100) - (b.rule.priority ?? 100);
      if (p !== 0) return p;
      return String(a.rule.created_at ?? '').localeCompare(String(b.rule.created_at ?? ''));
    });
  return hits[0] ?? null;
}

/**
 * The fields a rule wants set. Only non-empty values, and only where the bill
 * doesn't already know better — an amount OCR'd off the actual document beats
 * anything a rule has to say, and the same goes for a vendor we could read.
 * A rule fills BLANKS; it does not overrule the document.
 */
export function applyRule(rule, bill) {
  const patch = {};
  const put = (col, val) => {
    if (val == null || String(val).trim() === '') return;
    patch[col] = typeof val === 'string' ? val.trim() : val;
  };

  put('department', rule.set_department);
  put('entity', rule.set_entity);
  put('tag', rule.set_tag);
  put('job_number', rule.set_job_number);
  put('customer_name', rule.set_customer_name);

  // GL coding: id and label travel together or not at all, otherwise a row
  // shows one account and posts to another.
  if (rule.set_cogs_account_id || rule.set_cogs_account_label) {
    put('cogs_account_id', rule.set_cogs_account_id);
    put('cogs_account_label', rule.set_cogs_account_label);
  }

  // The OCR'd memo describes THIS bill; a rule's memo is boilerplate. Only
  // use the rule's when the document gave us nothing.
  if (!bill.memo) put('memo', rule.set_memo);

  return patch;
}

/**
 * Recurring sanity check. A recurring rule knows roughly what the bill should
 * cost, so an amount well outside that is worth saying out loud — the classic
 * catch is a monthly service that silently triples.
 *
 * This never blocks anything. It returns a note for the reviewer.
 */
export function recurringNote(rule, bill) {
  if (!rule?.recurring) return null;
  const expected = rule.expected_amount == null ? null : Number(rule.expected_amount);
  const actual = bill.total == null ? null : Number(bill.total);
  const period = rule.recurring_period ? ` ${rule.recurring_period}` : '';

  if (expected == null || !Number.isFinite(expected) || expected === 0) {
    return `Recurring${period} bill (${rule.name}).`;
  }
  if (actual == null || !Number.isFinite(actual)) {
    return `Recurring${period} bill (${rule.name}) — expected about $${expected.toFixed(2)}, but no amount was read off this one.`;
  }
  const tol = Number(rule.amount_tolerance_pct ?? 10);
  const driftPct = Math.abs(actual - expected) / expected * 100;
  if (driftPct > tol) {
    const dir = actual > expected ? 'higher' : 'lower';
    return `⚠ Recurring${period} bill (${rule.name}) is ${driftPct.toFixed(0)}% ${dir} than usual — $${actual.toFixed(2)} vs the expected $${expected.toFixed(2)}.`;
  }
  return `Recurring${period} bill (${rule.name}) — in line with the usual $${expected.toFixed(2)}.`;
}
