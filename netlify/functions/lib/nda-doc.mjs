// nda-doc.mjs — ONE source of truth for what an NDA says.
//
// The agreement text is stored on the template (and snapshotted onto every
// agreement) in a small markup that this file parses into blocks. Both
// renderers consume those blocks: the HTML the recipient reads on screen, and
// the PDF that gets filed and emailed. That matters more than it looks — if
// the screen and the PDF were rendered from two different sources, the thing
// somebody signed and the thing in the vault could quietly disagree, and the
// document is evidence, so they must be the same document.
//
// The markup, deliberately tiny so a non-engineer can edit a clause:
//
//   # Title line              → document title (usually supplied separately)
//   ## RECITALS               → centred section heading
//   1. **Purpose.** text…     → numbered section; the bold run is its lead-in
//   (a) text…                 → indented lettered sub-item
//   plain paragraph
//   [PARTIES]                 → the "entered into as of … by and between" block
//   [SIGNATURES]              → the two signature blocks
//   [EXHIBIT_A]               → the disclosure & sample log
//   **bold** inline anywhere
//
// Blocks are {type, text|runs, …}. Nothing here touches the database or the
// network, so it is trivially testable — see tests/nda.test.mjs.

/** Split a line into [{text, bold}] runs on **…** markers. */
export function parseRuns(line) {
  const runs = [];
  let rest = String(line ?? '');
  const re = /\*\*([^*]+)\*\*/;
  let m;
  while ((m = re.exec(rest))) {
    if (m.index > 0) runs.push({ text: rest.slice(0, m.index), bold: false });
    runs.push({ text: m[1], bold: true });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) runs.push({ text: rest, bold: false });
  return runs.length ? runs : [{ text: '', bold: false }];
}

// Markers a template may drop in for a block this parser cannot express in
// text — the parties preamble, the signature blocks, and the tables a
// particular agreement type fills in from its own structured terms. The
// parser only has to RECOGNISE a marker; each renderer decides what to draw
// for it, and an unknown one would otherwise print as a literal "[X]" in a
// signed document, which is why the set is shared rather than per-renderer.
//   NDA:              [PARTIES] [SIGNATURES] [EXHIBIT_A]
//   Sub-distribution: [PARTIES] [SIGNATURES] [FEE_SCHEDULE] [SERVICE_LEVELS]
export const MARKERS = new Set([
  '[PARTIES]', '[SIGNATURES]', '[EXHIBIT_A]', '[FEE_SCHEDULE]', '[SERVICE_LEVELS]',
]);

/** Parse the template markup into an ordered block list. */
export function parseNdaSource(source) {
  const blocks = [];
  const paras = String(source ?? '').replace(/\r\n/g, '\n').split(/\n\s*\n/);
  for (const raw of paras) {
    const para = raw.trim();
    if (!para) continue;
    const flat = para.replace(/\n\s*/g, ' ').trim();

    if (MARKERS.has(flat)) { blocks.push({ type: flat.slice(1, -1).toLowerCase() }); continue; }
    if (flat.startsWith('## ')) { blocks.push({ type: 'heading', text: flat.slice(3).trim() }); continue; }
    if (flat.startsWith('# ')) { blocks.push({ type: 'title', text: flat.slice(2).trim() }); continue; }

    // (a) … lettered sub-item
    const li = /^\(([a-z])\)\s+(.*)$/i.exec(flat);
    if (li) { blocks.push({ type: 'item', marker: `(${li[1]})`, runs: parseRuns(li[2]) }); continue; }

    // 12. **Lead-in.** body
    const num = /^(\d+)\.\s+(.*)$/.exec(flat);
    if (num) { blocks.push({ type: 'section', number: num[1], runs: parseRuns(num[2]) }); continue; }

    blocks.push({ type: 'para', runs: parseRuns(flat) });
  }
  return blocks;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const runsHtml = (runs) => (runs || []).map((r) => (r.bold ? `<b>${esc(r.text)}</b>` : esc(r.text))).join('');

/** Long-form date, always rendered in Pacific so the executed date on screen,
 *  in the PDF, and in the email are the same calendar day. */
export function longDate(d) {
  if (!d) return '';
  const dt = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T12:00:00Z') : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US',
    { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
}

export const COMPANY = {
  legalName: 'ALAMEDA POINT BEVERAGE GROUP, INC.',
  displayName: 'Alameda Point Beverage Group, Inc.',
  descriptor: 'a California corporation doing business as Brix Beverage and Alameda Soda Co.',
  address: '1951 Monarch Street, Suite 200, Alameda, California 94501',
};

/** A blank in the document: filled shows the value underlined, unfilled shows
 *  a rule. A live signing page and a printed blank are the same document. */
export const blank = (v, width = '16rem') => (v
  ? `<span class="fill">${esc(v)}</span>`
  : `<span class="fill empty" style="min-width:${width}"></span>`);

/** Describe the recipient the way the preamble reads. */
export function recipientDescriptor(a) {
  const bits = [];
  if (a.recipient_state) bits.push(a.recipient_state);
  if (a.recipient_entity_type) bits.push(a.recipient_entity_type);
  return bits.join(' ');
}

/** True when both sides disclose. Read from the agreement's OWN snapshot, never
 *  derived from a template code — a template that is later renamed or re-coded
 *  must not change how an executed agreement reads. */
export const isMutual = (a) => !!(a && a.mutual);

/** How the two sides are named in the document. In a one-way agreement the
 *  counterparty IS the Recipient; in a mutual one both are, so the defined
 *  terms move into section 1 and the preamble just names the parties. */
export function partyLabels(a) {
  return isMutual(a)
    ? { us: 'Brix', them: 'Counterparty', themHeading: 'COUNTERPARTY' }
    : { us: 'Company', them: 'Recipient', themHeading: 'RECIPIENT' };
}

/** Render the parties preamble. */
function partiesHtml(a) {
  const mutual = isMutual(a);
  const L = partyLabels(a);
  const kind = mutual ? 'Mutual Confidentiality and Non-Disclosure Agreement'
                      : 'Confidentiality and Non-Disclosure Agreement';
  return `<p>This ${kind} (this "Agreement") is entered into as of
    ${blank(longDate(a.effective_date), '12rem')} (the "Effective Date"), by and between:</p>
  <p class="party"><b>${esc(COMPANY.legalName)}</b>, ${esc(COMPANY.descriptor)}, with offices at
    ${esc(COMPANY.address)} ("${esc(L.us)}"); and</p>
  <p class="party">${blank(a.recipient_legal_name || a.recipient_company, '20rem')}, a
    ${blank(recipientDescriptor(a), '12rem')} with offices at
    ${blank(a.recipient_address, '22rem')} ("${esc(L.them)}").</p>
  <p>${esc(L.us)} and ${esc(L.them)} are each a "Party" and together the "Parties."${
    mutual ? ' Each Party may act as Discloser and as Recipient under this Agreement.' : ''}</p>`;
}

function signaturesHtml(a, opts = {}) {
  const img = (src, alt) => (src
    ? `<img class="sigimg" src="${esc(src)}" alt="${esc(alt)}">`
    : '<span class="sigline"></span>');
  return `<div class="sigs">
    <div class="sigbox">
      <div class="sigwho">${esc(partyLabels(a).us.toUpperCase())}</div>
      <div class="signm">Alameda Point Beverage Group, Inc.</div>
      ${img(a.company_signature_data || opts.companySignature, 'Company signature')}
      <div class="sigrow">By: ${blank(a.company_signer_name, '11rem')}</div>
      <div class="sigrow">Name: ${blank(a.company_signer_name, '11rem')}</div>
      <div class="sigrow">Title: ${blank(a.company_signer_title, '11rem')}</div>
      <div class="sigrow">Date: ${blank(longDate(a.company_signed_at), '11rem')}</div>
    </div>
    <div class="sigbox">
      <div class="sigwho">${esc(partyLabels(a).themHeading)}</div>
      <div class="signm">${a.recipient_legal_name || a.recipient_company
        ? esc(a.recipient_legal_name || a.recipient_company) : '<span class="sigline"></span>'}</div>
      ${img(a.signature_data, 'Recipient signature')}
      <div class="sigrow">By: ${blank(a.typed_name, '11rem')}</div>
      <div class="sigrow">Name: ${blank(a.signer_name, '11rem')}</div>
      <div class="sigrow">Title: ${blank(a.signer_title, '11rem')}</div>
      <div class="sigrow">Date: ${blank(longDate(a.signed_at), '11rem')}</div>
    </div>
  </div>`;
}

function exhibitHtml(a, log = []) {
  const rows = log.length
    ? log.map((r) => `<tr><td>${esc(longDate(r.disclosed_on))}</td><td>${esc(r.description)}</td>
        <td>${esc(r.format || '')}</td><td>${esc(r.delivered_by || '')}</td><td>${esc(r.quantity || '')}</td></tr>`).join('')
    : Array.from({ length: 6 }, () => '<tr><td></td><td></td><td></td><td></td><td></td></tr>').join('');
  return `<div class="exhibit">
    <h2>EXHIBIT A</h2>
    <h3>Disclosure and Sample Log</h3>
    <p>The Parties shall record below each item of Confidential Information and each Sample furnished by
      Company to Recipient. Failure to log an item does not remove it from the protections of this
      Agreement. This log is maintained for evidentiary convenience only.</p>
    <table class="logtable"><thead><tr><th>Date</th><th>Description of Material / Sample Disclosed</th>
      <th>Format</th><th>Delivered By</th><th>Qty</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="reps">Company representative: ${blank(a.company_signer_name, '14rem')}
      &nbsp;&nbsp;&nbsp; Recipient representative: ${blank(a.signer_name, '14rem')}</p>
  </div>`;
}

/**
 * Render the agreement to HTML for the signing page and the executed view.
 * `a` is the agreement row; opts.log is the Exhibit A rows; opts.companySignature
 * is an optional data URL for the company's signature image.
 */
export function renderNdaHtml(a, opts = {}) {
  const blocks = parseNdaSource(a.body_source);
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`<ol class="items">${list}</ol>`); list = null; } };

  for (const b of blocks) {
    if (b.type !== 'item') closeList();
    switch (b.type) {
      case 'title':      out.push(`<h1>${esc(b.text)}</h1>`); break;
      case 'heading':    out.push(`<h2>${esc(b.text)}</h2>`); break;
      case 'section':    out.push(`<p class="sec"><span class="secno">${esc(b.number)}.</span> ${runsHtml(b.runs)}</p>`); break;
      case 'item':       list = (list || '') + `<li><span class="mk">${esc(b.marker)}</span> ${runsHtml(b.runs)}</li>`; break;
      case 'para':       out.push(`<p>${runsHtml(b.runs)}</p>`); break;
      case 'parties':    out.push(partiesHtml(a)); break;
      case 'signatures': out.push(signaturesHtml(a, opts)); break;
      case 'exhibit_a':  out.push(exhibitHtml(a, opts.log || [])); break;
      default: break;
    }
  }
  closeList();
  return out.join('\n');
}
