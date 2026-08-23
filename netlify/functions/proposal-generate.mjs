import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';

// AI first-level proposal draft. Takes the same ProposalBuilderData the Gamma
// export uses and asks Claude to write a polished follow-up email. Callers fall
// back to the deterministic template on any error, so this never blocks the flow.
const ALLOWED_ROLES = ['superadmin', 'admin', 'sales'];
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

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

// Compact, factual brief for the model — every concrete number/name the email
// may cite, so it never has to invent pricing or product details.
function proposalBrief(data) {
  const customer = data.customer || {};
  const products = Array.isArray(data.products) ? data.products : [];
  const equipment = Array.isArray(data.equipment) ? data.equipment : [];
  const servicePlans = Array.isArray(data.servicePlans) ? data.servicePlans : [];
  const endOptions = Array.isArray(data.endOfLeaseOptions) ? data.endOfLeaseOptions : [];
  const pricing = data.pricing || {};
  const terms = data.terms || {};

  const lines = [
    `Customer: ${customer.name || 'the customer'}`,
    `Contact: ${customer.contactName || '(unknown)'}`,
    `Business type: ${customer.businessType || 'restaurant / foodservice'}`,
    `Location: ${customer.location || 'TBD'}`,
    '',
    'Recommended beverage lineup:',
    products.length
      ? products.map((p) => `  - ${p.name}${p.packageSize ? ` (${p.packageSize})` : ''}${p.price != null ? ` — ${money(p.price)}` : ''}`).join('\n')
      : '  - Curated BRIX beverage lineup (to be finalized)',
    '',
    'Recommended equipment package:',
    equipment.length
      ? equipment.map((e) => `  - ${e.quantity || 1}x ${e.name} (${e.category || 'equipment'})`).join('\n')
      : '  - Dispense package to be finalized after site survey',
    '',
    `Pricing model: ${terms.pricingModel === 'lease_support' ? `${terms.termMonths || 36}-month lease support` : 'month-to-month'}`,
    `Monthly lease/rental estimate: ${pricing.total_monthly_price != null ? money(pricing.total_monthly_price) : 'to be confirmed after the site survey'}`,
    `Service & support: ${servicePlans.length ? servicePlans.map((p) => p.label).join(', ') : 'standard BRIX service and support'}`,
    `End-of-lease options: ${endOptions.length ? endOptions.map((o) => o.label).join(', ') : 'to be selected'}`,
    `Installation timeline: ${terms.installationTimeline || 'scheduled after product lineup, credit, and site details are confirmed'}`,
    `Site survey next step: ${terms.siteSurveyNextStep || 'schedule a quick site survey to confirm utilities, space, and installation details'}`,
    `Account application link: ${terms.accountApplicationUrl || 'https://alamedapointbg.com/account-application'}`,
  ];
  return lines.join('\n');
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = await requireAuth(event, ALLOWED_ROLES);
  if (!auth.ok) return auth.response;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY is not configured on this site.' }, 503);

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const format = data.format === 'proposal' ? 'proposal' : 'email';
  const brief = proposalBrief(data);

  const system = format === 'proposal'
    ? `You are a senior sales writer for Alameda Craft Soda / BRIX Beverage, a premium local beverage partner. Write a concise, confident one-page proposal in Markdown from the brief. Use short section headers (Overview, Beverage Lineup, Equipment, Investment, Service & Support, Next Steps). Cite ONLY the numbers, product names, and terms given in the brief — never invent pricing or products. Warm and professional, not hype. Return only the Markdown proposal, no preamble.`
    : `You are a senior sales rep for Alameda Craft Soda / BRIX Beverage, a premium local beverage partner. Write a warm, concise follow-up email to the customer contact from the brief. Reference the recommended lineup, the equipment package, the monthly estimate, service, and the next step (site survey + account application). Cite ONLY the numbers, product names, and terms given in the brief — never invent pricing or products. Sign off as "Brix Beverage". Plain text, no markdown headers, 5 short paragraphs max. Return only the email body.`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1600,
        system,
        messages: [{ role: 'user', content: `Here is the proposal brief:\n\n${brief}` }],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return json({ error: `Claude API error: ${res.status} ${err.slice(0, 300)}` }, 502);
    }
    const payload = await res.json();
    const text = (payload.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) return json({ error: 'The model returned an empty draft.' }, 502);
    return json({ text, format });
  } catch (e) {
    console.error('proposal-generate error:', e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
