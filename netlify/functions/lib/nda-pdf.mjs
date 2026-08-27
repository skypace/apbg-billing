// nda-pdf.mjs — renders an executed NDA to a real PDF with pdf-lib.
//
// This is the artefact of record: it is what gets emailed to both sides, filed
// in the compliance vault, and produced years later if anyone argues. So it is
// built from the SAME parsed blocks as the on-screen agreement (lib/nda-doc)
// rather than from a second copy of the text, and it carries a signature page
// plus an audit page recording how the signature was captured — a drawn
// squiggle on its own proves very little; the timestamp, IP, user agent and
// typed name are what make an electronic signature defensible.
//
// pdf-lib has no text layout, so the wrapping, bold runs, page breaks and the
// Exhibit A table are done here by hand.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { parseNdaSource, longDate, COMPANY, recipientDescriptor } from './nda-doc.mjs';

const PAGE_W = 612, PAGE_H = 792;
const M_L = 72, M_R = 72, M_T = 72, M_B = 64;
const BODY = 10, LEAD = 13.6, GAP = 7;
const INK = rgb(0.05, 0.09, 0.16);
const RULE = rgb(0.72, 0.77, 0.83);
const NAVY = rgb(0.12, 0.31, 0.47);

/** Wrap a run list into lines that fit `width`, keeping bold segmentation. */
export function wrapRuns(runs, width, size, fonts) {
  const lines = [];
  let line = [], used = 0;
  for (const run of runs || []) {
    const font = run.bold ? fonts.bold : fonts.reg;
    // Split on spaces but keep them attached so widths stay honest.
    const words = String(run.text).split(/(\s+)/).filter((w) => w !== '');
    for (const w of words) {
      const ww = font.widthOfTextAtSize(w, size);
      if (used + ww > width && line.length && w.trim()) { lines.push(line); line = []; used = 0; }
      if (!line.length && !w.trim()) continue;         // no leading spaces on a new line
      line.push({ text: w, bold: !!run.bold, w: ww });
      used += ww;
    }
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
}

// The standard-14 fonts encode WinAnsi, which DOES cover the punctuation this
// document actually uses — em dashes, curly quotes, ellipses. Stripping those
// wholesale (the first version of this file did) silently gutted clause 2's
// parenthetical dashes. So: try the whole string first, and only when pdf-lib
// refuses fall back to a per-character pass. All four fonts used here are
// WinAnsi, so one memo table serves them.
const ENCODABLE = new Map();
const FALLBACK = { '→': '->', '←': '<-', '↔': '<->', '≤': '<=', '≥': '>=', '•': '-', '\u00a0': ' ' };

function canEncode(font, ch) {
  if (ENCODABLE.has(ch)) return ENCODABLE.get(ch);
  let ok = true;
  try { font.widthOfTextAtSize(ch, 10); } catch { ok = false; }
  ENCODABLE.set(ch, ok);
  return ok;
}

function sanitize(s, font) {
  const str = String(s ?? '');
  if (!font) return str;
  try { font.widthOfTextAtSize(str, 10); return str; } catch { /* fall through */ }
  return Array.from(str).map((c) => (canEncode(font, c) ? c : (FALLBACK[c] ?? ''))).join('');
}

class Doc {
  constructor(pdf, fonts, meta) {
    this.pdf = pdf; this.fonts = fonts; this.meta = meta;
    this.pages = [];
    this.newPage();
  }
  newPage() {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - M_T;
    return this.page;
  }
  need(h) { if (this.y - h < M_B) this.newPage(); }
  get width() { return PAGE_W - M_L - M_R; }

  text(str, { size = BODY, bold = false, x = M_L, color = INK, align = 'left', width } = {}) {
    const font = bold ? this.fonts.bold : this.fonts.reg;
    const s = sanitize(str, font);
    let px = x;
    if (align === 'center') px = M_L + (width ?? this.width) / 2 - font.widthOfTextAtSize(s, size) / 2;
    this.page.drawText(s, { x: px, y: this.y, size, font, color });
  }
  /** Draw wrapped runs starting at the current y; indent applies to every line,
   *  hangIndent only to lines after the first. */
  runs(runList, { indent = 0, hang = 0, size = BODY, lead = LEAD } = {}) {
    const width = this.width - indent - hang;
    const lines = wrapRuns(runList, width, size, this.fonts);
    for (let i = 0; i < lines.length; i++) {
      this.need(lead);
      let x = M_L + indent + (i === 0 ? 0 : hang);
      for (const seg of lines[i]) {
        const font = seg.bold ? this.fonts.bold : this.fonts.reg;
        this.page.drawText(sanitize(seg.text, font), { x, y: this.y, size, font, color: INK });
        x += seg.w;
      }
      this.y -= lead;
    }
  }
  para(str, opts = {}) { this.runs([{ text: str, bold: !!opts.bold }], opts); }
  space(h = GAP) { this.y -= h; }
  rule(width) {
    this.need(6);
    this.page.drawLine({ start: { x: M_L, y: this.y }, end: { x: M_L + (width ?? this.width), y: this.y },
      thickness: 0.7, color: RULE });
    this.y -= 8;
  }
}

async function embedSignature(pdf, dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  try {
    return m[1].toLowerCase() === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  } catch { return null; }   // a corrupt signature image must not lose the document
}

function fillLine(doc, label, value, colX, colW) {
  const size = 9.5;
  const lab = `${label} `;
  doc.page.drawText(sanitize(lab, doc.fonts.reg), { x: colX, y: doc.y, size, font: doc.fonts.reg, color: INK });
  const lw = doc.fonts.reg.widthOfTextAtSize(lab, size);
  const vx = colX + lw;
  const vw = colW - lw;
  if (value) {
    doc.page.drawText(sanitize(String(value), doc.fonts.reg).slice(0, 42),
      { x: vx + 2, y: doc.y + 1.5, size, font: doc.fonts.reg, color: INK });
  }
  doc.page.drawLine({ start: { x: vx, y: doc.y - 2 }, end: { x: colX + colW, y: doc.y - 2 },
    thickness: 0.6, color: RULE });
  doc.y -= 17;
}

/**
 * Build the executed PDF. `a` is the agreement row, `log` the Exhibit A rows,
 * `companySignature` an optional data URL. Returns Uint8Array.
 */
export async function renderNdaPdf(a, { log = [], companySignature = null } = {}) {
  const pdf = await PDFDocument.create();
  const fonts = {
    reg: await pdf.embedFont(StandardFonts.TimesRoman),
    bold: await pdf.embedFont(StandardFonts.TimesRomanBold),
    sans: await pdf.embedFont(StandardFonts.Helvetica),
    sansBold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const doc = new Doc(pdf, fonts, a);

  // ── Title ────────────────────────────────────────────────────────────────
  doc.text(a.title || 'CONFIDENTIALITY AND NON-DISCLOSURE AGREEMENT', { size: 13.5, bold: true, align: 'center' });
  doc.y -= 16;
  if (a.subtitle) { doc.text(a.subtitle, { size: 10.5, align: 'center' }); doc.y -= 14; }
  doc.rule();
  doc.space(6);

  const blocks = parseNdaSource(a.body_source);
  const recipientName = a.recipient_legal_name || a.recipient_company || '';

  for (const b of blocks) {
    switch (b.type) {
      case 'title': break;                                  // drawn above
      case 'heading':
        doc.need(30); doc.space(6);
        doc.text(b.text, { size: 11, bold: true, align: 'center' });
        doc.y -= 18;
        break;
      case 'parties': {
        doc.runs([{ text: `This Confidentiality and Non-Disclosure Agreement (this "Agreement") is entered into as of ` },
                  { text: longDate(a.effective_date) || '____________________', bold: true },
                  { text: ' (the "Effective Date"), by and between:' }]);
        doc.space(4);
        doc.runs([{ text: COMPANY.legalName, bold: true },
                  { text: `, ${COMPANY.descriptor}, with offices at ${COMPANY.address} ("Company"); and` }],
                 { indent: 18 });
        doc.space(4);
        const desc = recipientDescriptor(a) || '____________________';
        doc.runs([{ text: recipientName || '______________________________', bold: true },
                  { text: `, a ${desc} with offices at ${a.recipient_address || '______________________________'} ("Recipient").` }],
                 { indent: 18 });
        doc.space(4);
        doc.para('Company and Recipient are each a "Party" and together the "Parties."');
        doc.space();
        break;
      }
      case 'section':
        doc.need(LEAD * 2);
        doc.runs([{ text: `${b.number}. `, bold: true }, ...b.runs]);
        doc.space();
        break;
      case 'item':
        doc.need(LEAD * 2);
        doc.runs([{ text: `${b.marker} ` }, ...b.runs], { indent: 24, hang: 16 });
        doc.space(4);
        break;
      case 'para':
        doc.runs(b.runs);
        doc.space();
        break;
      case 'signatures': {
        // Keep a signature block whole — a name on one page and its signature
        // on the next is exactly the ambiguity a signature page exists to avoid.
        doc.need(190);
        doc.space(10);
        const colW = (doc.width - 30) / 2;
        const cols = [M_L, M_L + colW + 30];
        const sigTop = doc.y;
        const recImg = await embedSignature(pdf, a.signature_data);
        const coImg = await embedSignature(pdf, companySignature);
        const blocks2 = [
          { who: 'COMPANY', name: COMPANY.displayName, img: coImg,
            by: a.company_signer_name, nm: a.company_signer_name,
            title: a.company_signer_title, date: longDate(a.company_signed_at) },
          { who: 'RECIPIENT', name: recipientName, img: recImg,
            by: a.typed_name, nm: a.signer_name, title: a.signer_title, date: longDate(a.signed_at) },
        ];
        let lowest = sigTop;
        blocks2.forEach((blk, i) => {
          doc.y = sigTop;
          const x = cols[i];
          doc.page.drawText(blk.who, { x, y: doc.y, size: 9, font: fonts.sansBold, color: NAVY });
          doc.y -= 13;
          doc.page.drawText(sanitize(blk.name || '', fonts.bold).slice(0, 46),
            { x, y: doc.y, size: 9.5, font: fonts.bold, color: INK });
          doc.y -= 34;
          if (blk.img) {
            const scale = Math.min(colW / blk.img.width, 30 / blk.img.height);
            doc.page.drawImage(blk.img, { x, y: doc.y, width: blk.img.width * scale, height: blk.img.height * scale });
          }
          doc.y -= 6;
          fillLine(doc, 'By:', blk.by, x, colW);
          fillLine(doc, 'Name:', blk.nm, x, colW);
          fillLine(doc, 'Title:', blk.title, x, colW);
          fillLine(doc, 'Date:', blk.date, x, colW);
          lowest = Math.min(lowest, doc.y);
        });
        doc.y = lowest - 6;
        break;
      }
      case 'exhibit_a': {
        doc.newPage();
        doc.text('EXHIBIT A', { size: 12.5, bold: true, align: 'center' }); doc.y -= 17;
        doc.text('Disclosure and Sample Log', { size: 10.5, align: 'center' }); doc.y -= 18;
        doc.para('The Parties shall record below each item of Confidential Information and each Sample furnished by Company to Recipient. Failure to log an item does not remove it from the protections of this Agreement. This log is maintained for evidentiary convenience only.');
        doc.space(10);
        const cols = [64, 232, 72, 92, 40];
        const heads = ['Date', 'Description of Material / Sample Disclosed', 'Format', 'Delivered By', 'Qty'];
        const drawRow = (cells, bold = false, h = 20) => {
          doc.need(h + 4);
          let x = M_L;
          cells.forEach((c, i) => {
            const f = bold ? fonts.bold : fonts.reg;
            const txt = sanitize(String(c ?? ''), f);
            // one line per cell, truncated — a log row is a pointer, not prose
            let t = txt;
            while (t && f.widthOfTextAtSize(t, 8.5) > cols[i] - 8) t = t.slice(0, -1);
            doc.page.drawText(t, { x: x + 4, y: doc.y, size: 8.5, font: f, color: INK });
            doc.page.drawRectangle({ x, y: doc.y - 7, width: cols[i], height: h,
              borderColor: RULE, borderWidth: 0.6 });
            x += cols[i];
          });
          doc.y -= h;
        };
        drawRow(heads, true);
        const rows = log.length
          ? log.map((r) => [longDate(r.disclosed_on), r.description, r.format, r.delivered_by, r.quantity])
          : Array.from({ length: 10 }, () => ['', '', '', '', '']);
        rows.forEach((r) => drawRow(r));
        doc.space(18);
        doc.need(40);
        const half = doc.width / 2 - 10;
        fillLine(doc, 'Company representative:', a.company_signer_name, M_L, half);
        doc.y += 17;
        fillLine(doc, 'Recipient representative:', a.signer_name, M_L + half + 20, half);
        break;
      }
      default: break;
    }
  }

  // ── Audit page — how this signature was captured ─────────────────────────
  if (a.signed_at) {
    doc.newPage();
    doc.text('ELECTRONIC SIGNATURE RECORD', { size: 12, bold: true, align: 'center' }); doc.y -= 16;
    doc.text(`${a.agreement_number}`, { size: 10, align: 'center' }); doc.y -= 18;
    doc.rule(); doc.space(4);
    doc.para('This page records how the Recipient\'s electronic signature was captured. It is generated automatically and forms part of the executed Agreement.');
    doc.space(10);
    const facts = [
      ['Agreement', a.agreement_number],
      ['Template', `${a.template_code} v${a.template_version}`],
      ['Recipient', recipientName],
      ['Signed by', `${a.signer_name || ''}${a.signer_title ? ', ' + a.signer_title : ''}`],
      ['Typed name (intent to sign)', a.typed_name],
      ['Signer email', a.signer_email || a.recipient_email],
      ['Consented to electronic records', a.consent_esign ? 'Yes' : 'No'],
      ['Signed at', a.signed_at ? new Date(a.signed_at).toISOString() + '  (' + longDate(a.signed_at) + ' Pacific)' : ''],
      ['Effective date', longDate(a.effective_date)],
      ['Signer IP address', a.signer_ip],
      ['Browser', (a.signer_user_agent || '').slice(0, 120)],
      ['Link sent to', a.sent_to || a.recipient_email],
      ['Link sent at', a.sent_at ? new Date(a.sent_at).toISOString() : ''],
      ['First opened', a.viewed_at ? new Date(a.viewed_at).toISOString() : 'not recorded'],
      ['Countersigned for Company by', `${a.company_signer_name || ''}${a.company_signer_title ? ', ' + a.company_signer_title : ''}`],
    ];
    for (const [k, v] of facts) {
      doc.need(15);
      doc.page.drawText(sanitize(k, fonts.sansBold), { x: M_L, y: doc.y, size: 9, font: fonts.sansBold, color: NAVY });
      const vLines = wrapRuns([{ text: String(v ?? '—') }], doc.width - 190, 9, { reg: fonts.sans, bold: fonts.sansBold });
      vLines.forEach((ln, i) => {
        let x = M_L + 190;
        ln.forEach((seg) => { doc.page.drawText(sanitize(seg.text, fonts.sans), { x, y: doc.y, size: 9, font: fonts.sans, color: INK }); x += seg.w; });
        if (i < vLines.length - 1) { doc.y -= 12; doc.need(12); }
      });
      doc.y -= 15;
    }
    doc.space(8);
    doc.para('The Purpose recorded for this Agreement:', { bold: true }); doc.space(2);
    doc.para(a.purpose_scope || 'Not specified.');
    if (Array.isArray(a.services) && a.services.length) {
      doc.space(6);
      doc.para('Services contemplated: ' + a.services.join(', '));
    }
  }

  // ── Footers ──────────────────────────────────────────────────────────────
  const total = doc.pages.length;
  doc.pages.forEach((pg, i) => {
    const left = `${a.agreement_number}  ·  ${recipientName || a.recipient_company}`;
    const right = `Page ${i + 1} of ${total}`;
    pg.drawLine({ start: { x: M_L, y: M_B - 14 }, end: { x: PAGE_W - M_R, y: M_B - 14 },
      thickness: 0.6, color: RULE });
    pg.drawText(sanitize(left, fonts.sans).slice(0, 78), { x: M_L, y: M_B - 26, size: 7.5, font: fonts.sans, color: rgb(0.42, 0.47, 0.53) });
    const rw = fonts.sans.widthOfTextAtSize(right, 7.5);
    pg.drawText(right, { x: PAGE_W - M_R - rw, y: M_B - 26, size: 7.5, font: fonts.sans, color: rgb(0.42, 0.47, 0.53) });
    const stamp = a.signed_at ? 'Executed electronically' : 'DRAFT — not yet executed';
    const sw = fonts.sans.widthOfTextAtSize(stamp, 7.5);
    pg.drawText(stamp, { x: PAGE_W / 2 - sw / 2, y: M_B - 26, size: 7.5, font: fonts.sans, color: rgb(0.42, 0.47, 0.53) });
  });

  return pdf.save();
}
