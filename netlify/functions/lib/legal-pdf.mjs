// legal-pdf.mjs — the page engine every LEGAL document PDF is drawn with.
//
// Extracted from nda-pdf.mjs when the sub-distribution agreement needed the
// same treatment. It is deliberately the ENGINE only — page geometry, text
// wrapping with bold runs, the WinAnsi fallback, the letterhead, the signature
// embed and the fill-in-the-blank line. Which BLOCKS a document draws is the
// document's own business, because that is exactly where an NDA and a
// distribution agreement differ.
//
// ⚠ pdf-lib has no text layout. Wrapping, bold runs, page breaks and every
// table in these documents are done by hand here.
//
// ⚠ The standard-14 fonts encode WinAnsi, which DOES cover the punctuation
// these documents actually use — em dashes, curly quotes, ellipses. Stripping
// those wholesale (the first version of the NDA renderer did) silently gutted
// a clause's parenthetical dashes, and the test that was supposed to catch it
// grepped a Flate-compressed stream and matched by coincidence. sanitize()
// tries the whole string first and only falls back per character.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { BRIX_LOGO_PNG, ALAMEDA_LOGO_PNG, logoBytes } from './nda/nda-logos.mjs';
import { safeImageBytes } from './nda-image.mjs';

export { PDFDocument, StandardFonts, rgb };

export const PAGE_W = 612, PAGE_H = 792;
export const M_L = 72, M_R = 72, M_T = 72, M_B = 64;
export const BODY = 10, LEAD = 13.6, GAP = 7;
export const INK = rgb(0.05, 0.09, 0.16);
export const RULE = rgb(0.72, 0.77, 0.83);
export const NAVY = rgb(0.12, 0.31, 0.47);

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

// All four fonts used here are WinAnsi, so one memo table serves them.
const ENCODABLE = new Map();
const FALLBACK = { '→': '->', '←': '<-', '↔': '<->', '≤': '<=', '≥': '>=', '•': '-', '\u00a0': ' ' };

function canEncode(font, ch) {
  if (ENCODABLE.has(ch)) return ENCODABLE.get(ch);
  let ok = true;
  try { font.widthOfTextAtSize(ch, 10); } catch { ok = false; }
  ENCODABLE.set(ch, ok);
  return ok;
}

export function sanitize(s, font) {
  const str = String(s ?? '');
  if (!font) return str;
  try { font.widthOfTextAtSize(str, 10); return str; } catch { /* fall through */ }
  return Array.from(str).map((c) => (canEncode(font, c) ? c : (FALLBACK[c] ?? ''))).join('');
}

export class Doc {
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

export async function embedSignature(pdf, dataUrl) {
  // The structural check is NOT belt-and-braces around the try/catch — it is
  // the only thing that works. pdf-lib's PNG decoder spins forever on some
  // malformed files, synchronously, so neither a catch nor a timeout can save
  // us. See lib/nda-image.mjs.
  const img = safeImageBytes(dataUrl);
  if (!img) return null;
  try {
    return img.png ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
  } catch { return null; }   // a corrupt signature image must not lose the document
}

export function fillLine(doc, label, value, colX, colW) {
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

/** The four fonts every legal document here is set in. */
export async function embedFonts(pdf) {
  return {
    reg: await pdf.embedFont(StandardFonts.TimesRoman),
    bold: await pdf.embedFont(StandardFonts.TimesRomanBold),
    sans: await pdf.embedFont(StandardFonts.Helvetica),
    sansBold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
}

/** Both marks, centred, because the company that signs these trades as both
 *  brands. Best-effort: a document without its letterhead is still the
 *  document, and losing one over an image would be absurd. */
export async function drawLetterhead(pdf, doc) {
  try {
    const marks = [];
    for (const b64 of [BRIX_LOGO_PNG, ALAMEDA_LOGO_PNG]) {
      const bytes = logoBytes(b64);
      if (bytes) marks.push(await pdf.embedPng(bytes));
    }
    if (!marks.length) return;
    const H = 34, GAPX = 16;
    const widths = marks.map((m) => (m.width / m.height) * H);
    const total = widths.reduce((t, w) => t + w, 0) + GAPX * (marks.length - 1);
    let x = M_L + (doc.width - total) / 2;
    marks.forEach((m, i) => {
      doc.page.drawImage(m, { x, y: doc.y - H, width: widths[i], height: H });
      x += widths[i] + GAPX;
    });
    doc.y -= H + 14;
  } catch { /* letterhead is decoration; the document is the point */ }
}

/**
 * The footer every page carries: what this document is on the left, the page
 * count on the right, and — the load-bearing one — whether it has actually
 * been executed in the middle. A draft that does not say DRAFT on every page
 * is a draft somebody will treat as signed.
 */
export function drawFooters(doc, { left, executed }) {
  const { fonts } = doc;
  const total = doc.pages.length;
  const grey = rgb(0.42, 0.47, 0.53);
  doc.pages.forEach((pg, i) => {
    const right = `Page ${i + 1} of ${total}`;
    pg.drawLine({ start: { x: M_L, y: M_B - 14 }, end: { x: PAGE_W - M_R, y: M_B - 14 },
      thickness: 0.6, color: RULE });
    pg.drawText(sanitize(String(left ?? ''), fonts.sans).slice(0, 78),
      { x: M_L, y: M_B - 26, size: 7.5, font: fonts.sans, color: grey });
    const rw = fonts.sans.widthOfTextAtSize(right, 7.5);
    pg.drawText(right, { x: PAGE_W - M_R - rw, y: M_B - 26, size: 7.5, font: fonts.sans, color: grey });
    const stamp = executed ? 'Executed electronically' : 'DRAFT — not yet executed';
    const sw = fonts.sans.widthOfTextAtSize(stamp, 7.5);
    pg.drawText(stamp, { x: PAGE_W / 2 - sw / 2, y: M_B - 26, size: 7.5, font: fonts.sans, color: grey });
  });
}

/** A label/value fact list — the shape both audit pages are built from. */
export function drawFacts(doc, facts, { labelW = 190, size = 9 } = {}) {
  const { fonts } = doc;
  for (const [k, v] of facts) {
    doc.need(15);
    doc.page.drawText(sanitize(k, fonts.sansBold), { x: M_L, y: doc.y, size, font: fonts.sansBold, color: NAVY });
    const lines = wrapRuns([{ text: String(v ?? '—') }], doc.width - labelW, size,
      { reg: fonts.sans, bold: fonts.sansBold });
    lines.forEach((ln, i) => {
      let x = M_L + labelW;
      ln.forEach((seg) => {
        doc.page.drawText(sanitize(seg.text, fonts.sans), { x, y: doc.y, size, font: fonts.sans, color: INK });
        x += seg.w;
      });
      if (i < lines.length - 1) { doc.y -= 12; doc.need(12); }
    });
    doc.y -= 15;
  }
}
