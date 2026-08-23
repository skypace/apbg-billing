// bills-inbox.mjs — the API behind Brixpense → AP Inbox (/expense/bills).
//
// GET                        → the queue: every email that hit bills@, its
//                              outcome, and the bill draft it produced.
// POST {action:'reprocess'}  → re-run one email through OCR (after fixing a
//                              key, or once a sender re-sends a better PDF).
// POST {action:'dismiss'}    → drop an email off the queue (soft; the row and
//                              its dedup key stay, so it can't re-land).
// POST {action:'settings'}   → edit the inbox config (address, notify list,
//                              sender rules) without a deploy.
// POST {action:'check'}      → is the pipeline actually armed?
//
// Everyone in Brixpense, via requireBrixpense — the same predicate as the RLS.

import { SUPABASE_URL } from './supabase-helpers.mjs';
import {
  AP_TAG, opsGet, opsPatch, loadApInboxSettings, inboundSecrets, srHeaders,
  requireBrixpense,
} from './lib/ap-inbox.mjs';
import { inboundResendKey, inboundKeyIsFallback } from './lib/resend-inbound.mjs';

const LOOKBACK_DAYS = Number(process.env.AP_INBOX_LOOKBACK_DAYS || 120);

async function signedUrl(storagePath) {
  if (!storagePath) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/expense-attachments/${storagePath}`, {
      method: 'POST',
      headers: srHeaders(),
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    if (!res.ok) return null;
    const { signedURL, signedUrl: alt } = await res.json();
    const rel = signedURL || alt;
    return rel ? `${SUPABASE_URL}/storage/v1${rel.startsWith('/') ? '' : '/'}${rel}` : null;
  } catch { return null; }
}

// The three things that must ALL be true for a forwarded bill to land, none of
// which are visible from the app: deployed, routed, and holding the signing
// secret Resend actually signs with.
//
// ⚠ This reports "armed", NOT "verified". A 401 from the intake proves only
// that SOME secret is configured — a wrong secret answers identically. Only a
// real email proves the secret matches. Saying otherwise turns a visible gap
// into a false all-clear, which is worse than no check at all.
async function setupCheck(settings) {
  const secrets = inboundSecrets();
  const out = {
    inbox: settings.inbox,
    enabled: settings.enabled,
    signing_secret_present: secrets.length > 0,
    signing_secret_var: process.env.RESEND_AP_INBOX_SECRET
      ? 'RESEND_AP_INBOX_SECRET'
      : (process.env.RESEND_INBOUND_SECRET ? 'RESEND_INBOUND_SECRET (fallback)' : null),
    signing_secret_is_fallback: !process.env.RESEND_AP_INBOX_SECRET && !!process.env.RESEND_INBOUND_SECRET,
    reader_key_present: !!inboundResendKey(),
    reader_key_is_send_only_fallback: inboundKeyIsFallback(),
    anthropic_key_present: !!process.env.ANTHROPIC_API_KEY,
    service_role_present: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  const blockers = [];
  if (!out.enabled) blockers.push('The AP inbox is switched off in settings.');
  if (!out.signing_secret_present) {
    blockers.push('No webhook signing secret — set RESEND_AP_INBOX_SECRET to this route\'s whsec_ value. The intake fails closed (503) without it.');
  } else if (out.signing_secret_is_fallback) {
    blockers.push('Falling back to RESEND_INBOUND_SECRET. Resend mints a SEPARATE secret per webhook endpoint, so unless this route was registered against that same secret, every inbound email will fail signature verification.');
  }
  if (!out.reader_key_present) {
    blockers.push('No Resend API key to read inbound mail — set RESEND_INBOUND_API_KEY.');
  } else if (out.reader_key_is_send_only_fallback) {
    blockers.push('Reading inbound mail with RESEND_API_KEY. If that key was created with sending access it will 401 on every attachment read — set RESEND_INBOUND_API_KEY to a FULL-ACCESS key.');
  }
  if (!out.anthropic_key_present) blockers.push('ANTHROPIC_API_KEY missing — bills cannot be OCR\'d.');
  if (!out.service_role_present) blockers.push('SUPABASE_SERVICE_ROLE_KEY missing — nothing can be written.');

  out.blockers = blockers;
  out.armed = blockers.length === 0;
  out.caveat = 'Armed means the pieces are in place. Only a real forwarded email proves the signing secret matches what Resend signs with.';
  return out;
}

export default async function handler(req) {
  // Everyone in Brixpense — this is the master vendor inbox and unassigned
  // mail is everybody's problem (Sky, 2026-08-23). Same predicate as the RLS
  // on ops.bill_email_intake, so the API and the database agree by
  // construction rather than by two hand-maintained role lists.
  const auth = await requireBrixpense(req);
  if (!auth.ok) return auth.response;

  const settings = await loadApInboxSettings();

  if (req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch { /* empty */ }
    const action = body.action || '';

    if (action === 'check') {
      return Response.json({ ok: true, check: await setupCheck(settings) });
    }

    if (action === 'settings') {
      const next = {
        enabled: body.enabled !== false,
        inbox: String(body.inbox || settings.inbox).trim().toLowerCase(),
        notify: Array.isArray(body.notify) ? body.notify.map(String).map((s) => s.trim()).filter(Boolean) : settings.notify,
        allow_senders: Array.isArray(body.allow_senders) ? body.allow_senders.map(String).map((s) => s.trim().toLowerCase()).filter(Boolean) : settings.allow_senders,
        block_senders: Array.isArray(body.block_senders) ? body.block_senders.map(String).map((s) => s.trim().toLowerCase()).filter(Boolean) : settings.block_senders,
        ack_sender: body.ack_sender !== false,
        require_approval: body.require_approval === true,
        sender_routes: body.sender_routes ?? settings.sender_routes,
        vendor_routes: body.vendor_routes ?? settings.vendor_routes,
        department_approvers: body.department_approvers ?? settings.department_approvers,
        default_approver: body.default_approver === undefined
          ? settings.default_approver
          : (String(body.default_approver || '').trim().toLowerCase() || null),
      };
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.inbox)) {
        return Response.json({ error: 'inbox must be a valid email address' }, { status: 400 });
      }
      if (!next.inbox.endsWith('@alamedapointbg.com')) {
        return Response.json({
          error: 'The inbox must be on alamedapointbg.com — that is the domain with Resend inbound (MX) enabled.',
        }, { status: 400 });
      }
      await opsPatch('expense_settings', 'key=eq.ap_inbox', { value: next });
      return Response.json({ ok: true, settings: next });
    }

    // Approve an emailed bill — the review sign-off that unlocks posting.
    //
    // Deliberately NOT expense-request-decide: this is scoped to AP-Inbox
    // rows, and the person signing off is usually the sender (see
    // resolveBillRouting). Whether that is a self-review is recorded on the
    // row rather than hidden, so the audit trail says what actually happened.
    if (action === 'approve') {
      const id = String(body.request_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: 'request_id required' }, { status: 400 });

      const rows = await opsGet(
        `expense_requests?id=eq.${id}&select=id,status,tag,request_type,manager_email,submitter_email&limit=1`,
      );
      const r = rows?.[0];
      if (!r) return Response.json({ error: 'Bill not found' }, { status: 404 });
      if (r.tag !== AP_TAG || r.request_type !== 'expense') {
        return Response.json({ error: 'Not an AP Inbox bill — approve it from the normal queue.' }, { status: 400 });
      }
      if (r.status !== 'pending') {
        return Response.json({ error: `Cannot approve a bill with status "${r.status}".` }, { status: 409 });
      }

      const caller = String(auth.user?.email || '').toLowerCase();
      const routedTo = String(r.manager_email || '').toLowerCase();
      const isSuperadmin = auth.role === 'superadmin';
      if (routedTo && routedTo !== caller && !isSuperadmin) {
        return Response.json({
          error: `This bill is waiting on ${r.manager_email}, not you (${auth.user?.email}).`,
        }, { status: 403 });
      }

      const selfReview = routedTo && routedTo === String(r.submitter_email || '').toLowerCase();
      await opsPatch('expense_requests', `id=eq.${id}`, {
        status: 'approved',
        approved_by: `${auth.user?.email || 'staff'}${selfReview ? ' (own emailed bill)' : ''}`,
        approved_at: new Date().toISOString(),
      });
      return Response.json({ ok: true, status: 'approved', self_review: !!selfReview });
    }

    // Hand an unowned bill to somebody — the triage move for vendor mail that
    // matched no routing rule.
    if (action === 'assign') {
      const id = String(body.request_id || '');
      const to = String(body.approver_email || '').trim().toLowerCase();
      if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: 'request_id required' }, { status: 400 });
      if (!to.includes('@')) return Response.json({ error: 'approver_email required' }, { status: 400 });

      const rows = await opsGet(`expense_requests?id=eq.${id}&select=id,status,tag&limit=1`);
      const r = rows?.[0];
      if (!r) return Response.json({ error: 'Bill not found' }, { status: 404 });
      if (r.tag !== AP_TAG) return Response.json({ error: 'Not an AP Inbox bill.' }, { status: 400 });
      if (!['draft', 'pending'].includes(r.status)) {
        return Response.json({ error: `Cannot reassign a bill with status "${r.status}".` }, { status: 409 });
      }
      await opsPatch('expense_requests', `id=eq.${id}`, { manager_email: to, status: 'pending' });
      return Response.json({ ok: true, assigned_to: to });
    }

    if (action === 'reprocess' || action === 'dismiss') {
      const id = String(body.intake_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: 'intake_id required' }, { status: 400 });

      if (action === 'dismiss') {
        await opsPatch('bill_email_intake', `id=eq.${id}`, {
          status: 'ignored',
          status_detail: `dismissed by ${auth.user?.email || 'staff'}`,
          processed_at: new Date().toISOString(),
        });
        return Response.json({ ok: true, status: 'ignored' });
      }

      const rows = await opsGet(`bill_email_intake?id=eq.${id}&select=reprocess_count&limit=1`);
      await opsPatch('bill_email_intake', `id=eq.${id}`, {
        status: 'received',
        status_detail: null,
        notified_at: null,          // let the outcome be announced again
        reprocess_count: (rows?.[0]?.reprocess_count || 0) + 1,
      });
      const base = process.env.URL || 'https://apbg-billing.netlify.app';
      try {
        await fetch(`${base}/.netlify/functions/bill-email-process-background`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-ap-inbox-secret': process.env.SUPABASE_SERVICE_ROLE_KEY || '' },
          body: JSON.stringify({ intake_id: id, force: true }),
        });
      } catch (e) {
        return Response.json({ ok: true, queued: false, note: `queued in the table, but the background kick failed: ${e?.message || e}` });
      }
      return Response.json({ ok: true, queued: true });
    }

    return Response.json({ error: `unknown action ${action}` }, { status: 400 });
  }

  // ── GET: the queue ──
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const intakes = await opsGet(
      `bill_email_intake?received_at=gte.${since}&order=received_at.desc&limit=200`
      + `&select=id,resend_email_id,from_email,from_name,subject,received_at,status,status_detail,diagnostics,`
      + `attachment_count,storage_path,file_name,file_type,expense_request_id,ocr_result,processed_at,reprocess_count`,
    );

    const ids = intakes.map((i) => i.expense_request_id).filter(Boolean);
    let requests = [];
    if (ids.length) {
      requests = await opsGet(
        `expense_requests?id=in.(${ids.join(',')})`
        + `&select=id,vendor_name,bill_number,total_amount,receipt_date,status,manager_email,submitter_email,approved_by,approved_at,qbo_bill_id,posted_at,autopost_error,archived_at`,
      );
    }
    const byId = new Map(requests.map((r) => [r.id, r]));

    const items = await Promise.all(intakes.map(async (i) => {
      const r = i.expense_request_id ? byId.get(i.expense_request_id) : null;
      const ocr = i.ocr_result && typeof i.ocr_result === 'object' ? i.ocr_result : null;
      return {
        id: i.id,
        received_at: i.received_at,
        from_email: i.from_email,
        from_name: i.from_name,
        subject: i.subject,
        status: i.status,
        status_detail: i.status_detail,
        diagnostics: i.diagnostics,
        attachment_count: i.attachment_count,
        file_name: i.file_name,
        file_url: await signedUrl(i.storage_path),
        reprocess_count: i.reprocess_count,
        request: r
          ? {
              id: r.id,
              vendor_name: r.vendor_name,
              bill_number: r.bill_number,
              total_amount: r.total_amount == null ? null : Number(r.total_amount),
              receipt_date: r.receipt_date,
              status: r.status,
              posted: !!r.qbo_bill_id,
              qbo_bill_id: r.qbo_bill_id,
              posted_at: r.posted_at,
              post_error: r.autopost_error,
              archived: !!r.archived_at,
              // Whose queue it is sitting in, and whether it has cleared the
              // approval gate. `can_post` is the single thing the UI needs to
              // decide if the Post button is live.
              owner_email: r.manager_email,
              approved_by: r.approved_by,
              approved_at: r.approved_at,
              awaiting_approval: r.status === 'pending',
              unassigned: !r.manager_email && !r.qbo_bill_id,
              can_post: !r.qbo_bill_id && (
                settings.require_approval
                  ? ['approved', 'awaiting_invoice', 'fulfilled'].includes(r.status)
                  : ['approved', 'awaiting_invoice', 'fulfilled', 'draft', 'pending'].includes(r.status)
              ),
            }
          : null,
        ocr_preview: ocr ? { vendor: ocr.vendor, total: ocr.total, bill_number: ocr.bill_number, date: ocr.date } : null,
      };
    }));

    const count = (fn) => items.filter(fn).length;
    return Response.json({
      ok: true,
      settings,
      tag: AP_TAG,
      summary: {
        total: items.length,
        awaiting_approval: count((i) => i.request?.awaiting_approval),
        ready_to_post: count((i) => i.request?.can_post),
        unassigned: count((i) => i.request?.unassigned),
        posted: count((i) => i.request?.posted),
        needs_attention: count((i) => ['no_attachment', 'attachment_fetch_failed', 'ocr_failed', 'failed', 'sender_rejected'].includes(i.status)),
        in_progress: count((i) => ['received', 'processing'].includes(i.status)),
      },
      me: auth.user?.email || null,
      items,
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export const config = { path: '/api/bills-inbox' };
