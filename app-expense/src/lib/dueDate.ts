// Client mirror of netlify/functions/lib/due-date.mjs, which is itself a mirror
// of ops.fn_due_date_from_terms.
//
// Three copies is one more than anybody wants, and the reason each exists is
// different: the SQL backfills history, the Netlify copy stamps bills as they
// arrive, and this one fills the field while you type. The alternative here was
// a round-trip to the server to work out a date from "Net 30", which is a worse
// trade than a small duplicated function.
//
// The server copy is authoritative — it recomputes on save — so a drift here is
// self-correcting and visible rather than silent. tests/due-date.test.mjs pins
// all three to the same table of cases; add a case there before changing this.

export function dueDateFromTerms(isoDate?: string | null, terms?: string | null): string | null {
  if (!isoDate) return null;
  const t = String(terms || '').trim().toLowerCase();
  if (!t) return null;

  const base = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(base)) return null;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  if (/(due on receipt|due upon receipt|receipt|^cod$|cash on delivery|prepaid|^due now)/.test(t)) {
    return iso(base);
  }

  // "2/10 Net 30" — the first number is a discount percent, so the number
  // after "net" wins whenever there is one.
  const afterNet = t.match(/net\s*(\d{1,3})/);
  const first = t.match(/(\d{1,3})/);
  const n = Number((afterNet || first || [])[1]);

  if (/(eom|end of month|prox)/.test(t)) {
    const d = new Date(base);
    const firstOfNext = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    return iso(firstOfNext + ((Number.isFinite(n) ? n : 0) - 1) * 86_400_000);
  }

  if (!Number.isFinite(n) || n > 365) return null;
  return iso(base + n * 86_400_000);
}
