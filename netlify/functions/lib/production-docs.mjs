// production-docs — the printed documents of the production pipeline, rendered
// as real PDFs so they can be emailed as attachments and kept as sent.
//
//   renderPurchaseOrderPdf(payload)  → Uint8Array
//   renderBillOfLadingPdf(payload)   → Uint8Array
//   renderBatchSheetPdf(payload)     → Uint8Array
//
// They wear the same clothes as The Melt system's PO and BOL (melt-dashboard
// generate-po.mjs / generate-bol.mjs): both brand marks across the top, a red
// accent rule above and below the header, the company block left and the
// document number right, grey meta blocks with an accent left border, an
// accent-filled table header with zebra rows, a grand-total row in accent, a
// notes block, signature lines and a grey footer. One page kit, three
// documents, so the batch sheet cannot drift from the PO it travels with.
//
// PURE: payload in, bytes out. Nothing here reads a database or the network,
// which is what lets it be tested against a fixture and lets the function
// that calls it own every data decision.
//
// ⚠ Every string goes through winAnsi() before a font measures or draws it.
// pdf-lib's standard fonts are WinAnsi and THROW on a character outside it —
// and the wrap step measures text before drawing, so measuring raw text is the
// same crash one line earlier (the 2026-08-31 lesson). Vendor names, notes and
// ingredient names arrive from QuickBooks and batching sheets full of em
// dashes, smart quotes, ° and ₂.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { BRIX_LOGO_PNG, ALAMEDA_LOGO_PNG, logoBytes } from './nda/nda-logos.mjs';

const PAGE_W = 612, PAGE_H = 792;
const M = 36;                                  // 0.5in, the Melt BOL margin
const CONTENT_W = PAGE_W - 2 * M;
const INK   = rgb(0.10, 0.10, 0.10);
const MUTED = rgb(0.42, 0.45, 0.50);
const LIGHT = rgb(0.98, 0.98, 0.98);
const RULE  = rgb(0.92, 0.92, 0.92);
const WHITE = rgb(1, 1, 1);

export function accentRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
  if (!m) return rgb(0.863, 0.149, 0.149);     // #dc2626, the Melt red
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

const REPLACE = {
  '—': '-', '–': '-', '‒': '-', '‐': '-',
  '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"',
  '…': '...', '×': 'x', '•': '*', '→': '->', '←': '<-',
  '✓': 'v', '✔': 'v', '☑': '[x]', '☐': '[ ]', '‑': '-',
  '₂': '2', '₃': '3', '²': '2', '³': '3', ' ': ' ', ' ': ' ', ' ': ' ',
};
/** Reduce a string to what Helvetica (WinAnsi) can encode. Never throws. */
export function winAnsi(s) {
  if (s === null || s === undefined) return '';
  let out = '';
  for (const ch of String(s)) {
    if (REPLACE[ch] !== undefined) { out += REPLACE[ch]; continue; }
    const c = ch.codePointAt(0);
    if (c === 0x09 || c === 0x0a) { out += ' '; continue; }
    if (c < 0x20) continue;
    if (c <= 0x7e || (c >= 0xa0 && c <= 0xff)) { out += ch; continue; }
    // Latin-1 covers é, ü, ñ, °, ½ … anything past it is dropped rather than risked.
  }
  return out;
}

export function fmtMoney(n) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtQty(n, max = 3) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  return v.toLocaleString('en-US', { maximumFractionDigits: max });
}
export function fmtDate(d) {
  if (!d) return '';
  const s = String(d);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? s : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── The page kit ─────────────────────────────────────────────────────────────
class Doc {
  constructor(pdf, fonts, accent) {
    this.pdf = pdf; this.f = fonts; this.accent = accent;
    this.pages = 0; this.page = null; this.y = 0;
    this.footerText = '';
    this.newPage();
  }
  newPage() {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pages += 1;
    this.y = PAGE_H - M;
    return this.page;
  }
  /** Ensure `h` points remain; start a new page if not. */
  need(h) { if (this.y - h < M + 28) { this.finishPage(); this.newPage(); } }
  finishPage() {
    // Footer on every page: grey, centred, the Melt way.
    const t = winAnsi(this.footerText + (this.pages > 1 || true ? `  ·  page ${this.pages}` : ''));
    const w = this.f.reg.widthOfTextAtSize(t, 7.5);
    this.page.drawLine({ start: { x: M, y: M + 16 }, end: { x: PAGE_W - M, y: M + 16 }, thickness: 0.5, color: RULE });
    this.page.drawText(t, { x: (PAGE_W - w) / 2, y: M + 5, size: 7.5, font: this.f.reg, color: MUTED });
  }
  width(text, size, bold = false) { return (bold ? this.f.bold : this.f.reg).widthOfTextAtSize(winAnsi(text), size); }
  text(text, x, y, { size = 9, bold = false, color = INK, align = 'left', maxW = null } = {}) {
    let t = winAnsi(text);
    const font = bold ? this.f.bold : this.f.reg;
    if (maxW) t = this.clip(t, size, bold, maxW);
    const w = font.widthOfTextAtSize(t, size);
    const px = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.page.drawText(t, { x: px, y, size, font, color });
    return w;
  }
  clip(t, size, bold, maxW) {
    const font = bold ? this.f.bold : this.f.reg;
    if (font.widthOfTextAtSize(t, size) <= maxW) return t;
    let s = t;
    while (s.length > 1 && font.widthOfTextAtSize(s + '…'.replace('…', '...'), size) > maxW) s = s.slice(0, -1);
    return s.trimEnd() + '...';
  }
  wrap(text, size, bold, maxW) {
    const font = bold ? this.f.bold : this.f.reg;
    const words = winAnsi(text).split(/\s+/).filter(Boolean);
    const lines = []; let line = '';
    for (const w of words) {
      const cand = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(cand, size) <= maxW) { line = cand; continue; }
      if (line) lines.push(line);
      // a single over-long token is clipped rather than allowed to overflow
      line = font.widthOfTextAtSize(w, size) <= maxW ? w : this.clip(w, size, bold, maxW);
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }
  /** Draw wrapped text at the cursor; returns height used. */
  para(text, { size = 9, bold = false, color = INK, x = M, maxW = CONTENT_W, lead = null } = {}) {
    const lines = this.wrap(text, size, bold, maxW);
    const lh = lead ?? size * 1.4;
    for (const ln of lines) {
      this.need(lh);
      this.y -= lh;
      this.text(ln, x, this.y, { size, bold, color });
    }
    return lines.length * lh;
  }
  rect(x, y, w, h, color, { border = null, bw = 1 } = {}) {
    this.page.drawRectangle({ x, y, width: w, height: h, color, borderColor: border ?? undefined, borderWidth: border ? bw : 0 });
  }
  hr(y, color = this.accent, thickness = 3) {
    this.page.drawLine({ start: { x: M, y }, end: { x: PAGE_W - M, y }, thickness, color });
  }

  // ── Brand bar: Brix left, Alameda Soda right ──────────────────────────────
  async brandBar() {
    const H = 40;
    try {
      const marks = [];
      for (const b64 of [BRIX_LOGO_PNG, ALAMEDA_LOGO_PNG]) {
        const bytes = logoBytes(b64);
        if (bytes) marks.push(await this.pdf.embedPng(bytes));
      }
      if (marks[0]) {
        const w = (marks[0].width / marks[0].height) * H;
        this.page.drawImage(marks[0], { x: M, y: this.y - H, width: w, height: H });
      }
      if (marks[1]) {
        const w = (marks[1].width / marks[1].height) * H;
        this.page.drawImage(marks[1], { x: PAGE_W - M - w, y: this.y - H, width: w, height: H });
      }
    } catch { /* letterhead is decoration; the document is the point */ }
    this.y -= H + 10;
  }

  // ── Header strip: company left, document title + number right ────────────
  header({ company, title, number, dateLines = [] }) {
    this.hr(this.y, this.accent, 3);
    this.y -= 14;
    const top = this.y;
    // company
    let y = top - 12;
    // The legal name is long ("… Dba Alameda Point Beverage Group"); it wraps
    // onto a second line rather than being clipped -- it is the party to the PO.
    for (const ln of this.wrap(company.name, 13, true, CONTENT_W - 250)) {
      this.text(ln, M, y, { size: 13, bold: true });
      y -= 15;
    }
    y += 2;
    const addr = [
      [company.addr1, company.addr2].filter(Boolean).join(' '),
      company.city_state_zip,
      [company.phone, company.email, company.web].filter(Boolean).join('  ·  '),
    ].filter(Boolean);
    for (const ln of addr) { this.text(ln, M, y, { size: 8.5, color: rgb(0.27, 0.27, 0.27) }); y -= 11; }
    // meta, right-aligned
    const rx = PAGE_W - M;
    let ry = top - 10;
    this.text(String(title).toUpperCase(), rx, ry, { size: 8.5, bold: true, color: this.accent, align: 'right' });
    ry -= 22;
    this.text(number, rx, ry, { size: 20, bold: true, align: 'right' });
    ry -= 13;
    for (const ln of dateLines) { this.text(ln, rx, ry, { size: 8.5, color: rgb(0.33, 0.33, 0.33), align: 'right' }); ry -= 11; }
    this.y = Math.min(y, ry) - 4;
    this.hr(this.y, this.accent, 3);
    this.y -= 16;
  }

  // ── Meta blocks: grey boxes with an accent left border ────────────────────
  metaBlocks(blocks) {
    const gap = 10;
    const n = blocks.length;
    const w = (CONTENT_W - gap * (n - 1)) / n;
    // measure
    const size = 8.5, lh = 11.5;
    let maxLines = 0;
    const prepared = blocks.map((b) => {
      const lines = [];
      for (const ln of b.lines || []) {
        const txt = typeof ln === 'string' ? ln : ln.text;
        const bold = typeof ln === 'object' && !!ln.bold;
        const muted = typeof ln === 'object' && !!ln.muted;
        for (const w2 of this.wrap(txt, size, bold, w - 20)) lines.push({ text: w2, bold, muted });
      }
      maxLines = Math.max(maxLines, lines.length);
      return { label: b.label, lines };
    });
    const h = 22 + maxLines * lh + 6;
    this.need(h + 8);
    const y0 = this.y - h;
    prepared.forEach((b, i) => {
      const x = M + i * (w + gap);
      this.rect(x, y0, w, h, LIGHT);
      this.rect(x, y0, 3, h, this.accent);
      this.text(String(b.label).toUpperCase(), x + 12, this.y - 12, { size: 6.5, bold: true, color: this.accent });
      let ly = this.y - 24;
      for (const ln of b.lines) {
        this.text(ln.text, x + 12, ly, { size: ln.bold ? 9.5 : size, bold: ln.bold, color: ln.muted ? MUTED : INK, maxW: w - 20 });
        ly -= lh;
      }
    });
    this.y = y0 - 14;
  }

  // ── Table with accent header, zebra rows, repeated header on page break ──
  table({ columns, rows, emptyText = 'No lines' }) {
    const size = 8.5, hsize = 7, pad = 6, lh = 11;
    const totalSpec = columns.reduce((t, c) => t + (c.width || 0), 0);
    const flex = columns.filter((c) => !c.width).length;
    const flexW = flex ? Math.max(60, (CONTENT_W - totalSpec) / flex) : 0;
    const widths = columns.map((c) => c.width || flexW);
    const xs = []; let acc = M; for (const w of widths) { xs.push(acc); acc += w; }

    const drawHeader = () => {
      const hh = 20;
      this.need(hh + lh + 6);
      this.rect(M, this.y - hh, CONTENT_W, hh, this.accent);
      columns.forEach((c, i) => {
        const label = winAnsi(String(c.label).toUpperCase());
        const tx = c.align === 'right' ? xs[i] + widths[i] - pad : c.align === 'center' ? xs[i] + widths[i] / 2 : xs[i] + pad;
        this.text(label, tx, this.y - 13, { size: hsize, bold: true, color: WHITE, align: c.align || 'left' });
      });
      this.y -= hh;
    };
    drawHeader();

    if (!rows.length) {
      this.need(24);
      this.y -= 16;
      this.text(emptyText, M + CONTENT_W / 2, this.y, { size, color: MUTED, align: 'center' });
      this.y -= 8;
      return;
    }

    rows.forEach((row, ri) => {
      // measure: each cell may wrap; sub-rows (detail) render beneath
      const cells = columns.map((c, i) => {
        const v = row[c.key];
        const txt = c.format ? c.format(v, row) : (v === null || v === undefined ? '' : String(v));
        return this.wrap(txt, size, !!c.bold, widths[i] - 2 * pad);
      });
      const detail = (row._detail || []).map((d) => winAnsi(d));
      const nLines = Math.max(...cells.map((c) => c.length));
      const h = nLines * lh + 2 * pad + (detail.length ? detail.length * 10 + 4 : 0);
      if (this.y - h < M + 28) { this.finishPage(); this.newPage(); drawHeader(); }
      if (ri % 2 === 1) this.rect(M, this.y - h, CONTENT_W, h, LIGHT);
      columns.forEach((c, i) => {
        const tx = c.align === 'right' ? xs[i] + widths[i] - pad : c.align === 'center' ? xs[i] + widths[i] / 2 : xs[i] + pad;
        let ly = this.y - pad - size;
        for (const ln of cells[i]) {
          this.text(ln, tx, ly, { size, bold: !!c.bold, color: c.accent ? this.accent : INK, align: c.align || 'left' });
          ly -= lh;
        }
      });
      if (detail.length) {
        let ly = this.y - pad - nLines * lh - 8;
        for (const d of detail) {
          this.text(d, xs[1] + pad + 10, ly, { size: 7.5, color: MUTED, maxW: CONTENT_W - (xs[1] - M) - 30 });
          ly -= 10;
        }
      }
      this.page.drawLine({ start: { x: M, y: this.y - h }, end: { x: PAGE_W - M, y: this.y - h }, thickness: 0.5, color: RULE });
      this.y -= h;
    });
    this.y -= 4;
  }

  totals(rows) {
    // rows: [{label, value, grand?}]
    const w = 220, x = PAGE_W - M - w;
    this.need(rows.length * 22 + 10);
    this.y -= 6;
    for (const r of rows) {
      const h = r.grand ? 24 : 18;
      if (r.grand) this.rect(x, this.y - h, w, h, this.accent);
      const color = r.grand ? WHITE : MUTED;
      this.text(r.label, x + 12, this.y - h + (r.grand ? 8 : 5), { size: r.grand ? 10 : 8.5, bold: !!r.grand, color });
      this.text(r.value, x + w - 12, this.y - h + (r.grand ? 8 : 5), { size: r.grand ? 11 : 9, bold: true, color: r.grand ? WHITE : INK, align: 'right' });
      this.y -= h;
    }
    this.y -= 10;
  }

  notes(label, text) {
    if (!text) return;
    const lines = this.wrap(text, 8.5, false, CONTENT_W - 26);
    const h = 22 + lines.length * 11.5 + 6;
    this.need(h + 6);
    const y0 = this.y - h;
    this.rect(M, y0, CONTENT_W, h, LIGHT);
    this.rect(M, y0, 3, h, this.accent);
    this.text(String(label).toUpperCase(), M + 12, this.y - 12, { size: 6.5, bold: true, color: this.accent });
    let ly = this.y - 24;
    for (const ln of lines) { this.text(ln, M + 12, ly, { size: 8.5 }); ly -= 11.5; }
    this.y = y0 - 14;
  }

  smallPrint(text) {
    this.need(30);
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: PAGE_W - M, y: this.y }, thickness: 0.5, color: RULE });
    this.y -= 6;
    this.para(text, { size: 7.5, color: MUTED, lead: 10.5 });
    this.y -= 6;
  }

  signatures(labels, { sub = [] } = {}) {
    const n = labels.length, gap = 24;
    const w = (CONTENT_W - gap * (n - 1)) / n;
    this.need(46);
    this.y -= 30;
    labels.forEach((lbl, i) => {
      const x = M + i * (w + gap);
      this.page.drawLine({ start: { x, y: this.y }, end: { x: x + w, y: this.y }, thickness: 1, color: INK });
      this.text(String(lbl).toUpperCase(), x, this.y - 10, { size: 7, bold: true, color: rgb(0.33, 0.33, 0.33) });
      if (sub[i]) this.text(sub[i], x, this.y - 20, { size: 7, color: MUTED, maxW: w });
    });
    this.y -= 30;
  }
}

async function open(accentHex) {
  const pdf = await PDFDocument.create();
  const fonts = {
    reg: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  return { pdf, doc: new Doc(pdf, fonts, accentRgb(accentHex)) };
}

function addressLines(a) {
  if (!a) return [];
  return [
    [a.addr1, a.addr2].filter(Boolean).join(', '),
    a.city_state_zip || [a.city, a.state].filter(Boolean).join(', ') + (a.postal_code ? ' ' + a.postal_code : ''),
    a.contact ? `Attn: ${a.contact}` : null,
    a.phone, a.email,
  ].filter((s) => s && String(s).trim() && String(s).trim() !== ',');
}

// ── Purchase order ───────────────────────────────────────────────────────────
export async function renderPurchaseOrderPdf(p) {
  const { pdf, doc } = await open(p.accent);
  pdf.setTitle(`Purchase Order ${p.poNumber}`);
  pdf.setProducer('Refractor · production');
  doc.footerText = `${p.company.name}  ·  PO ${p.poNumber}  ·  Generated ${new Date().toLocaleString('en-US')}`;

  await doc.brandBar();
  doc.header({
    company: p.company, title: 'Purchase Order', number: p.poNumber,
    dateLines: [
      `Issued ${fmtDate(p.issued)}`,
      p.expected ? `Expected ${fmtDate(p.expected)}` : null,
      p.workOrder ? `Work order ${p.workOrder.batch}` : null,
    ].filter(Boolean),
  });

  doc.metaBlocks([
    { label: 'Vendor', lines: [{ text: p.vendor?.name || '-', bold: true }, ...addressLines(p.vendor),
        p.vendor?.terms ? { text: `Terms: ${p.vendor.terms}`, muted: true } : null].filter(Boolean) },
    { label: 'Ship to', lines: [{ text: p.shipTo?.name || p.company.name, bold: true }, ...addressLines(p.shipTo)] },
    { label: 'Bill to', lines: [{ text: p.company.name, bold: true },
        ...addressLines({ addr1: p.company.addr1, addr2: p.company.addr2, city_state_zip: p.company.city_state_zip, email: p.company.email }),
        p.workOrder ? { text: `For ${fmtQty(p.workOrder.cases, 0)} cases · ${p.workOrder.flavour}`, muted: true } : null].filter(Boolean) },
  ]);

  doc.table({
    columns: [
      { key: 'itemNo', label: 'Item', width: 90, bold: true, accent: true },
      { key: 'description', label: 'Description' },
      { key: 'qty', label: 'Qty', width: 70, align: 'right', format: (v, r) => `${fmtQty(v)}${r.uom ? ' ' + r.uom : ''}` },
      { key: 'unitCost', label: 'Unit cost', width: 80, align: 'right', format: (v) => fmtMoney(v) },
      { key: 'lineTotal', label: 'Line total', width: 90, align: 'right', bold: true, format: (v) => fmtMoney(v) },
    ],
    rows: p.lines.map((l) => ({ ...l, _detail: l.detail?.map((d) => `${d.name}  ·  ${fmtQty(d.qty)} ${d.uom || ''}${d.note ? '  ·  ' + d.note : ''}`) })),
  });

  doc.totals([
    { label: 'Subtotal', value: fmtMoney(p.subtotal) },
    { label: 'Total', value: fmtMoney(p.total ?? p.subtotal), grand: true },
  ]);

  if (p.lines.some((l) => l.detail?.length)) {
    doc.notes('About the indented lines',
      'The indented quantities under a flavour line are the ingredients that go into it — what to batch, not what to invoice. Bill the flavour line at the price shown; the breakdown is for your batching and our records.');
  }
  doc.notes('Notes / special instructions', p.notes);

  doc.smallPrint(
    `Terms & Conditions: This Purchase Order is issued by ${p.company.name} ("Buyer") to the Vendor named above. Vendor agrees to deliver the goods and services listed at the prices shown, on or before the expected date. Substitutions, back-orders or price changes must be approved in writing by Buyer before shipment. Goods are subject to inspection and acceptance on receipt; non-conforming goods may be returned at Vendor's expense. Invoices must reference PO ${p.poNumber} to be paid.`);

  doc.signatures(['Authorized buyer signature', 'Date']);
  doc.finishPage();
  return pdf.save();
}

// ── Bill of lading ───────────────────────────────────────────────────────────
export async function renderBillOfLadingPdf(p) {
  const { pdf, doc } = await open(p.accent);
  pdf.setTitle(`Bill of Lading ${p.bolNumber}`);
  pdf.setProducer('Refractor · production');
  doc.footerText = `${p.company.name}  ·  BOL ${p.bolNumber}  ·  ${String(p.status || '').replace('_', ' ')}  ·  Generated ${new Date().toLocaleString('en-US')}`;

  await doc.brandBar();
  doc.header({
    company: p.company, title: 'Bill of Lading', number: p.bolNumber,
    dateLines: [
      `Issued ${fmtDate(p.issued)}`,
      p.shipDate ? `Ship date ${fmtDate(p.shipDate)}` : null,
      p.workOrder ? `Work order ${p.workOrder.batch}` : null,
    ].filter(Boolean),
  });

  doc.metaBlocks([
    { label: 'Shipper (from)', lines: [{ text: p.shipper?.name || '-', bold: true }, ...addressLines(p.shipper)] },
    { label: 'Consignee (ship to)', lines: [{ text: p.consignee?.name || '-', bold: true }, ...addressLines(p.consignee)] },
    { label: 'Carrier & freight', lines: [
        { text: p.carrier || 'Carrier: ________________', bold: !!p.carrier },
        p.pro ? `PRO # ${p.pro}` : null,
        p.tracking ? `Tracking ${p.tracking}` : null,
        p.freightTerms ? `Freight terms: ${String(p.freightTerms).replace('_', ' ')}` : null,
        p.declaredValue != null ? `Declared value ${fmtMoney(p.declaredValue)}` : null,
      ].filter(Boolean) },
  ]);

  // stat strip: pieces / weight / pallets (+ lots, when the shipment carries them)
  const totalQty = p.lines.reduce((t, l) => t + (Number(l.qty) || 0), 0);
  const hasLots = p.lines.some((l) => l.lot);
  doc.metaBlocks([
    { label: 'Lines', lines: [{ text: String(p.lines.length), bold: true }] },
    { label: 'Total units', lines: [{ text: fmtQty(totalQty, 0), bold: true }] },
    { label: 'Total weight', lines: [{ text: p.weight != null ? `${fmtQty(p.weight, 0)} lbs` : '-', bold: true }] },
    hasLots
      ? { label: 'Lots', lines: [{ text: String(new Set(p.lines.filter((l) => l.lot).map((l) => l.lot)).size), bold: true }] }
      : { label: 'Pallets', lines: [{ text: p.pallets != null ? fmtQty(p.pallets, 2) : '-', bold: true }] },
  ]);

  // A production return is one line per lot: the lot code and born-on date sit
  // beside the quantity, which is what the receiving dock and a recall both
  // read. Ordinary warehouse transfers carry no lots and keep the plain layout.
  doc.table({
    columns: hasLots ? [
      { key: 'itemNo', label: 'Item', width: 80, bold: true, accent: true },
      { key: 'description', label: 'Description' },
      { key: 'lot', label: 'Lot', width: 74, bold: true, format: (v) => v || '-' },
      { key: 'bornOn', label: 'Born on', width: 68, format: (v) => v ? fmtDate(v) : '-' },
      { key: 'qty', label: 'Qty', width: 62, align: 'right', format: (v, r) => `${fmtQty(v)}${r.uom ? ' ' + r.uom : ''}` },
      { key: 'weight', label: 'Wt (lbs)', width: 58, align: 'right', format: (v) => v == null ? '-' : fmtQty(v, 1) },
      { key: 'pallets', label: 'Plt', width: 44, align: 'right', format: (v) => v == null ? '-' : fmtQty(v, 2) },
    ] : [
      { key: 'itemNo', label: 'Item', width: 90, bold: true, accent: true },
      { key: 'description', label: 'Description' },
      { key: 'qty', label: 'Qty', width: 80, align: 'right', format: (v, r) => `${fmtQty(v)}${r.uom ? ' ' + r.uom : ''}` },
      { key: 'weight', label: 'Wt (lbs)', width: 70, align: 'right', format: (v) => v == null ? '-' : fmtQty(v, 1) },
      { key: 'pallets', label: 'Pallets', width: 60, align: 'right', format: (v) => v == null ? '-' : fmtQty(v, 2) },
    ],
    rows: p.lines.map((l) => ({ ...l, _detail: l.bestBy ? [`Best by ${fmtDate(l.bestBy)}`] : [] })),
  });

  doc.notes('Special instructions', p.specialInstructions);
  doc.notes('Notes', p.notes);

  doc.smallPrint(
    'Received, subject to individually determined rates or contracts that have been agreed upon in writing between the carrier and shipper, if applicable, otherwise to the rates, classifications and rules that have been established by the carrier and are available to the shipper on request, the property described above in apparent good order, except as noted. Consignee: note shortages or damage on this document before signing.');

  doc.signatures(['Shipper', 'Carrier', 'Received by'], {
    sub: [
      p.signatures?.shipperName ? `${p.signatures.shipperName} · ${fmtDate(p.signatures.shipperAt)}` : 'Name / date',
      'Name / date',
      p.signatures?.receiverName ? `${p.signatures.receiverName} · ${fmtDate(p.signatures.receiverAt)}` : 'Name / date',
    ],
  });
  doc.finishPage();
  return pdf.save();
}

// ── Batching sheet ───────────────────────────────────────────────────────────
export async function renderBatchSheetPdf(p) {
  const { pdf, doc } = await open(p.accent);
  pdf.setTitle(`Batching Sheet · ${p.formula.name} · ${fmtQty(p.batchGal, 0)} gal`);
  pdf.setProducer('Refractor · production');
  doc.footerText = `${p.company.name}  ·  ${p.formula.name} · rev ${p.formula.docRev || '-'}  ·  Generated ${new Date().toLocaleString('en-US')}`;

  await doc.brandBar();
  doc.header({
    company: p.company, title: 'Batching Sheet', number: p.formula.code || p.formula.name,
    dateLines: [
      p.formula.name !== (p.formula.code || p.formula.name) ? p.formula.name : null,
      `Rev ${p.formula.docRev || '-'}${p.formula.effectiveDate ? ' · effective ' + fmtDate(p.formula.effectiveDate) : ''}`,
      p.workOrder ? `Work order ${p.workOrder.batch}` : null,
    ].filter(Boolean),
  });

  const throwTxt = p.dilutionRatio > 0 ? `${fmtQty(p.dilutionRatio, 2)}:1 (1 part concentrate, ${fmtQty(p.dilutionRatio, 2)} parts water)` : 'not diluted';
  doc.metaBlocks([
    { label: 'Batch', lines: [
        { text: `${fmtQty(p.batchGal, 0)} gal finished`, bold: true },
        p.concentrateGal != null ? `${fmtQty(p.concentrateGal, 1)} gal concentrate` : null,
        p.tank ? `Tank ${fmtQty(p.tank, 0)} gal` : null,
      ].filter(Boolean) },
    { label: 'Yield', lines: [
        { text: p.targetUnits != null ? `${fmtQty(p.targetUnits, 0)} cans` : '-', bold: true },
        p.canSizeOz ? `${fmtQty(p.canSizeOz)} oz cans` : null,
        p.cases != null ? `${fmtQty(p.cases, 0)} cases` : null,
      ].filter(Boolean) },
    { label: 'Weights', lines: [
        { text: `${fmtQty(p.totalLbs, 1)} lbs total`, bold: true },
        p.densityLbsPerGal ? `${fmtQty(p.densityLbsPerGal, 3)} lbs / gal` : null,
        `Throw ${throwTxt}`,
      ].filter(Boolean) },
    { label: 'Production', lines: [
        { text: p.workOrder?.copacker || p.copacker || 'Co-packer: ____________', bold: !!(p.workOrder?.copacker || p.copacker) },
        p.workOrder?.scheduled ? `Scheduled ${fmtDate(p.workOrder.scheduled)}` : 'Production date: ____________',
        'Lot #: ____________',
      ] },
  ]);

  doc.table({
    columns: [
      { key: 'n', label: '#', width: 28, align: 'center' },
      { key: 'name', label: 'Ingredient', bold: true },
      { key: 'pct', label: '% by wt', width: 70, align: 'right', format: (v) => (Number(v) * 100).toFixed(4) + '%' },
      { key: 'lbs', label: 'Target', width: 90, align: 'right', bold: true, format: (v, r) => `${fmtQty(v, 2)} ${r.uom || 'lbs'}` },
      { key: 'lot', label: 'Lot / batch #', width: 90 },
      { key: 'measured', label: 'Measured', width: 70 },
      { key: 'ok', label: 'OK', width: 30, align: 'center' },
    ],
    rows: p.rows.map((r, i) => ({ ...r, n: i + 1, lot: '', measured: '', ok: '' })),
    emptyText: 'No ingredients on this formula',
  });

  if (p.qcSpecs?.length) {
    doc.y -= 12;
    doc.table({
      columns: [
        { key: 'check', label: 'Product spec', bold: true },
        { key: 'spec', label: 'Specification', width: 200 },
        { key: 'actual', label: 'Actual', width: 110 },
        { key: 'ok', label: 'OK', width: 30, align: 'center' },
      ],
      rows: p.qcSpecs.map((q) => ({ ...q, actual: '', ok: '' })),
    });
  }

  if (p.steps?.length) {
    doc.need(40);
    doc.y -= 6;
    doc.text('BATCHING INSTRUCTIONS', M, doc.y, { size: 7.5, bold: true, color: doc.accent });
    doc.y -= 6;
    p.steps.forEach((s, i) => {
      doc.para(`${i + 1}.  ${s}`, { size: 8.5, x: M + 4, maxW: CONTENT_W - 8, lead: 11.5 });
      doc.y -= 2;
    });
    doc.y -= 6;
  }

  doc.notes('Comments', p.comments);
  doc.smallPrint(`Confidential — formula ${p.formula.code || p.formula.name} is the property of ${p.company.name} and is disclosed to the co-packer under NDA for the production of this batch only.`);
  doc.signatures(['Client', 'Operations', 'QA / QC'], { sub: ['Name / date', 'Name / date', 'Name / date'] });
  doc.finishPage();
  return pdf.save();
}
