// due-date.mjs — payment terms to a due date.
//
// A JS twin of ops.fn_due_date_from_terms. The two must agree: the database
// backfills historical rows, this fills new ones as they arrive, and a bill
// whose due date changes depending on which code path touched it last would
// make the aging report untrustworthy in exactly the way that matters.
//
// Deliberately conservative. Terms it does not recognise return null, because
// a WRONG due date is worse than no due date: no date shows as "no due date"
// and gets looked at, whereas a wrong one turns a genuinely overdue bill green.

/**
 * @param {string|null|undefined} isoDate  invoice date, YYYY-MM-DD
 * @param {string|null|undefined} terms    printed terms, verbatim
 * @returns {string|null} YYYY-MM-DD
 */
export function dueDateFromTerms(isoDate, terms) {
  if (!isoDate) return null;
  const t = String(terms || '').trim().toLowerCase();
  if (!t) return null;

  const base = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(base)) return null;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

  // Due on receipt / COD / prepaid — the invoice date IS the due date.
  if (/(due on receipt|due upon receipt|receipt|^cod$|cash on delivery|prepaid|^due now)/.test(t)) {
    return iso(base);
  }

  // Which number is the TERM. On "2/10 Net 30" the first number is a discount
  // percent and the second a discount window — taking either would make the
  // bill look due in days rather than a month, so the number after "net" wins
  // whenever there is one.
  const afterNet = t.match(/net\s*(\d{1,3})/);
  const first = t.match(/(\d{1,3})/);
  const n = Number((afterNet || first || [])[1]);

  // End-of-month terms: "Net 30 EOM" is 30 days from the end of the invoice
  // month, i.e. the same arithmetic as ops.fn_due_date_from_terms — first of
  // next month, plus N, minus a day. Bare "EOM" is the end of this month.
  if (/(eom|end of month|prox)/.test(t)) {
    const d = new Date(base);
    const firstOfNext = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    return iso(firstOfNext + ((Number.isFinite(n) ? n : 0) - 1) * 86_400_000);
  }

  if (!Number.isFinite(n) || n > 365) return null;   // not a term, a typo
  return iso(base + n * 86_400_000);
}

/**
 * What we should store, and where it came from. A date printed on the document
 * always beats one we computed — the vendor's own answer is the one that will
 * be argued about.
 * @returns {{ due_date: string|null, due_date_source: 'printed'|'terms'|null }}
 */
export function resolveDueDate({ printed, invoiceDate, terms } = {}) {
  const clean = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const p = clean(printed);
  if (p) return { due_date: p, due_date_source: 'printed' };
  const derived = dueDateFromTerms(clean(invoiceDate), terms);
  if (derived) return { due_date: derived, due_date_source: 'terms' };
  return { due_date: null, due_date_source: null };
}
