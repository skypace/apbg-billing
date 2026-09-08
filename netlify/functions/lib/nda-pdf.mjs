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

import { parseNdaSource, longDate, COMPANY, recipientDescriptor, isMutual, partyLabels } from './nda-doc.mjs';
// The page engine — geometry, wrapping, the WinAnsi fallback, the letterhead,
// the signature embed — is shared with the sub-distribution agreement so the
// two documents cannot drift apart on how a page is drawn. Only the BLOCKS
// below are the NDA's own.
import {
  PDFDocument, rgb,
  PAGE_W, PAGE_H, M_L, M_R, M_T, M_B, BODY, LEAD, GAP, INK, RULE, NAVY,
  wrapRuns, sanitize, Doc, embedSignature, fillLine,
  embedFonts, drawLetterhead, drawFooters,
} from './legal-pdf.mjs';

export { wrapRuns };

/**
 * Build the executed PDF. `a` is the agreement row, `log` the Exhibit A rows,
 * `companySignature` an optional data URL. Returns Uint8Array.
 */
export async function renderNdaPdf(a, { log = [], companySignature = null } = {}) {
  const pdf = await PDFDocument.create();
  const fonts = await embedFonts(pdf);
  const doc = new Doc(pdf, fonts, a);

  await drawLetterhead(pdf, doc);

  // ── Title ────────────────────────────────────────────────────────────────
  doc.text(a.title || 'CONFIDENTIALITY AND NON-DISCLOSURE AGREEMENT', { size: 13.5, bold: true, align: 'center' });
  doc.y -= 16;
  if (a.subtitle) { doc.text(a.subtitle, { size: 10.5, align: 'center' }); doc.y -= 14; }
  doc.rule();
  doc.space(6);

  const blocks = parseNdaSource(a.body_source);
  const recipientName = a.recipient_legal_name || a.recipient_company || '';
  const L = partyLabels(a);

  for (const b of blocks) {
    switch (b.type) {
      case 'title': break;                                  // drawn above
      case 'heading':
        doc.need(30); doc.space(6);
        doc.text(b.text, { size: 11, bold: true, align: 'center' });
        doc.y -= 18;
        break;
      case 'parties': {
        const kind = isMutual(a) ? 'Mutual Confidentiality and Non-Disclosure Agreement'
                                 : 'Confidentiality and Non-Disclosure Agreement';
        doc.runs([{ text: `This ${kind} (this "Agreement") is entered into as of ` },
                  { text: longDate(a.effective_date) || '____________________', bold: true },
                  { text: ' (the "Effective Date"), by and between:' }]);
        doc.space(4);
        doc.runs([{ text: COMPANY.legalName, bold: true },
                  { text: `, ${COMPANY.descriptor}, with offices at ${COMPANY.address} ("${L.us}"); and` }],
                 { indent: 18 });
        doc.space(4);
        const desc = recipientDescriptor(a) || '____________________';
        doc.runs([{ text: recipientName || '______________________________', bold: true },
                  { text: `, a ${desc} with offices at ${a.recipient_address || '______________________________'} ("${L.them}").` }],
                 { indent: 18 });
        doc.space(4);
        doc.para(`${L.us} and ${L.them} are each a "Party" and together the "Parties."`
          + (isMutual(a) ? ' Each Party may act as Discloser and as Recipient under this Agreement.' : ''));
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
        const coImg = await embedSignature(pdf, a.company_signature_data || companySignature);
        const blocks2 = [
          { who: L.us.toUpperCase(), name: COMPANY.displayName, img: coImg,
            by: a.company_signer_name, nm: a.company_signer_name,
            title: a.company_signer_title, date: longDate(a.company_signed_at) },
          { who: L.themHeading, name: recipientName, img: recImg,
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

  drawFooters(doc, {
    left: `${a.agreement_number}  ·  ${recipientName || a.recipient_company}`,
    executed: !!a.signed_at,
  });

  return pdf.save();
}
