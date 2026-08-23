import { createClient } from '@supabase/supabase-js';
import { runExpenseOcr } from './lib/expense-ocr-core.mjs';

// Hardcoded — anon key is a PUBLIC client identifier per Supabase
// architecture. Prevents a mis-set Netlify env var from breaking us.
const SUPABASE_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function json(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: CORS }); }
function err(m, s = 400, extra = {}) { return json({ error: m, ...extra }, s); }

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

  try {
    const result = await runExpenseOcr({ base64, mediaType, accountLabels });
    return json(result);
  } catch (e) {
    return err('OCR failed on both models', 502, { error_detail: e?.message });
  }
}

export const config = { path: '/api/expense-ocr' };
