// compliance-expiry-cron.mjs — the smoke detector on the compliance filing cabinet.
//
// Every Monday 15:30 UTC (8:30am PT):
//  1. STAFF DIGEST — reads ops.compliance_documents and emails a digest to
//     COMPLIANCE_ALERT_TO (default service@brixbev.com) when any non-archived
//     document is expired or expires within 60 days. Quiet when current.
//  2. VENDOR CHASE (Vendor Portal Phase 2) — vendors whose COI is expired,
//     expiring within 30 days, or missing against their requirements get a
//     DIRECT chase email with a fresh one-time docs_refresh link
//     (/vendor-onboarding). Throttled to one chase per vendor per 7 days
//     (keyed on the last docs_refresh token minted). Every run — chases or
//     not — logs to ops.sync_log (source 'vendors', sync_type
//     'vendor_doc_chase'), which feeds the vendor_doc_chase health check.
//
// Documents live in Refractor → Production → Compliance & Safety; vendors in
// Brixpense → Vendors.
//
// Env: SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY/SENDGRID_API_KEY,
//      COMPLIANCE_ALERT_TO (optional recipient override).

import { requireScheduled } from './lib/auth.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';
import { ops, mintToken, requestDocsEmailHtml } from './lib/vendor-onboard-lib.mjs';

const ALERT_TO = process.env.COMPLIANCE_ALERT_TO || 'service@brixbev.com';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const WINDOW_DAYS = 60;

const CATEGORY_LABEL = {
  insurance: 'Insurance',
  permit: 'Permits & Registrations',
  food_safety: 'Food Safety & QA',
  safety: 'Safety',
  tax: 'Tax',
  other: 'Other',
};
const ENTITY_LABEL = {
  alameda_soda: 'Alameda Soda',
  brix: 'Brix Beverage',
  freeflow: 'FreeFlow',
  shared: 'Shared',
};

async function opsGet(qs) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${qs}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Accept-Profile': 'ops',
    },
  });
  if (!res.ok) throw new Error(`ops read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default async function handler(req, context) {
  const gate = requireScheduled(req, context);
  if (!gate.ok) return gate.response;

  console.log('[compliance-expiry-cron] weekly expiration check starting');

  const cutoff = new Date(Date.now() + WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  let docs;
  try {
    docs = await opsGet(
      'compliance_documents?select=id,category,doc_type,holder_entity,facility,issuer,reference_number,expiration_date,party:insured_parties(name)'
      + `&archived_at=is.null&expiration_date=not.is.null&expiration_date=lte.${cutoff}`
      + '&order=expiration_date.asc',
    );
  } catch (e) {
    console.error('[compliance-expiry-cron] read failed:', e.message);
    // The vendor chase still runs — a broken digest read must not silently
    // skip the chase week after week.
    const chase = await runVendorChase();
    return new Response(JSON.stringify({ ok: false, error: e.message, chase }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const expired = docs.filter((d) => d.expiration_date < today);
  const expiring = docs.filter((d) => d.expiration_date >= today);
  console.log(`[compliance-expiry-cron] ${expired.length} expired / ${expiring.length} expiring within ${WINDOW_DAYS}d`);

  if (docs.length === 0) {
    const chase = await runVendorChase();
    return new Response(JSON.stringify({ ok: true, expired: 0, expiring: 0, chase }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const row = (d, color) => {
    const holder = d.party?.name || ENTITY_LABEL[d.holder_entity] || '—';
    const days = Math.round((new Date(d.expiration_date + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86_400_000);
    const when = days < 0 ? `expired ${-days}d ago` : days === 0 ? 'expires TODAY' : `expires in ${days}d`;
    return `<tr><td style="padding:8px 10px;border-bottom:1px solid #EDF1F6">
      <div style="font-weight:600;color:#0F172A">${esc(d.doc_type)} <span style="color:${color};font-weight:700;font-size:12px">· ${esc(d.expiration_date)} (${when})</span></div>
      <div style="color:#9CA3AF;font-size:12px">${esc(CATEGORY_LABEL[d.category] || d.category)} · ${esc(holder)}${d.facility ? ` · ${esc(d.facility)}` : ''}${d.issuer ? ` · ${esc(d.issuer)}` : ''}${d.reference_number ? ` · #${esc(d.reference_number)}` : ''}</div>
    </td></tr>`;
  };

  const sections = [];
  if (expired.length) {
    sections.push(`<p style="color:#B91C1C;font-weight:700;font-size:13px;margin:14px 0 4px">EXPIRED (${expired.length})</p>
      <table style="width:100%;border-collapse:collapse">${expired.map((d) => row(d, '#B91C1C')).join('')}</table>`);
  }
  if (expiring.length) {
    sections.push(`<p style="color:#B45309;font-weight:700;font-size:13px;margin:14px 0 4px">EXPIRING WITHIN ${WINDOW_DAYS} DAYS (${expiring.length})</p>
      <table style="width:100%;border-collapse:collapse">${expiring.map((d) => row(d, '#B45309')).join('')}</table>`);
  }

  const html = `
  <div style="font-family:'DM Sans',-apple-system,sans-serif;max-width:640px;margin:0 auto">
    <div style="background:${expired.length ? '#B91C1C' : '#B45309'};color:#fff;padding:14px 20px;border-radius:10px 10px 0 0;font-weight:700">
      🗂 Compliance documents need attention — ${expired.length} expired · ${expiring.length} expiring
    </div>
    <div style="border:1px solid #E4E9F0;border-top:none;border-radius:0 0 10px 10px;padding:18px 20px">
      <p style="color:#374151;font-size:14px;margin:0">
        The weekly sweep of the compliance vault (permits, insurance, food-safety audits) found:
      </p>
      ${sections.join('')}
      <p style="margin:18px 0 6px">
        <a href="https://alamedapointbg.com/margin/#production?tab=compliance"
           style="background:#1F4E79;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px;display:inline-block">
          Open Refractor → Production → Compliance &amp; Safety
        </a>
      </p>
      <p style="color:#9CA3AF;font-size:12px;margin-top:14px">
        Upload the renewed document (or archive the old one) to clear an item from this digest.
      </p>
    </div>
  </div>`;

  try {
    await sendEmail({
      to: ALERT_TO,
      subject: `🗂 Compliance: ${expired.length} expired · ${expiring.length} expiring — ${docs.slice(0, 3).map((d) => d.doc_type).join(', ')}${docs.length > 3 ? '…' : ''}`,
      html,
      text: docs.map((d) => `${d.expiration_date} — ${d.doc_type} (${d.party?.name || ENTITY_LABEL[d.holder_entity] || ''})`).join('\n'),
    });
    console.log(`[compliance-expiry-cron] digest sent to ${ALERT_TO}`);
  } catch (e) {
    console.error('[compliance-expiry-cron] email failed (results still in logs):', e.message);
  }

  const chase = await runVendorChase();
  return new Response(JSON.stringify({ ok: true, expired: expired.length, expiring: expiring.length, emailed: ALERT_TO, chase }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Vendor document chase (Vendor Portal Phase 2) ───────────────────────────
// Chase = the vendor's governing COI (latest-expiring live insurance doc in
// the vault) is expired or expires within 30 days, OR they have coverage
// requirements set and no COI at all. One chase per vendor per 7 days,
// throttled on the last docs_refresh token minted (mint = attempt). Every run
// logs to ops.sync_log so the vendor_doc_chase health check can see a missed
// Monday; per-vendor email failures only flip the run to 'error' when NOTHING
// went out (one transient bounce must not page red for a week).
const CHASE_WINDOW_DAYS = 30;
const CHASE_THROTTLE_DAYS = 7;

function vendorRequirementsSet(req) {
  const r = req || {};
  return Boolean(r.gl_each_occurrence || r.wc_required || r.auto_required || r.additional_insured_required);
}

async function runVendorChase() {
  const result = { checked: 0, chased: 0, throttled: 0, skipped_no_email: 0, errors: [] };
  let attempted = 0;
  try {
    const vendors = await opsGet('vendors?select=id,display_name,contact_email,insured_party_id,requirements&archived_at=is.null');
    result.checked = vendors.length;
    const partyIds = vendors.map((v) => v.insured_party_id).filter(Boolean);
    const insDocs = partyIds.length > 0
      ? await opsGet(`compliance_documents?select=party_id,expiration_date&archived_at=is.null&category=eq.insurance&party_id=in.(${partyIds.join(',')})`)
      : [];
    const byParty = new Map();
    for (const d of insDocs) {
      const list = byParty.get(d.party_id) || [];
      list.push(d);
      byParty.set(d.party_id, list);
    }

    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + CHASE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
    const throttleSince = new Date(Date.now() - CHASE_THROTTLE_DAYS * 86_400_000).toISOString();

    for (const v of vendors) {
      const ins = v.insured_party_id ? (byParty.get(v.insured_party_id) || []) : [];
      // Governing certificate = the one that expires last; a no-expiry doc
      // counts as evergreen coverage and suppresses the chase.
      let exp = null, evergreen = false;
      for (const d of ins) {
        if (!d.expiration_date) evergreen = true;
        else if (!exp || d.expiration_date > exp) exp = d.expiration_date;
      }
      let reason = null;
      if (ins.length === 0) {
        if (vendorRequirementsSet(v.requirements)) reason = 'we do not have a certificate of insurance on file for you';
      } else if (!evergreen && exp) {
        if (exp < today) reason = `the certificate of insurance we have on file expired ${exp}`;
        else if (exp <= soon) reason = `the certificate of insurance we have on file expires ${exp}`;
      }
      if (!reason) continue;
      if (!v.contact_email) { result.skipped_no_email++; continue; }

      const recent = await opsGet(
        `vendor_onboard_tokens?select=id&vendor_id=eq.${v.id}&purpose=eq.docs_refresh&created_at=gte.${encodeURIComponent(throttleSince)}&limit=1`,
      );
      if (recent && recent.length > 0) { result.throttled++; continue; }

      attempted++;
      try {
        const { link } = await mintToken({
          vendorId: v.id, purpose: 'docs_refresh', sentTo: v.contact_email, createdBy: 'chase-cron',
        });
        await sendEmail({
          to: v.contact_email,
          subject: `${v.display_name} — insurance certificate update needed (Brix Beverage)`,
          html: requestDocsEmailHtml({ vendorName: v.display_name, link, mode: 'chase', reason }),
          text: `Hello — ${reason}. Please send us an updated certificate using this secure link (expires in 14 days): ${link}`,
        });
        result.chased++;
      } catch (e) {
        result.errors.push(`${v.display_name}: ${String(e.message || e).slice(0, 120)}`);
      }
    }

    const status = result.errors.length > 0 && result.chased === 0 && attempted > 0 ? 'error' : 'success';
    await ops('POST', 'sync_log', {
      source: 'vendors',
      sync_type: 'vendor_doc_chase',
      status,
      error_message: result.errors.length ? result.errors.join(' | ').slice(0, 400) : null,
      metadata: result,
      completed_at: new Date().toISOString(),
    });
    console.log(`[compliance-expiry-cron] vendor chase: ${result.chased} chased / ${result.throttled} throttled / ${result.checked} checked`);
  } catch (e) {
    console.error('[compliance-expiry-cron] vendor chase failed:', e.message);
    result.errors.push(String(e.message || e).slice(0, 200));
    try {
      await ops('POST', 'sync_log', {
        source: 'vendors', sync_type: 'vendor_doc_chase', status: 'error',
        error_message: String(e.message || e).slice(0, 400), metadata: result,
        completed_at: new Date().toISOString(),
      });
    } catch { /* the health check's yellow >8d rule catches a run that could not even log */ }
  }
  return result;
}

export const config = {
  schedule: '30 15 * * 1',
};
