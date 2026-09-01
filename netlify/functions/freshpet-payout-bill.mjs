// Freshpet technician payout → QBO bill.
//
// Called from the Freshpet admin console (Payments tab) to pay a technician for
// the PMs they've completed. This is the PAYOUT side (money we owe the tech, an
// A/P bill), entirely separate from the Freshpet invoice (money Freshpet owes
// us). A PM's `billed` flag (Freshpet) and `paid_out` flag (tech) are
// independent — completing a PM feeds both, neither gates the other.
//
// Flow: verify the caller's Freshpet admin JWT → re-read the tech's payable PMs
// server-side (not prev_comp, not already paid_out) → mode 'preview' returns the
// count/total; mode 'create' posts one QBO bill (vendor = the tech) for
// count × rate against the payout expense account, then stamps those PMs
// paid_out with the bill reference.

import { qboRequest, qboQuery, corsHeaders } from './qbo-helpers.mjs';

const FRESHPET_SUPABASE_URL =
  process.env.FRESHPET_SUPABASE_URL || 'https://mmkncrsaijexezmhfmiw.supabase.co';
const FRESHPET_ANON_KEY =
  process.env.FRESHPET_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ta25jcnNhaWpleGV6bWhmbWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3OTkyMjUsImV4cCI6MjA5NjM3NTIyNX0.lx4J-YhlFFrQVJMqjeBXXHNmgZfRe23xYGKZMEL8dPM';
// Expense account the tech pay lands against (Service COGS by default — same
// fallback expense-to-bill uses). Override with FRESHPET_PAYOUT_ACCOUNT_ID.
const PAYOUT_ACCOUNT_ID = process.env.FRESHPET_PAYOUT_ACCOUNT_ID || '101';

function json(statusCode, obj) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(obj) };
}
function round(n) { return Math.round(Number(n) * 100) / 100; }

async function fpGet(path, jwt) {
  const res = await fetch(`${FRESHPET_SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`Freshpet read ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function fpPatch(path, jwt, body) {
  const res = await fetch(`${FRESHPET_SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Freshpet write ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

async function findOrCreateVendor(name) {
  const safe = String(name).replace(/'/g, "\\'");
  try {
    const exact = await qboQuery(`SELECT * FROM Vendor WHERE DisplayName = '${safe}'`);
    const found = exact?.QueryResponse?.Vendor?.[0];
    if (found) return found;
  } catch (e) { /* fall through to create */ }
  const created = await qboRequest('POST', '/vendor', { DisplayName: name });
  return created.Vendor;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  // ── auth: Freshpet admin JWT ──
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  if (!m) return json(401, { error: 'Missing Authorization bearer token' });
  const jwt = m[1];

  let adminEmail;
  try {
    const uRes = await fetch(`${FRESHPET_SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: FRESHPET_ANON_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!uRes.ok) return json(401, { error: 'Invalid or expired token' });
    adminEmail = (await uRes.json())?.email;
    if (!adminEmail) return json(401, { error: 'Invalid token' });
    const prof = (await fpGet(`tech_profiles?email=eq.${encodeURIComponent(adminEmail)}&select=role`, jwt))[0];
    if (!prof || prof.role !== 'admin') return json(403, { error: 'Freshpet admin role required' });
  } catch (e) {
    return json(502, { error: 'Freshpet auth check failed: ' + e.message });
  }

  // ── payload ──
  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
  const mode = payload.mode === 'create' ? 'create' : 'preview';
  const techUserId = payload.techUserId;
  if (!techUserId) return json(400, { error: 'techUserId is required' });
  // Optional scope: pay only these PM ids (e.g. the Added Assets tab paying
  // just the field-added items). Omitted = every unpaid PM, as before.
  const pmIds = Array.isArray(payload.pmIds) ? payload.pmIds.map(Number).filter(Boolean) : null;
  if (pmIds && !pmIds.length) return json(400, { error: 'pmIds is empty' });

  // ── tech profile + rate ──
  let tech;
  try {
    tech = (await fpGet(`tech_profiles?user_id=eq.${encodeURIComponent(techUserId)}&select=name,email,pm_rate`, jwt))[0];
  } catch (e) {
    return json(502, { error: 'Could not load technician: ' + e.message });
  }
  if (!tech) return json(404, { error: 'Technician profile not found' });
  const rate = payload.rate != null && Number(payload.rate) > 0
    ? round(payload.rate)
    : (tech.pm_rate != null ? round(tech.pm_rate) : null);
  if (!rate) return json(400, { error: `Set a per-PM rate for ${tech.name || tech.email} first` });

  // ── payable PMs (not prev_comp, not already paid out) ──
  // Deliberately does NOT filter on visit_type. A 'reshoot' visit is one we sent
  // the tech back to because our own documentation was unusable — it is excluded
  // from the Freshpet invoice (freshpet-invoice.mjs) but the tech drove the stop
  // and did the work, so it is paid here at the full rate. Do not "tidy" this by
  // mirroring the invoice filter: the asymmetry is the policy.
  //
  // The same goes for a BILLING HOLD (completed_pms.billing_hold_at). A hold is
  // a statement to Freshpet that we are not standing behind our documentation
  // of that unit yet. It says nothing about whether the tech turned up and did
  // the work, so it must not reach into his pay.
  let rows;
  try {
    let path =
      `completed_pms?tech_user_id=eq.${encodeURIComponent(techUserId)}&prev_comp=eq.false&paid_out=eq.false&select=id,store,serial,pm_date,added_asset,visit_type`;
    if (pmIds) path += `&id=in.(${pmIds.join(',')})`;
    rows = await fpGet(path, jwt);
  } catch (e) {
    return json(502, { error: 'Could not load PMs: ' + e.message });
  }
  if (!rows.length) return json(400, { error: pmIds ? 'None of the selected PMs are payable for this technician' : 'No unpaid PMs for this technician' });

  const dates = rows.map(r => r.pm_date).filter(Boolean).sort();
  const periodLabel = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`) : '';
  const count = rows.length;
  const total = round(count * rate);
  const techName = tech.name || tech.email || 'Technician';

  if (mode === 'preview') {
    return json(200, { mode: 'preview', tech: techName, count, rate, total, periodLabel });
  }

  // ── create the QBO bill ──
  let vendor;
  try {
    vendor = await findOrCreateVendor(techName);
    if (!vendor?.Id) throw new Error('vendor unresolved');
  } catch (e) {
    return json(502, { error: 'QBO vendor lookup/create failed: ' + e.message });
  }

  const addedCount = rows.filter(r => r.added_asset).length;
  const addedLabel = addedCount === count && count
    ? ' — field-added assets' : (addedCount ? ` (incl. ${addedCount} field-added)` : '');
  const description = `Freshpet PM technician pay — ${techName} — ${count} PM${count === 1 ? '' : 's'}` +
    addedLabel + (periodLabel ? ` (${periodLabel})` : '');
  const billPayload = {
    VendorRef: { value: vendor.Id },
    Line: [{
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: total,
      Description: description,
      AccountBasedExpenseLineDetail: { AccountRef: { value: PAYOUT_ACCOUNT_ID } },
    }],
    PrivateNote: `Freshpet tech payout · ${count} PMs @ $${rate} · ${periodLabel || 'n/a'} · created by ${adminEmail}`,
  };

  let bill;
  try {
    bill = (await qboRequest('POST', '/bill', billPayload)).Bill;
  } catch (e) {
    return json(502, { error: 'QBO bill create failed: ' + e.message });
  }

  const warnings = [];
  try {
    await fpPatch(`completed_pms?id=in.(${rows.map(r => r.id).join(',')})`, jwt, {
      paid_out: true, payout_amount: rate, payout_bill_id: bill.Id,
      payout_bill_ref: bill.DocNumber || String(bill.Id),
      paid_out_at: new Date().toISOString(), paid_out_by: adminEmail,
    });
  } catch (e) {
    warnings.push(`Bill #${bill.DocNumber || bill.Id} was created but marking the PMs paid FAILED (${e.message}). Do NOT re-bill — mark them manually. PM ids: ${rows.map(r => r.id).join(', ')}`);
  }

  return json(200, {
    mode: 'create',
    bill: {
      id: bill.Id, docNumber: bill.DocNumber || String(bill.Id), total,
      vendor: vendor.DisplayName || techName,
    },
    paidCount: count, rate, periodLabel, warnings,
  });
}
