// subdist-pdf.mjs — the executed sub-distribution agreement as a real PDF.
//
// This is the artefact of record: emailed to both sides, filed in the
// distributor-docs bucket, and produced years later if anyone argues. So it is
// built from the SAME parsed blocks as the on-screen document (subdist-doc.mjs)
// rather than a second copy of the text, on the SAME page engine as the NDA
// (legal-pdf.mjs) so our documents look like each other.
//
// Two pages exist that the on-screen version does not:
//   · The Fee and Territory Schedule as a real table. It is the only place the
//     per-partner numbers live — including the insurance limits §23 obliges
//     them to carry — so it gets its own page rather than being squeezed
//     between clauses.
//   · The electronic signature record. A drawn squiggle proves very little;
//     the typed name, timestamp, IP, browser and consent flag are what make it
//     defensible, and they are part of the executed document, not a log
//     somewhere else.

import { dealTerms } from './subdist-doc.mjs';
import { parseNdaSource, longDate, COMPANY } from '../nda-doc.mjs';
import {
  PDFDocument, rgb,
  PAGE_W, M_L, M_R, M_B, BODY, LEAD, INK, RULE, NAVY,
  wrapRuns, sanitize, Doc, embedSignature, fillLine,
  embedFonts, drawLetterhead, drawFooters, drawFacts,
} from '../legal-pdf.mjs';

const HEAD_BG = rgb(0.93, 0.95, 0.97);
const ZEBRA = rgb(0.975, 0.98, 0.985);

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n)
    ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '';
};

/**
 * A simple table. Rows wrap, and a row is kept whole across a page break —
 * a fee split over two pages is the kind of thing somebody misreads.
 *
 * ⚠ Local rather than in legal-pdf.mjs on purpose: the NDA's Exhibit A table
 * is fixed-height and centred differently, and merging the two would mean one
 * of them getting a layout nobody asked for. Promote this only if a third
 * document wants exactly this shape.
 */
function drawTable(doc, cols, heads, rows) {
  const { fonts } = doc;
  const H = 9;
  const rowFor = (cells, bold) => {
    const per = cells.map((c, i) =>
      wrapRuns([{ text: String(c ?? '') }], cols[i] - 10, H,
        { reg: bold ? fonts.bold : fonts.reg, bold: fonts.bold }));
    return { per, lines: Math.max(1, ...per.map((p) => p.length)) };
  };
  const draw = ({ per, lines }, bold, bg) => {
    const h = lines * 12 + 7;
    doc.need(h + 2);
    if (bg) {
      doc.page.drawRectangle({ x: M_L, y: doc.y - h + 9, width: doc.width, height: h, color: bg });
    }
    let x = M_L;
    per.forEach((para, i) => {
      let yy = doc.y;
      for (const ln of para) {
        let lx = x + 5;
        for (const seg of ln) {
          const f = bold ? fonts.bold : fonts.reg;
          doc.page.drawText(sanitize(seg.text, f), { x: lx, y: yy, size: H, font: f, color: INK });
          lx += seg.w;
        }
        yy -= 12;
      }
      x += cols[i];
    });
    doc.y -= h;
  };
  // An all-blank header draws a shaded band with nothing in it, which reads
  // as a header that failed to render rather than as a table without one.
  if (heads.some((h) => String(h ?? '').trim())) draw(rowFor(heads, true), true, HEAD_BG);
  rows.forEach((r, i) => draw(rowFor(r, false), false, i % 2 ? ZEBRA : null));
  doc.page.drawLine({ start: { x: M_L, y: doc.y + 7 }, end: { x: M_L + doc.width, y: doc.y + 7 },
    thickness: 0.6, color: RULE });
  doc.y -= 6;
}

/**
 * The Schedule's key/value blocks.
 *
 * ⚠ Every row renders, even an empty one. This is a contract: a silently
 * absent "Accounts" row is indistinguishable from a term that was never meant
 * to exist, and §1 and §30 both define themselves BY REFERENCE to this
 * Schedule — a missing notice address means notice cannot be given. So a blank
 * says "not specified" out loud. (The FEE table is different: it is a list of
 * lines, and a line that does not exist should not be invented.)
 */
function kvTable(doc, pairs) {
  drawTable(doc, [170, doc.width - 170], ['', ''],
    pairs.map(([k, v]) => [k, v == null || v === '' ? 'not specified' : v]));
}

function feeSchedulePage(doc, t) {
  doc.newPage();
  doc.text('FEE AND TERRITORY SCHEDULE', { size: 12.5, bold: true, align: 'center' });
  doc.y -= 18;
  doc.rule(); doc.space(6);

  kvTable(doc, [
    ['Distribution model', t.model === 'consignment'
      ? 'Consignment — title stays with Company under Section 2' : t.model],
    ['Territory', t.territory],
    ['Accounts', t.accounts],
  ]);
  doc.space(8);

  doc.text('Fees payable to Distributor', { size: 10.5, bold: true }); doc.y -= 15;
  const feeRows = [];
  if (t.per_case_fee != null) feeRows.push(['Delivery', money(t.per_case_fee), t.per_case_unit]);
  for (const f of t.other_fees) {
    feeRows.push([f.label || '', typeof f.rate === 'number' ? money(f.rate) : String(f.rate ?? ''), f.unit || '']);
  }
  if (t.service_rate) feeRows.push(['Service labour', t.service_rate, 'where Distributor performs service work']);
  // A Schedule with no priced line says so. An empty table would read as
  // "no fees are payable", which is a different agreement entirely.
  if (feeRows.length) drawTable(doc, [140, 130, doc.width - 270], ['Fee', 'Rate', 'Basis'], feeRows);
  else { doc.para('No fees have been entered on this Schedule.'); doc.space(6); }
  doc.space(8);

  doc.text('Settlement and payment', { size: 10.5, bold: true }); doc.y -= 15;
  kvTable(doc, [['Settlement run', t.settlement_day], ['Payment term', t.payment_term]]);
  doc.space(8);

  doc.text('Insurance — the minimum limits required by Section 23', { size: 10.5, bold: true }); doc.y -= 15;
  if (t.insurance.length) {
    drawTable(doc, [250, doc.width - 250], ['Coverage', 'Minimum limit'],
      t.insurance.map((i) => [i.line || '', i.limit || '']));
  } else {
    doc.para('No minimum limits have been specified.');
    doc.space(6);
  }
  doc.space(8);

  doc.text('Notices under Section 30', { size: 10.5, bold: true }); doc.y -= 15;
  kvTable(doc, [['Company', t.notice_company_email], ['Distributor', t.notice_distributor_email]]);

  if (t.extra) {
    doc.space(10);
    doc.text('Additional terms', { size: 10.5, bold: true }); doc.y -= 15;
    doc.para(t.extra);
  }
}

export async function renderSubdistPdf(a, { distributor = {}, companySignature = null } = {}) {
  const pdf = await PDFDocument.create();
  const fonts = await embedFonts(pdf);
  const doc = new Doc(pdf, fonts, a);
  const t = dealTerms(a, distributor);
  const them = a.counterparty_legal_name || distributor.name || '';

  await drawLetterhead(pdf, doc);
  doc.text(a.title || 'SUB-DISTRIBUTION AGREEMENT', { size: 13.5, bold: true, align: 'center' });
  doc.y -= 16;
  if (a.subtitle) { doc.text(a.subtitle, { size: 10.5, align: 'center' }); doc.y -= 14; }
  doc.rule();
  doc.space(6);

  for (const b of parseNdaSource(a.body_source)) {
    switch (b.type) {
      case 'title': break;                                   // drawn above
      case 'heading':
        doc.need(30); doc.space(6);
        doc.text(b.text, { size: 11, bold: true, align: 'center' });
        doc.y -= 18;
        break;
      case 'parties':
        doc.runs([{ text: 'This Sub-Distribution Agreement (this "Agreement") is entered into as of ' },
                  { text: longDate(a.effective_date) || '____________________', bold: true },
                  { text: ' (the "Effective Date"), by and between:' }]);
        doc.space(4);
        doc.runs([{ text: COMPANY.legalName, bold: true },
                  { text: `, ${COMPANY.descriptor}, with offices at ${COMPANY.address} ("Company"); and` }],
                 { indent: 18 });
        doc.space(4);
        doc.runs([{ text: them || '______________________________', bold: true },
                  { text: `, a ${[a.counterparty_state, a.counterparty_entity_type].filter(Boolean).join(' ') || '____________________'}`
                        + ` with offices at ${a.counterparty_address || '______________________________'} ("Distributor").` }],
                 { indent: 18 });
        doc.space(4);
        doc.para('Company and Distributor are each a "Party" and together the "Parties."');
        doc.space();
        break;
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
      case 'fee_schedule':
        // In the flow of the agreement §5 just points at it; the Schedule
        // itself is drawn as its own page after the signatures.
        doc.para('The Fee and Territory Schedule appears at the end of this Agreement and forms part of it.');
        doc.space();
        break;
      case 'service_levels':
        if (t.service_levels.length) {
          doc.space(2);
          drawTable(doc, [130, doc.width - 220, 90], ['Level', 'What it means', 'Response'],
            t.service_levels.map((s) => [
              `Level ${s.level}${s.name ? ` — ${s.name}` : ''}`,
              s.description || '',
              `${s.hours} hours`,
            ]));
          doc.space(4);
        } else {
          doc.para('Distributor performs no service work under this Agreement, so no response times '
            + 'apply. Section 14 and the service-performance grounds in Section 25 are inoperative.');
          doc.space();
        }
        break;
      case 'signatures': {
        // Keep a signature block whole — a name on one page and its signature
        // on the next is exactly the ambiguity a signature page exists to avoid.
        doc.need(190);
        doc.space(10);
        const colW = (doc.width - 30) / 2;
        const cols = [M_L, M_L + colW + 30];
        const top = doc.y;
        const theirImg = await embedSignature(pdf, a.signature_data);
        const ourImg = await embedSignature(pdf, a.company_signature_data || companySignature);
        const blocks = [
          { who: 'COMPANY', name: COMPANY.displayName, img: ourImg,
            by: a.company_signer_name, nm: a.company_signer_name,
            title: a.company_signer_title, date: longDate(a.company_signed_at) },
          { who: 'DISTRIBUTOR', name: them, img: theirImg,
            by: a.typed_name, nm: a.signer_name, title: a.signer_title, date: longDate(a.signed_at) },
        ];
        let lowest = top;
        blocks.forEach((blk, i) => {
          doc.y = top;
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
      default: break;
    }
  }

  feeSchedulePage(doc, t);

  // ── The signature record ─────────────────────────────────────────────────
  if (a.signed_at) {
    doc.newPage();
    doc.text('ELECTRONIC SIGNATURE RECORD', { size: 12, bold: true, align: 'center' }); doc.y -= 16;
    doc.text(String(a.agreement_number || ''), { size: 10, align: 'center' }); doc.y -= 18;
    doc.rule(); doc.space(4);
    doc.para("This page records how the Distributor's electronic signature was captured. It is "
      + 'generated automatically and forms part of the executed Agreement.');
    doc.space(10);
    drawFacts(doc, [
      ['Agreement', a.agreement_number],
      ['Template', `${a.template_code} v${a.template_version}`],
      ['Distributor', them],
      ['Signed by', `${a.signer_name || ''}${a.signer_title ? ', ' + a.signer_title : ''}`],
      ['Typed name (intent to sign)', a.typed_name],
      ['Signer email', a.signer_email],
      ['Consented to electronic records', a.consent_esign ? 'Yes' : 'No'],
      ['Signed at', new Date(a.signed_at).toISOString() + '  (' + longDate(a.signed_at) + ' Pacific)'],
      ['Effective date', longDate(a.effective_date)],
      ['Signer IP address', a.signer_ip],
      ['Browser', (a.signer_user_agent || '').slice(0, 120)],
      ['Link sent to', a.sent_to || a.signer_email],
      ['Link sent at', a.sent_at ? new Date(a.sent_at).toISOString() : ''],
      ['First opened', a.viewed_at ? new Date(a.viewed_at).toISOString() : 'not recorded'],
      ['Countersigned for Company by',
        `${a.company_signer_name || ''}${a.company_signer_title ? ', ' + a.company_signer_title : ''}`],
    ]);
  }

  drawFooters(doc, {
    left: `${a.agreement_number || 'DRAFT'}  ·  ${them}`,
    executed: !!a.signed_at,
  });

  return pdf.save();
}

export default renderSubdistPdf;
