import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';

const ALLOWED_ROLES = ['superadmin', 'admin', 'sales'];
const GAMMA_GENERATIONS_URL = 'https://public-api.gamma.app/v1.0/generations';

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function proposalMarkdown(data) {
  const customer = data.customer || {};
  const products = Array.isArray(data.products) ? data.products : [];
  const equipment = Array.isArray(data.equipment) ? data.equipment : [];
  const servicePlans = Array.isArray(data.servicePlans) ? data.servicePlans : [];
  const endOptions = Array.isArray(data.endOfLeaseOptions) ? data.endOfLeaseOptions : [];
  const pricing = data.pricing || {};
  const terms = data.terms || {};

  return [
    `# ${data.title || 'Custom Beverage Program Proposal'}`,
    '',
    `Customer: ${customer.name || 'Customer'}`,
    `Business type: ${customer.businessType || 'Restaurant / foodservice'}`,
    `Location: ${customer.location || 'TBD'}`,
    '',
    '## Recommended Beverage Lineup',
    products.length ? products.map((p) => `- ${p.name}${p.packageSize ? ` (${p.packageSize})` : ''}${p.price != null ? ` — ${money(p.price)}` : ''}`).join('\n') : '- Curated BRIX beverage lineup to be finalized',
    '',
    '## Recommended Equipment Package',
    equipment.length ? equipment.map((e) => `- ${e.quantity || 1}x ${e.name} — ${e.category || 'equipment'}`).join('\n') : '- Equipment package to be finalized after site survey',
    '',
    '## Lease / Rental Estimate',
    `- Monthly estimate: ${pricing.total_monthly_price != null ? money(pricing.total_monthly_price) : 'Pending calculation'}`,
    `- Term: ${terms.pricingModel === 'lease_support' ? `${terms.termMonths || 36} months` : 'Month-to-month'}`,
    `- Capital included: ${pricing.total_capital != null ? money(pricing.total_capital) : 'TBD'}`,
    '',
    '## Service and Support',
    servicePlans.length ? servicePlans.map((p) => `- ${p.label}`).join('\n') : '- Standard BRIX service and support',
    '',
    '## Installation Timeline',
    terms.installationTimeline || 'Typical installation is scheduled after site survey, credit approval, and equipment availability.',
    '',
    '## Site Survey Next Step',
    terms.siteSurveyNextStep || 'Schedule a site survey to confirm utilities, space, CO2 placement, and installation details.',
    '',
    '## Account Application',
    terms.accountApplicationUrl || 'https://alamedapointbg.com/account-application',
    '',
    '## End-of-Lease Options',
    endOptions.length ? endOptions.map((o) => `- ${o.label}: ${o.description || ''}`).join('\n') : '- End-of-lease options to be selected',
    '',
    '## Style Direction',
    data.style || 'Alameda Craft Soda / Brix Beverage premium local beverage partner',
  ].join('\n');
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json({ error: 'POST only', status: 'error' }, 405);

  const auth = await requireAuth(event, ALLOWED_ROLES);
  if (!auth.ok) return auth.response;

  const key = process.env.GAMMA_API_KEY;
  if (!key) return json({ status: 'error', message: 'GAMMA_API_KEY is not configured' }, 503);

  try {
    const data = JSON.parse(event.body || '{}');
    const gammaPayload = {
      inputText: proposalMarkdown(data),
      textMode: 'generate',
      format: 'presentation',
      numCards: 10,
      exportAs: 'pdf',
    };

    const res = await fetch(GAMMA_GENERATIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': key,
      },
      body: JSON.stringify(gammaPayload),
    });
    const text = await res.text();
    const out = text ? JSON.parse(text) : {};
    if (!res.ok) {
      return json({ status: 'error', message: out?.message || out?.error || text || `Gamma returned ${res.status}` }, 502);
    }

    return json({
      status: out.gammaUrl ? 'created' : 'pending',
      generationId: out.generationId,
      gammaUrl: out.gammaUrl,
      pdfUrl: out.exportUrl,
      message: out.gammaUrl ? 'Gamma deck created.' : 'Gamma generation started.',
    });
  } catch (e) {
    console.error('proposal-gamma error:', e);
    return json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, 500);
  }
}
