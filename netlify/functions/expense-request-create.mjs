// expense-request-create — cross-repo bridge (server-to-server)
//
// The APBG Leasing/Rental API (skypace/APBG-Leasing-Rental, on Railway)
// calls this to drop an equipment-purchase vendor bill into Brixpense as
// a purchase_request that routes to a human approver. There is no
// logged-in user on this path, so auth is a shared secret
// (LEASING_BRIDGE_TOKEN) rather than a Supabase JWT, and the insert uses
// the service-role key.
//
// Flow it produces: row in ops.expense_requests with
//   request_type='purchase_request', status='pending',
//   submitted_by = a SYSTEM user (service@brixbev.com) so the approver
//   (manager_email) is always a different person — the self-approval
//   guard in expense-request-decide then passes. The approver reviews +
//   approves at /expense/review/:id exactly like a normal PR, and
//   expense-request-link-bill posts the QBO bill on approval.
//
// Registered in architecture/sync-manifest.json as a writer of
// ops.expense_requests.

import { createClient } from '@supabase/supabase-js';
import { sendEmail, SITE_URL } from './email-helpers.mjs';

// Hardcoded like the other expense functions — the project ref is not a
// secret and a mis-set env var shouldn't break the bridge.
const SUPABASE_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';

// System submitter (service@brixbev.com). Distinct from any human
// approver so expense-request-decide's caller != submitter guard holds.
const SUBMITTER_UID =
  process.env.BRIDGE_SUBMITTER_UID || '6a7c5b8e-e485-4cf0-952f-22c076865577';
const SUBMITTER_EMAIL =
  process.env.BRIDGE_SUBMITTER_EMAIL || 'service@brixbev.com';
const DEFAULT_APPROVER_EMAIL =
  process.env.BRIDGE_APPROVER_EMAIL || 'skypace@brixbev.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Bridge-Token',
  'Content-Type': 'application/json',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: CORS });
const err = (m, s = 400) => json({ error: m }, s);
const fmt = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n || 0));

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  if (req.method !== 'POST') return err('POST only', 405);

  // ── Shared-secret auth (server-to-server) ──
  const expected = process.env.LEASING_BRIDGE_TOKEN;
  if (!expected) return err('Bridge not configured (LEASING_BRIDGE_TOKEN unset)', 503);
  const got =
    req.headers.get('x-bridge-token') ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!got || got !== expected) return err('Unauthorized', 401);

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return err('SUPABASE_SERVICE_ROLE_KEY not set', 500);

  let body;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body');
  }

  const {
    vendor_name,
    total_amount,
    receipt_date,
    memo,
    line_items,
    entity,
    approver_email,
    source_ref,
  } = body || {};

  if (!vendor_name || !String(vendor_name).trim()) return err('vendor_name is required');
  const amount = total_amount == null ? null : Number(total_amount);
  if (amount == null || Number.isNaN(amount) || amount <= 0) {
    return err('total_amount must be a positive number');
  }

  const managerEmail = (approver_email || DEFAULT_APPROVER_EMAIL).trim();
  const lines =
    Array.isArray(line_items) && line_items.length
      ? line_items
      : [
          {
            description: memo || `Equipment purchase — ${vendor_name}`,
            qty: 1,
            unit_price: amount,
            amount,
          },
        ];

  const sb = createClient(SUPABASE_URL, serviceKey, {
    db: { schema: 'ops' },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const insert = {
    request_type: 'purchase_request',
    status: 'pending', // straight into the approver queue
    submitted_by: SUBMITTER_UID,
    submitter_name: 'APBG Leasing/Rental',
    submitter_email: SUBMITTER_EMAIL,
    entity: entity || 'brix',
    vendor_name: String(vendor_name).trim(),
    total_amount: amount,
    receipt_date: receipt_date || null,
    tag: 'Equipment Purchase',
    memo: memo || null,
    line_items: lines,
    manager_email: managerEmail,
    description: source_ref
      ? `APBG Leasing equipment purchase · ${source_ref}`
      : 'APBG Leasing equipment purchase',
  };

  const { data: row, error: insErr } = await sb
    .from('expense_requests')
    .insert(insert)
    .select('id, status')
    .single();

  if (insErr || !row) return err(`Insert failed: ${insErr?.message || 'no row returned'}`, 500);

  // ── Best-effort approver notification (never fatal) ──
  let email_sent = false;
  let email_error = null;
  try {
    const reviewUrl = `${SITE_URL.replace(/\/$/, '')}/expense/review/${row.id}`;
    const sent = await sendEmail({
      to: managerEmail,
      subject: `Equipment purchase to approve — ${vendor_name} ${fmt(amount)}`,
      html:
        `<p>A vendor bill for an equipment purchase needs your approval in Brixpense.</p>` +
        `<p><strong>Vendor:</strong> ${vendor_name}<br/>` +
        `<strong>Amount:</strong> ${fmt(amount)}<br/>` +
        (memo ? `<strong>Notes:</strong> ${memo}<br/>` : '') +
        `</p>` +
        `<p><a href="${reviewUrl}">Review &amp; approve →</a></p>` +
        `<p style="color:#888;font-size:12px">Submitted automatically by APBG Leasing/Rental.</p>`,
    });
    email_sent = !!sent;
  } catch (e) {
    email_error = e?.message || String(e);
  }

  return json({
    ok: true,
    id: row.id,
    status: row.status,
    manager_email: managerEmail,
    email_sent,
    email_error,
  });
}

export const config = { path: '/api/expense-request-create' };
