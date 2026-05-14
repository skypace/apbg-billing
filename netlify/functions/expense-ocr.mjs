import { createClient } from '@supabase/supabase-js';

// Hardcoded — anon key is a PUBLIC client identifier per Supabase
// architecture. Prevents a mis-set Netlify env var from breaking us.
const SUPABASE_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_OCR_MODEL || 'claude-sonnet-4-5-20250929';
const CLAUDE_FALLBACK = 'claude-haiku-4-5-20251001';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function json(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: CORS }); }
function err(m, s = 400, extra = {}) { return json({ error: m, ...extra }, s); }

const SYSTEM_PROMPT = `You extract structured data from receipts and vendor invoices for a beverage-distributor expense system.
Return ONLY valid JSON — no markdown, no backticks, no preamble. Schema:

{
  "vendor": "string",
  "total": number (USD, no $, no commas),
  "date": "YYYY-MM-DD or null",
  "line_items": [
    { "description": "string", "qty": number, "unit_price": number, "amount": number }
  ],
  "account_guess": "string (one of the suggested account labels, or your best free-form category)",
  "job_number": "string or null (Service Fusion / ResQ job, work-order #, PO #)",
  "customer_name": "string or null (end-customer if this expense is being charged through)",
  "memo": "string or null (1-line summary suitable for a bill memo)",
  "notes": "string or null (anything else worth capturing — surcharges, terms, multiple POs)"
}

Rules:
- If only a total is shown, set qty=1, unit_price=total, amount=total for a single line item described as the vendor's most-likely service/product
- Extract ALL line items separately when the receipt itemizes them
- For tax/shipping, fold into the line items proportionally OR include as a separate "Tax" / "Shipping" line
- account_guess: pick from these COGS / expense categories first if any fit, otherwise free-form:
  {{ACCOUNT_OPTIONS}}
- job_number: scan aggressively — look for "Job #", "WO #", "PO #", "Ticket", "Service Fusion", "ResQ", reference numbers in subject lines, anything that looks like a job ID
- memo: one short line, e.g. "Replacement compressor for Walk-in 3"
- date: prefer the transaction/receipt date over the print date
- Return ONLY the JSON object, nothing else.`;

async function callClaude(model, contentBlock, accountOptions) {
  const systemPrompt = SYSTEM_PROMPT.replace('{{ACCOUNT_OPTIONS}}', accountOptions || '(none configured)');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            contentBlock,
            { type: 'text', text: 'Extract receipt data. Return only JSON matching the schema. No prose.' },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude ${model} ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

function normalize(extracted, accountLabels) {
  const lineItems = Array.isArray(extracted.line_items) ? extracted.line_items : [];
  const lines = lineItems.map((li) => {
    const qty = Number(li.qty ?? li.quantity ?? 1) || 1;
    const unit = Number(li.unit_price ?? li.unitCost ?? li.unitPrice ?? 0) || 0;
    const amount = Number(li.amount ?? qty * unit) || qty * unit;
    return {
      description: String(li.description ?? '').trim(),
      qty,
      unit_price: unit,
      amount: Math.round(amount * 100) / 100,
    };
  }).filter((li) => li.description);

  let accountGuess = String(extracted.account_guess ?? '').trim();
  if (accountGuess && Array.isArray(accountLabels) && accountLabels.length > 0) {
    const lower = accountGuess.toLowerCase();
    const exact = accountLabels.find((l) => l.toLowerCase() === lower);
    const partial = accountLabels.find((l) =>
      lower.includes(l.toLowerCase()) || l.toLowerCase().includes(lower),
    );
    accountGuess = exact ?? partial ?? accountGuess;
  }

  return {
    vendor: String(extracted.vendor ?? extracted.vendorName ?? '').trim() || null,
    total: Number(extracted.total ?? 0) || null,
    date: extracted.date ?? extracted.billDate ?? null,
    line_items: lines,
    account_guess: accountGuess || null,
    job_number: extracted.job_number ?? extracted.jobNumber ?? null,
    customer_name: extracted.customer_name ?? extracted.customerName ?? null,
    memo: extracted.memo ?? null,
    notes: extracted.notes ?? null,
  };
}

async function parseBody(req) {
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const body = await req.json();
    const fileData = body.fileData || body.file_data || null;
    const mediaType = body.mediaType || body.media_type || 'image/jpeg';
    if (!fileData) throw new Error('JSON body must include fileData (base64) and mediaType');
    return { base64: fileData, mediaType };
  }

  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      throw new Error('multipart body must include a `file` field with the receipt');
    }
    const buf = await file.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    return { base64, mediaType: file.type || 'image/jpeg' };
  }

  throw new Error(`Unsupported content-type: ${contentType}`);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return err('Method not allowed', 405);

  if (!ANTHROPIC_API_KEY) return err('ANTHROPIC_API_KEY not configured on Netlify', 500);

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return err('Unauthorized — Bearer token required', 401);
  }

  let base64, mediaType;
  try {
    ({ base64, mediaType } = await parseBody(req));
  } catch (e) {
    return err(e.message);
  }

  const isPdf = mediaType === 'application/pdf';
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } };

  let accountLabels = [];
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      db: { schema: 'ops' },
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data } = await sb.schema('ops').from('expense_settings').select('value').eq('key', 'cogs_accounts').single();
    if (Array.isArray(data?.value)) {
      accountLabels = data.value.map((a) => a.label || a.name || '').filter(Boolean);
    }
  } catch (e) {
    console.warn('expense-ocr: failed to load cogs_accounts, continuing with free-form guess', e?.message);
  }

  const accountOptions = accountLabels.length > 0 ? accountLabels.join(', ') : '(none configured)';

  let extracted = null;
  let modelUsed = CLAUDE_MODEL;
  let modelError = null;
  try {
    extracted = await callClaude(CLAUDE_MODEL, contentBlock, accountOptions);
  } catch (e) {
    console.warn(`expense-ocr: ${CLAUDE_MODEL} failed, falling back to ${CLAUDE_FALLBACK}`, e?.message);
    modelError = e?.message || 'Primary model failed';
    try {
      extracted = await callClaude(CLAUDE_FALLBACK, contentBlock, accountOptions);
      modelUsed = CLAUDE_FALLBACK;
    } catch (e2) {
      return err('OCR failed on both models', 502, { primary_error: modelError, fallback_error: e2.message });
    }
  }

  const normalized = normalize(extracted, accountLabels);

  return json({
    ok: true,
    model: modelUsed,
    ...normalized,
    raw: extracted,
  });
}

export const config = { path: '/api/expense-ocr' };
