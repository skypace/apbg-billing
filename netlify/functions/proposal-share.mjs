import { corsHeaders } from './qbo-helpers.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABLE = `${SUPABASE_URL}/rest/v1/proposal_builder_proposals`;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function image(url, alt) {
  if (!url) return '';
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">`;
}

function list(items, render) {
  return items?.length ? `<ul>${items.map(render).join('')}</ul>` : '<p class="muted">To be finalized.</p>';
}

async function fetchProposal(slug) {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  const res = await fetch(`${TABLE}?share_slug=eq.${encodeURIComponent(slug)}&share_enabled=eq.true&select=*&limit=1`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: 'application/json',
      'Accept-Profile': 'ops',
    },
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(parsed?.message || parsed?.error || text || `Supabase returned ${res.status}`);
  return parsed?.[0] || null;
}

function render(row) {
  const proposal = row.proposal || {};
  const customer = proposal.customer || {};
  const products = Array.isArray(proposal.products) ? proposal.products : [];
  const equipment = Array.isArray(proposal.equipment) ? proposal.equipment : [];
  const pricing = proposal.pricing || {};
  const terms = proposal.terms || {};
  const servicePlans = Array.isArray(proposal.servicePlans) ? proposal.servicePlans : [];
  const options = Array.isArray(proposal.endOfLeaseOptions) ? proposal.endOfLeaseOptions : [];
  const assets = Array.isArray(proposal.assets) ? proposal.assets : [];
  const hero = assets.find((a) => a.type === 'hero') || assets.find((a) => a.type === 'logo') || assets[0];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(row.title)}</title>
  <style>
    :root{color-scheme:light;--ink:#172033;--muted:#667085;--line:#d9e1ea;--blue:#1177ad;--red:#c8102e}
    body{margin:0;font-family:Helvetica Neue,Arial,sans-serif;color:var(--ink);background:#f7f9fb}
    main{max-width:1040px;margin:0 auto;padding:36px 20px 56px}
    header{display:grid;grid-template-columns:1.15fr .85fr;gap:28px;align-items:center;padding:34px 0 26px;border-bottom:1px solid var(--line)}
    h1{font-size:42px;line-height:1;margin:0 0 12px;letter-spacing:0}
    h2{font-size:18px;margin:0 0 14px}
    p{line-height:1.55}
    .eyebrow{color:var(--red);font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px}
    .muted{color:var(--muted)}
    .hero img{width:100%;max-height:280px;object-fit:contain}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:24px}
    section{background:white;border:1px solid var(--line);border-radius:8px;padding:20px}
    ul{padding-left:20px;margin:0}
    li{margin:8px 0}
    .metric{font-size:30px;font-weight:800;color:var(--blue)}
    .thumb-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
    .thumb{border:1px solid var(--line);border-radius:8px;padding:12px;background:#fff}
    .thumb img{width:100%;height:120px;object-fit:contain;margin-bottom:8px}
    @media(max-width:760px){header,.grid{grid-template-columns:1fr}h1{font-size:34px}}
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="eyebrow">Brix Beverage Proposal</div>
        <h1>${escapeHtml(customer.name || row.customer_name || 'Custom Beverage Program')}</h1>
        <p class="muted">${escapeHtml([customer.businessType, customer.location].filter(Boolean).join(' · '))}</p>
      </div>
      <div class="hero">${image(hero?.url || hero?.thumbnailUrl, hero?.name || 'Brix Beverage')}</div>
    </header>
    <div class="grid">
      <section>
        <h2>Monthly Estimate</h2>
        <div class="metric">${pricing.total_monthly_price != null ? money(pricing.total_monthly_price) : 'Pending'}</div>
        <p class="muted">${escapeHtml(terms.pricingModel === 'lease_support' ? `${terms.termMonths || 36} month lease support` : 'Month-to-month rental')}</p>
      </section>
      <section>
        <h2>Next Step</h2>
        <p>${escapeHtml(terms.siteSurveyNextStep || 'Schedule a site survey to confirm utilities, space, and installation details.')}</p>
      </section>
      <section>
        <h2>Beverage Lineup</h2>
        ${list(products, (p) => `<li>${escapeHtml(p.name)}${p.packageSize ? ` <span class="muted">(${escapeHtml(p.packageSize)})</span>` : ''}${p.sku ? ` <span class="muted">· ${escapeHtml(p.sku)}</span>` : ''}${p.specSheetUrl ? ` <a href="${escapeHtml(p.specSheetUrl)}">Spec sheet</a>` : ''}</li>`)}
      </section>
      <section>
        <h2>Equipment Package</h2>
        ${list(equipment, (e) => `<li>${escapeHtml(e.quantity || 1)}x ${escapeHtml(e.name)} <span class="muted">${escapeHtml(e.category || '')}</span></li>`)}
      </section>
      <section>
        <h2>Service & Support</h2>
        ${list(servicePlans, (p) => `<li>${escapeHtml(p.label)}</li>`)}
      </section>
      <section>
        <h2>Installation Timeline</h2>
        <p>${escapeHtml(terms.installationTimeline || 'Installation timing is confirmed after site survey, credit approval, and equipment availability.')}</p>
      </section>
      <section>
        <h2>End-of-Lease Options</h2>
        ${list(options, (o) => `<li>${escapeHtml(o.label)}</li>`)}
      </section>
      <section>
        <h2>Account Application</h2>
        <p><a href="${escapeHtml(terms.accountApplicationUrl || 'https://alamedapointbg.com/account-application')}">Open account application</a></p>
      </section>
    </div>
    ${products.some((p) => p.imageUrl || p.specSheetUrl) ? `<section style="margin-top:18px"><h2>Product Visuals & Specs</h2><div class="thumb-list">${products.map((p) => `<div class="thumb">${image(p.imageUrl, p.name)}<strong>${escapeHtml(p.name)}</strong>${p.description ? `<br><span class="muted">${escapeHtml(p.description)}</span>` : ''}${p.specSheetUrl ? `<br><a href="${escapeHtml(p.specSheetUrl)}">Spec sheet</a>` : ''}</div>`).join('')}</div></section>` : ''}
    ${equipment.some((e) => e.imageUrl || e.specSheetUrl) ? `<section style="margin-top:18px"><h2>Equipment Visuals</h2><div class="thumb-list">${equipment.map((e) => `<div class="thumb">${image(e.imageUrl, e.name)}<strong>${escapeHtml(e.name)}</strong>${e.specSheetUrl ? `<br><a href="${escapeHtml(e.specSheetUrl)}">Spec sheet</a>` : ''}</div>`).join('')}</div></section>` : ''}
  </main>
</body>
</html>`;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders(), body: 'GET only' };
  }

  try {
    const slug = event.queryStringParameters?.slug || '';
    if (!slug) return { statusCode: 400, headers: corsHeaders(), body: 'Missing slug' };
    const row = await fetchProposal(slug);
    if (!row) return { statusCode: 404, headers: corsHeaders(), body: 'Proposal not found' };
    if (event.queryStringParameters?.format === 'json') {
      return {
        statusCode: 200,
        headers: { ...corsHeaders(), 'Cache-Control': 'no-store' },
        body: JSON.stringify(row),
      };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      body: render(row),
    };
  } catch (e) {
    console.error('proposal-share error:', e);
    return { statusCode: 500, headers: corsHeaders(), body: e instanceof Error ? e.message : String(e) };
  }
}
