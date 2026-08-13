// expense-ocr-core.mjs — shared Claude bill/receipt OCR extraction.
// Used by both the interactive endpoint (expense-ocr.mjs, human upload in the
// Brixpense form) and the SF-expense OCR gate (sf-expense-ocr-background.mjs,
// automated SF drafts). One schema, one prompt, one place to fix — the manual
// and automated paths must never drift on what "bill_number" means.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_OCR_MODEL || 'claude-sonnet-4-5-20250929';
const CLAUDE_FALLBACK = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You extract structured data from receipts and vendor invoices for a beverage-distributor expense system.
Return ONLY valid JSON — no markdown, no backticks, no preamble. Schema:

{
  "vendor": "string",
  "bill_number": "string or null (the vendor's own invoice/bill/receipt number — look for \\"Invoice #\\", \\"Bill No.\\", \\"Receipt #\\", \\"Ref #\\" near the header or footer; do NOT invent one)",
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
- bill_number: this is the VENDOR's own document number, not a job/PO/work-order number — if the only number on the document is a job/PO/WO number, leave bill_number null
- memo: one short line, e.g. "Replacement compressor for Walk-in 3"
- date: prefer the transaction/receipt date over the print date
- Return ONLY the JSON object, nothing else.`;

export function contentBlockFor(base64, mediaType) {
  const isPdf = mediaType === 'application/pdf';
  return isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } };
}

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

  const billNumber = String(extracted.bill_number ?? extracted.billNumber ?? extracted.invoice_number ?? '').trim();

  return {
    vendor: String(extracted.vendor ?? extracted.vendorName ?? '').trim() || null,
    bill_number: billNumber || null,
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

// Runs the primary model, falls back to a cheaper model on failure. Throws
// only when BOTH models fail — callers decide what "OCR failed" means for
// their flow (interactive error vs. background hold-for-review).
export async function runExpenseOcr({ base64, mediaType, accountLabels = [] }) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured on Netlify');
  const contentBlock = contentBlockFor(base64, mediaType);
  const accountOptions = accountLabels.length > 0 ? accountLabels.join(', ') : '(none configured)';

  let extracted, modelUsed = CLAUDE_MODEL, primaryError = null;
  try {
    extracted = await callClaude(CLAUDE_MODEL, contentBlock, accountOptions);
  } catch (e) {
    primaryError = e?.message || 'Primary model failed';
    extracted = await callClaude(CLAUDE_FALLBACK, contentBlock, accountOptions);
    modelUsed = CLAUDE_FALLBACK;
  }

  const normalized = normalize(extracted, accountLabels);
  return { ok: true, model: modelUsed, primary_error: primaryError, ...normalized, raw: extracted };
}
