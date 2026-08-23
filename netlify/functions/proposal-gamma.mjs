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
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const pricing = data.pricing || {};
  const terms = data.terms || {};

  const isImage = (a) => !/\.pdf($|\?)/i.test(a.url || '') && (a.type !== 'sell-sheet');
  // Embedded visuals become inline images in the deck; attachments are listed as links.
  const embeds = assets.filter((a) => (a.role ? a.role === 'embed' : true) && isImage(a));
  const attachments = assets.filter((a) => a.role === 'attach' || !isImage(a));

  // Inline product/equipment imagery so the deck isn't text-only.
  const productImages = products.map((p) => p.imageUrl).filter(Boolean);
  const heroImages = [...new Set([...embeds.map((a) => a.url), ...productImages])].slice(0, 6);

  return [
    `# ${data.title || 'Custom Beverage Program Proposal'}`,
    '',
    `Customer: ${customer.name || 'Customer'}`,
    `Business type: ${customer.businessType || 'Restaurant / foodservice'}`,
    `Location: ${customer.location || 'TBD'}`,
    '',
    ...(heroImages.length ? ['## Brand & Product Visuals', ...heroImages.map((url) => `![Brand visual](${url})`), ''] : []),
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
    ...(attachments.length ? ['## Reference Attachments', ...attachments.map((a) => `- [${a.name || 'Attachment'}](${a.url})`), ''] : []),
    '## Style Direction',
    data.style || 'Alameda Craft Soda / Brix Beverage premium local beverage partner',
  ].join('\n');
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return json({ error: 'POST or GET only', status: 'error' }, 405);
  }

  const auth = await requireAuth(event, ALLOWED_ROLES);
  if (!auth.ok) return auth.response;

  const key = process.env.GAMMA_API_KEY;
  if (!key) {
    return json({ status: 'error', error: 'GAMMA_API_KEY is not configured on Netlify', message: 'GAMMA_API_KEY is not configured on Netlify' }, 503);
  }

  try {
    // Gamma's Generations API is asynchronous: POST returns only a
    // generationId; the deck URL exists only once GET .../{id} reports
    // status "completed". The client starts with POST here and then polls
    // this same function with ?generationId= until we hand back the URLs.
    if (event.httpMethod === 'GET') {
      const generationId = event.queryStringParameters?.generationId;
      if (!generationId) {
        return json({ status: 'error', error: 'generationId is required', message: 'generationId is required' }, 400);
      }
      const res = await fetch(`${GAMMA_GENERATIONS_URL}/${encodeURIComponent(generationId)}`, {
        headers: { 'X-API-KEY': key },
      });
      const text = await res.text();
      let out = {};
      try { out = text ? JSON.parse(text) : {}; } catch { out = {}; }
      if (!res.ok) {
        const message = out?.message || out?.error || text || `Gamma returned ${res.status}`;
        return json({ status: 'error', error: message, message }, 502);
      }
      if (out.status === 'completed') {
        return json({
          status: 'created',
          generationId,
          gammaUrl: out.gammaUrl,
          pdfUrl: out.exportUrl || out.pdfUrl,
          message: 'Gamma deck created.',
        });
      }
      if (out.status === 'failed') {
        // Definitive failure from Gamma — report it as data (200) so the
        // client can tell it apart from a transient infra error and stop
        // polling instead of retrying.
        return json({ status: 'error', generationId, message: out.message || out.error || 'Gamma generation failed.' });
      }
      return json({ status: 'pending', generationId, message: 'Gamma is still generating the deck.' });
    }

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
    let out = {};
    try { out = text ? JSON.parse(text) : {}; } catch { out = {}; }
    if (!res.ok) {
      const message = out?.message || out?.error || text || `Gamma returned ${res.status}`;
      return json({ status: 'error', error: message, message }, 502);
    }
    if (!out.generationId) {
      const message = 'Gamma accepted the request but returned no generationId.';
      return json({ status: 'error', error: message, message }, 502);
    }

    return json({
      status: 'pending',
      generationId: out.generationId,
      message: 'Gamma generation started.',
    });
  } catch (e) {
    console.error('proposal-gamma error:', e);
    const message = e instanceof Error ? e.message : String(e);
    return json({ status: 'error', error: message, message }, 500);
  }
}
