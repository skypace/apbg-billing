// handbook-sweep-cron.mjs — the automatic half of "no drift".
//
// Every Monday 15:00 UTC (8am PT) this runs the same sweep as the Master
// Control button. If any handbook chapter has gone stale (a registered
// source file has commits newer than the chapter's last_reviewed date), it
// emails a digest to HANDBOOK_ALERT_TO (default service@brixbev.com) with
// the stale list and a link to Master Control, where one click drafts the
// fix PR (Auto-update). Quiet when everything is fresh — no noise.
//
// Env: GITHUB_TOKEN (read), RESEND_API_KEY/SENDGRID_API_KEY (email),
//      HANDBOOK_ALERT_TO (optional recipient override).

import { requireScheduled } from './lib/auth.mjs';
import { GH_TOKEN, loadManifest, computeSweep } from './lib/handbook.mjs';
import { sendEmail } from './email-helpers.mjs';

const ALERT_TO = process.env.HANDBOOK_ALERT_TO || 'service@brixbev.com';

export default async function handler(req, context) {
  const gate = requireScheduled(req, context);
  if (!gate.ok) return gate.response;

  console.log('[handbook-sweep-cron] weekly drift check starting');

  if (!GH_TOKEN) {
    console.warn('[handbook-sweep-cron] GITHUB_TOKEN not set — private-repo sources unreadable; sweep results will be mostly "unknown"');
  }

  let manifest, chapters;
  try {
    manifest = await loadManifest();
    chapters = await computeSweep(manifest);
  } catch (e) {
    console.error('[handbook-sweep-cron] sweep failed:', e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stale = chapters.filter((c) => c.status === 'stale');
  const unknown = chapters.filter((c) => c.status === 'unknown');
  console.log(`[handbook-sweep-cron] ${stale.length} stale / ${chapters.length - stale.length - unknown.length} fresh / ${unknown.length} unknown`);

  if (stale.length === 0) {
    // Fresh handbook = silent week. The button in Master Control is always
    // there for on-demand checks.
    return new Response(JSON.stringify({ ok: true, stale: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rows = stale
    .map((c) => {
      const srcs = c.sources
        .filter((s) => s.stale)
        .map(
          (s) =>
            `<div style="color:#6B7280;font-size:12px;margin-left:12px">↳ <a href="${s.commit_url || '#'}">${s.repo}/${s.path}</a> · ${(s.last_commit || '').slice(0, 10)} · ${s.message || ''}</div>`
        )
        .join('');
      return `<tr><td style="padding:8px 10px;border-bottom:1px solid #EDF1F6">
        <div style="font-weight:600;color:#0F172A">${c.title}</div>
        <div style="color:#9CA3AF;font-size:12px">last reviewed ${c.last_reviewed} · owner ${c.owner}</div>
        ${srcs}
      </td></tr>`;
    })
    .join('');

  const html = `
  <div style="font-family:'DM Sans',-apple-system,sans-serif;max-width:640px;margin:0 auto">
    <div style="background:#B45309;color:#fff;padding:14px 20px;border-radius:10px 10px 0 0;font-weight:700">
      📖 Handbook drift — ${stale.length} chapter${stale.length === 1 ? '' : 's'} out of date
    </div>
    <div style="border:1px solid #E4E9F0;border-top:none;border-radius:0 0 10px 10px;padding:18px 20px">
      <p style="color:#374151;font-size:14px;margin:0 0 12px">
        The weekly sweep found source documents that changed after these chapters were last reviewed:
      </p>
      <table style="width:100%;border-collapse:collapse">${rows}</table>
      <p style="margin:18px 0 6px">
        <a href="https://alamedapointbg.com/control"
           style="background:#1F4E79;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px;display:inline-block">
          Open Master Control → Run sweep → 🤖 Auto-update
        </a>
      </p>
      <p style="color:#9CA3AF;font-size:12px;margin-top:14px">
        Auto-update drafts a review PR — nothing merges without human eyes (SOP-0).
        Handbook: <a href="https://alamedapointbg.com/margin/docs/handbook/">alamedapointbg.com/margin/docs/handbook/</a>
      </p>
    </div>
  </div>`;

  try {
    await sendEmail({
      to: ALERT_TO,
      subject: `📖 Handbook drift: ${stale.length} stale chapter${stale.length === 1 ? '' : 's'} — ${stale.map((c) => c.slug).join(', ')}`,
      html,
      text: `Handbook drift — stale chapters: ${stale.map((c) => `${c.slug} (reviewed ${c.last_reviewed})`).join(', ')}. Open https://alamedapointbg.com/control → APBG Handbook → Run sweep → Auto-update.`,
    });
    console.log(`[handbook-sweep-cron] drift digest sent to ${ALERT_TO}`);
  } catch (e) {
    console.error('[handbook-sweep-cron] email failed (results still in logs):', e.message);
  }

  return new Response(JSON.stringify({ ok: true, stale: stale.length, emailed: ALERT_TO }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export const config = {
  schedule: '0 15 * * 1',
};
