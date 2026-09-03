// Self-billing: raising a supplier's invoice on their behalf.
//
// Origins Craft Soda does contract labour for us and does not issue invoices —
// they authorised us to raise them. Their expenses land from Service Fusion
// with an amount, a job number and a line item, and no bill number, which is
// exactly what the OCR gate holds a draft on. So the document that is missing
// is the one blocking the bill.
//
// Pure functions only: matching, numbering and the invoice model. The endpoint
// and the automatic hook both build the invoice through here, so a manually
// raised invoice and an automatic one cannot disagree about what the document
// says.

/** Would this profile claim this expense? */
export function matchesProfile(profile, expense) {
  if (!profile?.active) return false;
  if (!expense) return false;

  // A profile with no patterns claims NOTHING. The empty array must not read
  // as a wildcard — a half-configured profile silently invoicing every vendor
  // is the worst failure this code has available to it.
  const patterns = Array.isArray(profile.vendor_patterns) ? profile.vendor_patterns : [];
  if (!patterns.length && !profile.qbo_vendor_id) return false;

  // The QBO vendor id is the strong signal when we have it on both sides.
  if (profile.qbo_vendor_id && expense.qbo_vendor_id
      && String(profile.qbo_vendor_id) === String(expense.qbo_vendor_id)) return true;

  const name = String(expense.vendor_name || '').trim().toLowerCase();
  if (!name) return false;
  return patterns.some((p) => ilike(name, String(p || '').toLowerCase()));
}

/** SQL ILIKE semantics for one pattern: % is any run, _ is one character. */
export function ilike(value, pattern) {
  if (!pattern) return false;
  const rx = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '[\\s\\S]*')
    .replace(/_/g, '[\\s\\S]');
  return new RegExp(`^${rx}$`, 'i').test(value);
}

/** BX-0012 from prefix 'BX', separator '-', pad 4, n 12. */
export function formatInvoiceNumber(profile, n) {
  const pad = Math.min(Math.max(Number(profile?.number_pad ?? 4), 1), 10);
  return `${profile?.number_prefix ?? 'BX'}${profile?.number_separator ?? '-'}`
    + String(Math.max(0, Math.trunc(Number(n) || 0))).padStart(pad, '0');
}

const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * The lines the invoice carries.
 *
 * The expense's own line items are the truth when it has them — that is what
 * the work actually was, and re-describing it would make our invoice and our
 * bill say different things about the same job. Only when there are none do we
 * fall back to a single line, and it names the job so the supplier can tie it
 * to their own records.
 */
export function invoiceLines(expense) {
  const raw = Array.isArray(expense?.line_items) ? expense.line_items : [];
  const lines = raw
    .map((l) => {
      const qty = Number(l?.qty ?? 1) || 1;
      const amount = money(l?.amount ?? (Number(l?.unit_price || 0) * qty));
      const unit = money(l?.unit_price ?? (qty ? amount / qty : amount));
      const description = String(l?.description || '').trim();
      return { description, qty, unitPrice: unit, lineTotal: amount };
    })
    .filter((l) => l.description || l.lineTotal);

  if (lines.length) return lines;

  const total = money(expense?.total_amount);
  return [{
    description: expense?.job_number ? `Services rendered — job ${expense.job_number}` : 'Services rendered',
    qty: 1, unitPrice: total, lineTotal: total,
  }];
}

/**
 * Build the whole document model.
 *
 * ⚠ The TOTAL is the expense's own total, never the sum of the lines. They
 * should agree, and the caller is told when they don't — but the invoice we
 * send a partner has to equal the bill we are paying them, or we have created
 * a discrepancy rather than a record. A line that was rounded or a fee the
 * lines don't itemise must not silently change what we say we owe.
 */
export function buildInvoiceModel({ profile, expense, company, invoiceNumber, invoiceDate }) {
  if (!profile) throw new Error('a self-billing profile is required');
  if (!expense) throw new Error('an expense is required');

  const lines = invoiceLines(expense);
  const lineSum = money(lines.reduce((s, l) => s + l.lineTotal, 0));
  const total = money(expense.total_amount);

  const seller = {
    name: profile.seller_name,
    addr1: profile.seller_addr1,
    addr2: profile.seller_addr2,
    city_state_zip: profile.seller_city_state_zip,
    email: profile.seller_email,
    phone: profile.seller_phone,
  };
  // The buyer falls back to the company record so our address has one home.
  const buyer = {
    name: profile.buyer_name || company?.company_name,
    addr1: profile.buyer_addr1 || company?.company_addr1,
    addr2: profile.buyer_addr2 || company?.company_addr2,
    city_state_zip: profile.buyer_city_state_zip || company?.company_city_state_zip,
    email: profile.buyer_email || company?.company_email,
  };

  return {
    invoiceNumber,
    invoiceDate: invoiceDate || expense.receipt_date || new Date().toISOString().slice(0, 10),
    seller,
    buyer,
    lines,
    subtotal: total,
    total,
    jobNumber: expense.job_number || null,
    terms: profile.terms || null,
    footerNote: profile.footer_note || null,
    authorityNote: profile.authority_note || null,
    // Surfaced, not silently corrected — see the note above.
    lineMismatch: lineSum !== total ? { lineSum, total } : null,
  };
}

/** Who the invoice goes to. Deduped, lowercased, never empty-string entries. */
export function recipientsFor(profile) {
  const clean = (xs) => (Array.isArray(xs) ? xs : [])
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => e.includes('@'));
  const to = clean(profile?.send_to);
  const cc = clean(profile?.send_cc).filter((e) => !to.includes(e));
  return { to: [...new Set(to)], cc: [...new Set(cc)] };
}

/** Can this expense have an invoice raised for it right now? */
export function canRaise(expense, existing) {
  if (!expense) return { ok: false, reason: 'That expense is not on file.' };
  if (existing && !existing.voided_at) {
    return { ok: false, reason: `Invoice ${existing.invoice_number} already covers this expense.`, existing };
  }
  if (expense.archived_at) return { ok: false, reason: 'That expense is archived.' };
  const total = Number(expense.total_amount);
  // Unknown is not zero — the rule the approval ladder learned the hard way.
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, reason: 'That expense has no readable amount, so there is nothing to invoice.' };
  }
  return { ok: true, reason: '' };
}
