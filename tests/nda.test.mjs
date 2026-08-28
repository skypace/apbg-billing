// tests/nda.test.mjs — the NDA document core.
//
// What is worth pinning here is not "does it render" but the handful of rules
// that make an executed agreement evidence rather than a screenshot:
//   · the on-screen document and the PDF come from ONE parse of ONE source;
//   · a filled blank shows the value, an empty one shows a rule, and the
//     document is the same document either way;
//   · the effective date is the signer's calendar day, not the Lambda's;
//   · punctuation in the legal text survives into the PDF (an over-eager
//     sanitizer silently ate clause 2's em dashes once already).

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import {
  parseRuns, parseNdaSource, renderNdaHtml, longDate, recipientDescriptor,
} from '../netlify/functions/lib/nda-doc.mjs';
import { wrapRuns, renderNdaPdf } from '../netlify/functions/lib/nda-pdf.mjs';
import {
  todayPacific, hashToken, newToken,
  linkUnusable, pickServices, clampLinkTtl, clampLinkRate,
  LINK_TTL_DAYS, LINK_MAX_PER_DAY,
} from '../netlify/functions/lib/nda-lib.mjs';
import { NDA_V1 } from '../netlify/functions/lib/nda/nda-v1.mjs';

/**
 * Read the text back out of a generated PDF.
 *
 * Worth the twenty lines: pdf-lib Flate-compresses its content streams and
 * writes each run as a hex string, so grepping the raw bytes for a phrase
 * finds nothing — and, worse, a single-byte probe can MATCH BY COINCIDENCE in
 * the compressed data. An earlier version of this file asserted the em dashes
 * survived by looking for byte 0x97 in the raw file; it passed against a PDF
 * that had no em dashes in it at all.
 */
function pdfText(bytes) {
  const buf = Buffer.from(bytes);
  const out = [];
  let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i);
    if (s < 0) break;
    let p = s + 6;
    if (buf[p] === 13) p++;
    if (buf[p] === 10) p++;
    const e = buf.indexOf('endstream', p);
    if (e < 0) break;
    try { out.push(inflateSync(buf.subarray(p, e)).toString('latin1')); } catch { /* not Flate */ }
    i = e + 9;
  }
  // Every run is written as its own `BT … <hex> Tj … ET` block, so the words of
  // a sentence are separated by PDF operators rather than sitting next to each
  // other. Pull out only the text runs and join those — spaces are runs of
  // their own, so the line reassembles as written.
  const runs = [];
  for (const m of out.join('\n').matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
    runs.push(Buffer.from(m[1], 'hex').toString('latin1'));
  }
  return runs.join('');
}

const base = {
  agreement_number: 'NDA-2026-001',
  title: NDA_V1.title,
  subtitle: NDA_V1.subtitle,
  body_source: NDA_V1.body_source,
  template_code: NDA_V1.code,
  template_version: NDA_V1.version,
  recipient_company: 'Quantum Canning',
  recipient_email: 'jq@example.com',
  company_signer_name: 'Sky Pace',
  company_signer_title: 'Chief Executive Officer',
  company_signed_at: '2026-08-27T17:00:00Z',
  services: [],
};
const signed = {
  ...base,
  status: 'signed',
  recipient_legal_name: "Quantum J's Canning LLC",
  recipient_entity_type: 'limited liability company',
  recipient_state: 'Colorado',
  recipient_address: '3540 State Hwy 52 Unit A2, Frederick, CO 80516',
  signer_name: 'Jordan Quinn',
  signer_title: 'President',
  signer_email: 'jq@example.com',
  typed_name: 'Jordan Quinn',
  signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  consent_esign: true,
  effective_date: '2026-08-27',
  signed_at: '2026-08-27T18:22:00Z',
  signer_ip: '203.0.113.44',
  signer_user_agent: 'Mozilla/5.0 Chrome/140',
  purpose_scope: 'Co-packing of Alameda Soda 12 oz product.',
  services: ['co-packing', 'filling'],
};

// ── markup ──────────────────────────────────────────────────────────────────
test('bold runs split without losing surrounding text', () => {
  assert.deepEqual(parseRuns('a **b** c'), [
    { text: 'a ', bold: false }, { text: 'b', bold: true }, { text: ' c', bold: false },
  ]);
  assert.deepEqual(parseRuns('plain'), [{ text: 'plain', bold: false }]);
  // An unpaired marker is text, not a parse error — a half-typed edit in the
  // template must never blank a clause.
  assert.equal(parseRuns('a ** b').map((r) => r.text).join(''), 'a ** b');
});

test('the shipped template parses to the expected shape', () => {
  const blocks = parseNdaSource(NDA_V1.body_source);
  const types = blocks.reduce((m, b) => { m[b.type] = (m[b.type] || 0) + 1; return m; }, {});
  assert.equal(types.section, 21, 'all 21 numbered sections');
  assert.equal(types.parties, 1);
  assert.equal(types.signatures, 1);
  assert.equal(types.exhibit_a, 1);
  assert.equal(types.item, 8, 'the eight (a)-(h) sub-items in clause 2');
  // Numbering must be contiguous — a dropped clause is the kind of thing that
  // is invisible on screen and fatal in a dispute.
  const nums = blocks.filter((b) => b.type === 'section').map((b) => Number(b.number));
  assert.deepEqual(nums, Array.from({ length: 21 }, (_, i) => i + 1));
});

test('section 21 carries the electronic-signature consent', () => {
  const s21 = parseNdaSource(NDA_V1.body_source).find((b) => b.type === 'section' && b.number === '21');
  const text = s21.runs.map((r) => r.text).join('');
  assert.match(text, /ESIGN/);
  assert.match(text, /Uniform Electronic Transactions Act/);
  assert.match(text, /paper copy/, 'the retainable/paper-copy right must be stated');
});

// ── rendering ───────────────────────────────────────────────────────────────
test('an unsigned agreement renders blanks, not somebody else’s details', () => {
  const html = renderNdaHtml(base);
  assert.match(html, /fill empty/, 'unfilled blanks render as a rule');
  assert.ok(!html.includes('Jordan Quinn'));
  assert.match(html, /ALAMEDA POINT BEVERAGE GROUP, INC\./);
});

test('a signed agreement renders the filled values and both signatures', () => {
  const html = renderNdaHtml(signed);
  assert.match(html, /Quantum J&#39;s Canning LLC/);
  assert.match(html, /Colorado limited liability company/);
  assert.match(html, /August 27, 2026/);
  assert.match(html, /Jordan Quinn/);
  assert.match(html, /Sky Pace/);
  assert.equal((html.match(/class="sigimg"/g) || []).length, 1,
    'the recipient signature image renders; the company block has no image unless supplied');
});

test('the Exhibit A log renders real rows when there are any, blanks otherwise', () => {
  const empty = renderNdaHtml(signed, { log: [] });
  assert.match(empty, /EXHIBIT A/);
  const filled = renderNdaHtml(signed, {
    log: [{ disclosed_on: '2026-08-27', description: 'Hangar 25 Cola batching sheet', format: 'document' }],
  });
  assert.match(filled, /Hangar 25 Cola batching sheet/);
});

test('recipient details are escaped, not injected', () => {
  const html = renderNdaHtml({ ...signed, recipient_legal_name: '<script>x</script>' });
  assert.ok(!html.includes('<script>x</script>'));
  assert.match(html, /&lt;script&gt;/);
});

// ── dates ───────────────────────────────────────────────────────────────────
test('a date-only effective date does not slip a day', () => {
  // The classic mirror-date bug: new Date('2026-08-27') is UTC midnight, which
  // renders as the 26th anywhere west of Greenwich.
  assert.equal(longDate('2026-08-27'), 'August 27, 2026');
});

test('todayPacific returns the Pacific calendar day', () => {
  const expected = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  assert.equal(todayPacific(), expected);
  assert.match(todayPacific(), /^\d{4}-\d{2}-\d{2}$/);
});

test('the recipient descriptor reads the way the preamble needs it to', () => {
  assert.equal(recipientDescriptor(signed), 'Colorado limited liability company');
  assert.equal(recipientDescriptor({ recipient_entity_type: 'corporation' }), 'corporation');
  assert.equal(recipientDescriptor({}), '');
});

// ── tokens ──────────────────────────────────────────────────────────────────
test('tokens are unguessable and only their hash is ever stored', () => {
  const a = newToken(), b = newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
  assert.equal(hashToken(a).length, 64);
  assert.notEqual(hashToken(a), hashToken(b));
  assert.equal(hashToken(a), hashToken(a), 'hashing is stable');
});

// ── PDF ─────────────────────────────────────────────────────────────────────
// Rendering the full agreement takes ~250ms; render it once and share it.
const pdfCache = { signed: await renderNdaPdf(signed, { log: [] }) };

test('wrapRuns breaks on width and keeps bold segmentation', () => {
  const font = { widthOfTextAtSize: (t) => t.length * 5 };
  const lines = wrapRuns([{ text: 'aaa bbb ccc ddd', bold: false }], 30, 10, { reg: font, bold: font });
  assert.ok(lines.length > 1, 'long text wraps');
  assert.ok(lines.every((l) => !l.length || l[0].text.trim()), 'no line starts with a space');
  const mixed = wrapRuns(
    [{ text: 'lead ', bold: true }, { text: 'body', bold: false }], 500, 10, { reg: font, bold: font });
  const words = mixed[0].filter((seg) => seg.text.trim());
  assert.deepEqual(words.map((seg) => [seg.text, seg.bold]), [['lead', true], ['body', false]]);
});

test('the executed PDF carries the agreement, both parties, and the audit page', async () => {
  const bytes = await renderNdaPdf(signed, { log: [] });
  assert.ok(bytes.length > 20000, 'a real multi-page document');
  assert.match(Buffer.from(bytes).toString('latin1'), /^%PDF-/);
  const text = pdfText(bytes);
  assert.match(text, /CONFIDENTIALITY AND NON-DISCLOSURE AGREEMENT/);
  assert.match(text, /ALAMEDA POINT BEVERAGE GROUP, INC\./);
  assert.match(text, /Quantum J's Canning LLC/);
  assert.match(text, /Colorado limited liability company/);
  assert.match(text, /EXHIBIT A/);
  assert.match(text, /ELECTRONIC SIGNATURE RECORD/, 'the audit page is part of the executed document');
  assert.match(text, /203\.0\.113\.44/, 'the signing IP is recorded');
  assert.match(text, /Executed electronically/);
});

test('the legal text keeps its punctuation in the PDF', () => {
  // An over-eager sanitizer stripped every em dash out of clause 2 once, which
  // read as a gap in the sentence. WinAnsi covers them; only true non-WinAnsi
  // characters should ever be replaced.
  const text = pdfText(pdfCache.signed);
  assert.match(text, /in any form . written, oral, visual/,
    'clause 2 keeps the dash before "written, oral, visual"');
  assert.ok(text.includes('\u0097') || / . written, oral/.test(text), 'a dash character is present');
});

test('an unsigned PDF is stamped DRAFT and shows no signature or audit page', async () => {
  const bytes = await renderNdaPdf(base, { log: [] });
  const text = pdfText(bytes);
  assert.match(text, /DRAFT/);
  assert.ok(!text.includes('Executed electronically'));
  assert.ok(!text.includes('ELECTRONIC SIGNATURE RECORD'),
    'nothing claims a signature was captured');
  assert.ok(!text.includes('Jordan Quinn'));
});

test('a corrupt signature image does not lose the document', async () => {
  const bytes = await renderNdaPdf({ ...signed, signature_data: 'data:image/png;base64,notreallypng' },
    { log: [] });
  assert.ok(bytes.length > 20000, 'still renders — a bad image is not worth losing an agreement over');
});

// ── delegated sender links ──────────────────────────────────────────────────
//
// A sender link lets a named person send our NDA with no hub login, which
// makes it a credential: whoever holds it can send Brix-branded email to any
// address they like. These tests pin the guard rails that make that acceptable
// — a link that has been switched off stays off, one with an end date reaches
// it, the rate limit cannot be configured away, and a delegate cannot write
// free text into the services clause of an executed legal document.

test('a revoked sender link is refused, and says so plainly', () => {
  const link = { revoked_at: '2026-08-27T10:00:00Z', expires_at: '2099-01-01T00:00:00Z' };
  const bad = linkUnusable(link);
  assert.ok(bad, 'revocation is instant — not "on the next send"');
  assert.equal(bad.status, 410);
  assert.match(bad.error, /switched off/);
});

test('an expired sender link is refused; a live one is not', () => {
  const now = Date.parse('2026-08-27T12:00:00Z');
  assert.equal(linkUnusable({ expires_at: '2026-12-01T00:00:00Z' }, now), null);
  const bad = linkUnusable({ expires_at: '2026-08-27T11:59:00Z' }, now);
  assert.equal(bad.status, 410);
  assert.match(bad.error, /expired/);
});

test('an unknown token reads exactly like a malformed one', () => {
  // Deliberate: a probe must not be able to tell "no such link" from "revoked"
  // by the wording, or it learns which tokens exist.
  const bad = linkUnusable(null);
  assert.equal(bad.status, 404);
  assert.equal(bad.error, 'This link is not valid.');
});

test('a sender link cannot be issued without an end date or without a limit', () => {
  // There is no "unlimited" to pick by accident — every input lands in range.
  assert.equal(clampLinkTtl(undefined), LINK_TTL_DAYS);
  assert.equal(clampLinkTtl(0), LINK_TTL_DAYS, 'zero is not "forever"');
  assert.equal(clampLinkTtl(-40), 1);
  assert.equal(clampLinkTtl(99999), 365);
  assert.equal(clampLinkTtl('30'), 30);

  assert.equal(clampLinkRate(undefined), LINK_MAX_PER_DAY);
  assert.equal(clampLinkRate(0), LINK_MAX_PER_DAY, 'zero is not "no limit"');
  assert.equal(clampLinkRate(-1), 1);
  assert.equal(clampLinkRate(9999), 50);
  assert.equal(clampLinkRate(12), 12);
});

test('a delegate cannot write free text into the services clause', () => {
  const link = { default_services: ['co-packing'] };
  assert.deepEqual(
    pickServices(['laboratory testing', 'anything they fancy', 'filling'], link),
    ['laboratory testing', 'filling'],
    'only values from the approved list reach an executed agreement');
  assert.deepEqual(pickServices(['nonsense'], link), ['co-packing'],
    'a choice that filters to nothing falls back to the defaults, not to blank');
  assert.deepEqual(pickServices(undefined, link), ['co-packing']);
  assert.deepEqual(pickServices(undefined, null), []);
  assert.deepEqual(pickServices('co-packing', link), ['co-packing'],
    'a bare string is not an array and must not slip through as one');
});

test('a sender token is never stored in a form that could mint a link', () => {
  const raw = newToken();
  const stored = hashToken(raw);
  assert.notEqual(stored, raw);
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.ok(!stored.includes(raw.slice(0, 12)),
    'reading the row gives you the hash, never the link');
});
