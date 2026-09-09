// subdist-doc.mjs — turn a sub-distribution agreement row into the document.
//
// ONE PARSE, TWO RENDERERS, same as the NDA: parseNdaSource() reads the
// template markup and both the on-screen document and the PDF consume the
// blocks it produces. Two copies of the text could quietly disagree about what
// somebody signed, which is the whole reason the parser is shared.
//
// What is NOT shared is the marker blocks. [PARTIES] and [SIGNATURES] read
// differently on a distribution agreement than on an NDA (Company and
// Distributor, not Company and Recipient), and [FEE_SCHEDULE] and
// [SERVICE_LEVELS] exist only here — so this file owns them and reuses the
// parser, the date formatter, the escaper and the blank-in-a-document helper.
//
// ⚠ The Fee and Territory Schedule is where every per-partner number lives:
// territory, accounts, the per-case fee, the payment term, the notice
// addresses AND the insurance limits. That last one matters — §23 obliges them
// to carry insurance "in the minimum limits Company specifies in writing", and
// this Schedule IS that writing. Drop the insurance block and §23 becomes an
// obligation with no number attached to it.

import {
  parseNdaSource, longDate, COMPANY, esc, runsHtml, blank,
} from '../nda-doc.mjs';

const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** The three levels as they ship. Editable per partner; Level 1 is the
 *  emergency, which is the direction Sky asked for on 2026-09-04. */
export const DEFAULT_SERVICE_LEVELS = [
  { level: 1, name: 'Emergency', hours: 24,
    description: 'The account cannot serve product — no gas, no syrup, or the dispenser is down.' },
  { level: 2, name: 'Impaired', hours: 48,
    description: 'Part of the system is out but the account is still serving.' },
  { level: 3, name: 'Routine', hours: 72,
    description: 'Quality, cosmetic, scheduled and preventive work.' },
];

export const DEFAULT_INSURANCE = [
  { line: 'Commercial general liability', limit: '$1,000,000 each occurrence / $2,000,000 aggregate' },
  { line: 'Automobile liability (any auto used to deliver Company product)', limit: '$1,000,000 combined single limit' },
  { line: "Workers' compensation", limit: 'Statutory' },
  { line: "Employers' liability", limit: '$1,000,000' },
];

/**
 * Normalise the agreement's `deal_terms` jsonb into everything the Schedule
 * needs, filling from the partner record where the deal is silent.
 *
 * ⚠ A default is only ever applied to a MISSING key. An explicitly empty
 * array means "none", which is a real answer — a partner who carries no
 * service obligation has no service levels, and quietly re-inserting the
 * three defaults there would commit them to response times nobody agreed.
 */
export function dealTerms(a = {}, dist = {}) {
  const t = (a.deal_terms && typeof a.deal_terms === 'object') ? a.deal_terms : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(t, k);
  const fee = has('per_case_fee') ? t.per_case_fee : dist.per_case_delivery_fee;
  return {
    model: t.model || a.model || dist.model || 'consignment',
    territory: t.territory || dist.territory || '',
    accounts: t.accounts || '',
    per_case_fee: fee == null || fee === '' ? null : Number(fee),
    per_case_unit: t.per_case_unit || 'per case delivered',
    other_fees: Array.isArray(t.other_fees) ? t.other_fees : [],
    service_rate: t.service_rate || '',
    settlement_day: t.settlement_day || 'the 10th day of the following month',
    payment_term: t.payment_term || 'Net 30 from the settlement date',
    notice_company_email: t.notice_company_email || 'ap@alamedapointbg.com',
    notice_distributor_email: t.notice_distributor_email || dist.contact_email || '',
    service_levels: has('service_levels') && Array.isArray(t.service_levels)
      ? t.service_levels : DEFAULT_SERVICE_LEVELS,
    insurance: has('insurance') && Array.isArray(t.insurance) ? t.insurance : DEFAULT_INSURANCE,
    extra: t.extra || '',
  };
}

function partiesHtml(a) {
  return `<p>This Sub-Distribution Agreement (this "Agreement") is entered into as of
    ${blank(longDate(a.effective_date), '12rem')} (the "Effective Date"), by and between:</p>
  <p class="party"><b>${esc(COMPANY.legalName)}</b>, ${esc(COMPANY.descriptor)}, with offices at
    ${esc(COMPANY.address)} ("Company"); and</p>
  <p class="party">${blank(a.counterparty_legal_name, '20rem')}, a
    ${blank([a.counterparty_state, a.counterparty_entity_type].filter(Boolean).join(' '), '12rem')}
    with offices at ${blank(a.counterparty_address, '22rem')} ("Distributor").</p>
  <p>Company and Distributor are each a "Party" and together the "Parties."</p>`;
}

function feeScheduleHtml(t) {
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v || blank('', '18rem')}</td></tr>`;
  const feeRows = [];
  if (t.per_case_fee != null) {
    feeRows.push(`<tr><td>Delivery</td><td>${esc(money(t.per_case_fee))}</td><td>${esc(t.per_case_unit)}</td></tr>`);
  }
  for (const f of t.other_fees) {
    feeRows.push(`<tr><td>${esc(f.label || '')}</td><td>${esc(f.rate == null ? '' : (typeof f.rate === 'number' ? money(f.rate) : f.rate))}</td><td>${esc(f.unit || '')}</td></tr>`);
  }
  if (t.service_rate) {
    feeRows.push(`<tr><td>Service labour</td><td>${esc(t.service_rate)}</td><td>where Distributor performs service work</td></tr>`);
  }
  // A schedule with no priced line is a schedule nobody filled in — say so
  // rather than printing an empty table that reads as "no fees are payable".
  const fees = feeRows.length
    ? `<table class="schedtable"><thead><tr><th>Fee</th><th>Rate</th><th>Basis</th></tr></thead>
       <tbody>${feeRows.join('')}</tbody></table>`
    : `<p class="unset">No fees have been entered on this Schedule.</p>`;

  const ins = t.insurance.length
    ? `<table class="schedtable"><thead><tr><th>Coverage</th><th>Minimum limit</th></tr></thead><tbody>${
        t.insurance.map((i) => `<tr><td>${esc(i.line || '')}</td><td>${esc(i.limit || '')}</td></tr>`).join('')
      }</tbody></table>`
    : `<p class="unset">No minimum limits have been specified.</p>`;

  return `<div class="schedule">
    <h2>FEE AND TERRITORY SCHEDULE</h2>
    <table class="schedtable kv">
      ${row('Distribution model', esc(t.model === 'consignment' ? 'Consignment — title stays with Company under Section 2' : t.model))}
      ${row('Territory', esc(t.territory))}
      ${row('Accounts', esc(t.accounts))}
    </table>
    <h3>Fees payable to Distributor</h3>
    ${fees}
    <h3>Settlement and payment</h3>
    <table class="schedtable kv">
      ${row('Settlement run', esc(t.settlement_day))}
      ${row('Payment term', esc(t.payment_term))}
    </table>
    <h3>Insurance — the minimum limits required by Section 23</h3>
    ${ins}
    <h3>Notices under Section 30</h3>
    <table class="schedtable kv">
      ${row('Company', esc(t.notice_company_email))}
      ${row('Distributor', esc(t.notice_distributor_email))}
    </table>
    ${t.extra ? `<h3>Additional terms</h3><p>${esc(t.extra)}</p>` : ''}
  </div>`;
}

function serviceLevelsHtml(t) {
  if (!t.service_levels.length) {
    return `<p class="unset">Distributor performs no service work under this Agreement, so no response
      times apply. Section 14 and the service-performance grounds in Section 25 are inoperative.</p>`;
  }
  return `<table class="schedtable"><thead><tr>
      <th>Level</th><th>What it means</th><th>Response</th></tr></thead><tbody>${
    t.service_levels.map((s) => `<tr>
      <td><b>Level ${esc(s.level)}</b>${s.name ? ` — ${esc(s.name)}` : ''}</td>
      <td>${esc(s.description || '')}</td>
      <td><b>${esc(s.hours)} hours</b></td></tr>`).join('')
  }</tbody></table>`;
}

function signaturesHtml(a, opts = {}) {
  const img = (src, alt) => (src
    ? `<img class="sigimg" src="${esc(src)}" alt="${esc(alt)}">`
    : '<span class="sigline"></span>');
  return `<div class="sigs">
    <div class="sigbox">
      <div class="sigwho">COMPANY</div>
      <div class="signm">Alameda Point Beverage Group, Inc.</div>
      ${img(a.company_signature_data || opts.companySignature, 'Company signature')}
      <div class="sigrow">By: ${blank(a.company_signer_name, '11rem')}</div>
      <div class="sigrow">Name: ${blank(a.company_signer_name, '11rem')}</div>
      <div class="sigrow">Title: ${blank(a.company_signer_title, '11rem')}</div>
      <div class="sigrow">Date: ${blank(longDate(a.company_signed_at), '11rem')}</div>
    </div>
    <div class="sigbox">
      <div class="sigwho">DISTRIBUTOR</div>
      <div class="signm">${a.counterparty_legal_name
        ? esc(a.counterparty_legal_name) : '<span class="sigline"></span>'}</div>
      ${img(a.signature_data, 'Distributor signature')}
      <div class="sigrow">By: ${blank(a.typed_name, '11rem')}</div>
      <div class="sigrow">Name: ${blank(a.signer_name, '11rem')}</div>
      <div class="sigrow">Title: ${blank(a.signer_title, '11rem')}</div>
      <div class="sigrow">Date: ${blank(longDate(a.signed_at), '11rem')}</div>
    </div>
  </div>`;
}

/**
 * Render the agreement to HTML for the signing page, the staff preview and the
 * executed view. `a` is the agreement row (its snapshotted `body_source` is
 * what gets parsed once signed); `opts.distributor` fills the Schedule where
 * the deal is silent; `opts.companySignature` is a data URL.
 */
export function renderSubdistHtml(a, opts = {}) {
  const t = dealTerms(a, opts.distributor || {});
  const blocks = parseNdaSource(a.body_source);
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`<ol class="items">${list}</ol>`); list = null; } };

  for (const b of blocks) {
    if (b.type !== 'item') closeList();
    switch (b.type) {
      case 'title':          out.push(`<h1>${esc(b.text)}</h1>`); break;
      case 'heading':        out.push(`<h2>${esc(b.text)}</h2>`); break;
      case 'section':        out.push(`<p class="sec"><span class="secno">${esc(b.number)}.</span> ${runsHtml(b.runs)}</p>`); break;
      case 'item':           list = (list || '') + `<li><span class="mk">${esc(b.marker)}</span> ${runsHtml(b.runs)}</li>`; break;
      case 'para':           out.push(`<p>${runsHtml(b.runs)}</p>`); break;
      case 'parties':        out.push(partiesHtml(a)); break;
      case 'fee_schedule':   out.push(feeScheduleHtml(t)); break;
      case 'service_levels': out.push(serviceLevelsHtml(t)); break;
      case 'signatures':     out.push(signaturesHtml(a, opts)); break;
      default: break;
    }
  }
  closeList();
  return out.join('\n');
}

export default renderSubdistHtml;
