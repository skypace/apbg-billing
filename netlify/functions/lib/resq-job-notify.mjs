// ResQ new-job notification — when a ResQ WO is first picked up by the sync,
// email a "here's what's wrong" notification (location, asset, description, and
// any photos ResQ has on the WO) through alamedapointbg.com via Resend.
//
// ResQ's GraphQL schema for WO photos / equipment detail / facility address is
// not fully known here, and an unknown field would fail the WHOLE query. So we
// INTROSPECT the relevant types once per cold start and build the enrichment
// query from only the fields that actually exist — it can never break the sync,
// and it self-adapts to whatever ResQ exposes. Everything here is best-effort:
// a failure logs and degrades (email still sends with the fields we do have).

import { resqGql } from '../resq-helpers.mjs';
import { sendEmail } from '../email-helpers.mjs';

// Recipients for the new-job alert. Defaults to both ops owners; override with
// a comma-separated RESQ_JOB_NOTIFY_TO env var.
const NOTIFY_TO = (process.env.RESQ_JOB_NOTIFY_TO || 'skypace@brixbev.com,whitney@alamedasoda.com')
  .split(',').map(s => s.trim()).filter(Boolean);

// --- Schema introspection (cached per cold start) ---
const _typeCache = new Map();
async function typeFields(session, typeName) {
  if (_typeCache.has(typeName)) return _typeCache.get(typeName);
  let fields = [];
  try {
    const d = await resqGql(session, `{ __type(name: "${typeName}") {
      fields { name type { name kind ofType { name kind ofType { name kind } } } }
    } }`);
    fields = d.data?.__type?.fields || [];
  } catch { /* leave empty */ }
  _typeCache.set(typeName, fields);
  return fields;
}

// Unwrap NON_NULL / LIST wrappers to the underlying named type.
function namedType(t) {
  let cur = t;
  while (cur && !cur.name && cur.ofType) cur = cur.ofType;
  return cur?.name || null;
}
function fieldByName(fields, names) {
  const lower = names.map(n => n.toLowerCase());
  return fields.find(f => lower.includes(f.name.toLowerCase()))
    || fields.find(f => lower.some(n => f.name.toLowerCase().includes(n)));
}
function fieldsMatching(fields, re) {
  return fields.filter(f => re.test(f.name));
}

// Discover, once, how to ask ResQ for a WO's photos + extra asset/location
// detail. Returns a plan: { photo:{field, urlSub, labelSub}, equipExtra:[],
// facilityAddr:[] } — any piece may be null/empty if ResQ doesn't expose it.
let _planPromise;
function discoverPlan(session) {
  if (_planPromise) return _planPromise;
  _planPromise = (async () => {
    const plan = { photo: null, equipExtra: [], facilityAddr: [] };
    try {
      const woFields = await typeFields(session, 'WorkOrder');

      // Photo / attachment collection field on the WO.
      const photoField = fieldByName(woFields, ['attachments', 'images', 'beforeImages', 'photos', 'media', 'files']);
      if (photoField) {
        const inner = namedType(photoField.type);
        if (inner) {
          // The collection may be a Relay connection ({ edges { node {...} } })
          // or a plain list of nodes. Probe the node type's fields.
          let nodeType = inner;
          const connFields = await typeFields(session, inner);
          const edges = connFields.find(f => f.name === 'edges');
          if (edges) {
            const edgeType = namedType(edges.type);
            const edgeFields = await typeFields(session, edgeType);
            const node = edgeFields.find(f => f.name === 'node');
            nodeType = namedType(node?.type) || nodeType;
          }
          const nodeFields = await typeFields(session, nodeType);
          const urlSub = fieldByName(nodeFields, ['url', 'fileUrl', 'file', 'src', 'downloadUrl', 'location', 'href']);
          const labelSub = fieldByName(nodeFields, ['label', 'name', 'caption', 'title', 'filename']);
          if (urlSub) {
            plan.photo = {
              field: photoField.name,
              isConnection: !!edges,
              urlSub: urlSub.name,
              labelSub: labelSub?.name || null,
            };
          }
        }
      }

      // Extra equipment detail beyond name.
      const equipFields = await typeFields(session, 'Equipment');
      plan.equipExtra = fieldsMatching(equipFields, /^(model|make|manufacturer|serial|serialNumber|assetTag|category|type)$/i)
        .map(f => f.name).slice(0, 6);

      // Facility address fields.
      const facFields = await typeFields(session, 'Facility');
      plan.facilityAddr = fieldsMatching(facFields, /(address|street|city|state|zip|postal|line1|line2)/i)
        .map(f => f.name).slice(0, 8);
    } catch { /* degrade to nothing */ }
    return plan;
  })();
  return _planPromise;
}

// Build + run the enrichment query for one WO code, using only fields ResQ
// confirmed it has. Returns { photos:[{url,label}], equipment:{}, facility:{} }.
export async function fetchWoEnrichment(session, code) {
  const out = { photos: [], equipment: {}, facility: {} };
  let plan;
  try { plan = await discoverPlan(session); } catch { return out; }

  const equipSel = ['id', 'name', ...plan.equipExtra].join(' ');
  const facSel = ['id', 'name', ...plan.facilityAddr].join(' ');
  let photoSel = '';
  if (plan.photo) {
    const inner = plan.photo.labelSub
      ? `${plan.photo.urlSub} ${plan.photo.labelSub}`
      : plan.photo.urlSub;
    photoSel = plan.photo.isConnection
      ? `${plan.photo.field} { edges { node { ${inner} } } }`
      : `${plan.photo.field} { ${inner} }`;
  }

  try {
    const d = await resqGql(session, `{
      workOrders(first: 1, code: "${code}") {
        edges { node {
          equipment { ${equipSel} }
          facility { ${facSel} }
          ${photoSel}
        } }
      }
    }`);
    const node = d.data?.workOrders?.edges?.[0]?.node || {};
    out.equipment = node.equipment || {};
    out.facility = node.facility || {};
    if (plan.photo) {
      const raw = node[plan.photo.field];
      const items = plan.photo.isConnection ? (raw?.edges || []).map(e => e.node) : (raw || []);
      out.photos = items
        .map(it => ({ url: it?.[plan.photo.urlSub], label: plan.photo.labelSub ? it?.[plan.photo.labelSub] : null }))
        .filter(p => p.url && /^https?:\/\//i.test(String(p.url)));
    }
  } catch { /* degrade */ }
  return out;
}

// Compact multi-line asset/location summary for the SF job notes.
export function assetNotesBlock(wo, enrichment) {
  const e = enrichment?.equipment || {};
  const f = enrichment?.facility || {};
  const lines = [];
  const assetBits = [e.name, e.make, e.model, e.serialNumber || e.serial, e.assetTag].filter(Boolean);
  if (assetBits.length) lines.push(`Asset: ${assetBits.join(' / ')}`);
  const addr = [f.line1 || f.street || f.address, f.city, f.state, f.zip || f.postal].filter(Boolean).join(', ');
  if (addr) lines.push(`Location: ${f.name || wo.facility}${addr ? ' — ' + addr : ''}`);
  if (wo.serviceCategory) lines.push(`Service: ${wo.serviceCategory}`);
  if (enrichment?.photos?.length) lines.push(`Photos on ResQ: ${enrichment.photos.length}`);
  return lines.join('\n');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildEmailHtml(wo, enrichment) {
  const e = enrichment.equipment || {};
  const f = enrichment.facility || {};
  const addr = [f.line1 || f.street || f.address, f.city, f.state, f.zip || f.postal].filter(Boolean).join(', ');
  const assetBits = [e.name, e.make, e.model, e.serialNumber || e.serial, e.assetTag].filter(Boolean);
  const photos = enrichment.photos || [];

  const row = (label, val) => val
    ? `<tr><td style="color:#6b7280;padding:6px 0;font-size:13px;vertical-align:top;width:120px;">${esc(label)}</td><td style="font-size:14px;padding:6px 0;">${val}</td></tr>`
    : '';

  const photoHtml = photos.length
    ? `<p style="font-size:13px;font-weight:600;color:#1F4E79;margin:20px 0 8px;">PHOTOS (${photos.length})</p>
       <div>${photos.map(p => `<a href="${esc(p.url)}" style="text-decoration:none;"><img src="${esc(p.url)}" alt="${esc(p.label || 'photo')}" style="max-width:260px;max-height:200px;border-radius:6px;border:1px solid #e2e6ed;margin:0 8px 8px 0;display:inline-block;"></a>`).join('')}</div>
       <p style="font-size:11px;color:#9ca3af;">If images don't load, click one to open it in ResQ.</p>`
    : `<p style="font-size:12px;color:#9ca3af;margin:16px 0 0;">No photos attached to this ResQ WO.</p>`;

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;background:#fff;">
    <div style="background:#1F4E79;padding:22px 28px;border-radius:8px 8px 0 0;">
      <h1 style="color:#fff;font-size:19px;margin:0;">New ResQ Work Order — ${esc(wo.code)}${wo.isUrgent ? ' · ⚠ URGENT' : ''}</h1>
      <p style="color:rgba(255,255,255,0.75);font-size:13px;margin:6px 0 0;">${esc(wo.facility || f.name || '')}</p>
    </div>
    <div style="padding:22px 28px;border:1px solid #e2e6ed;border-top:0;border-radius:0 0 8px 8px;">
      <table style="width:100%;border-collapse:collapse;">
        ${row('Work Order', `<span style="font-family:monospace;">${esc(wo.code)}</span>`)}
        ${row('Location', `${esc(f.name || wo.facility || '—')}${addr ? `<br><span style="color:#6b7280;font-size:13px;">${esc(addr)}</span>` : ''}`)}
        ${row('Asset', assetBits.length ? esc(assetBits.join(' / ')) : (wo.equipment ? esc(wo.equipment) : '—'))}
        ${row('Service', wo.serviceCategory ? esc(wo.serviceCategory) : '')}
        ${row('Priority', wo.isUrgent ? '<strong style="color:#991B1B;">URGENT</strong>' : 'Normal')}
        ${row('Title', wo.title ? esc(wo.title) : '')}
      </table>
      ${wo.description ? `<p style="font-size:13px;font-weight:600;color:#1F4E79;margin:18px 0 6px;">WHAT'S WRONG</p>
        <div style="background:#f4f6f9;border-radius:6px;padding:14px 16px;font-size:14px;white-space:pre-wrap;">${esc(wo.description)}</div>` : ''}
      ${photoHtml}
    </div>
    <p style="text-align:center;font-size:11px;color:#9ca3af;margin:14px 0;">APBG · ResQ ↔ Service Fusion sync · automated job notification</p>
  </div>`;
}

// Send the notification. Best-effort: returns { ok, error?, photos } and never
// throws. `enrichment` may be passed in (from createSfJob) to skip a re-fetch.
export async function notifyNewResqJob(session, wo, enrichment = null) {
  try {
    if (!enrichment) enrichment = await fetchWoEnrichment(session, wo.code);
    const subject = `New ResQ WO ${wo.code}${wo.isUrgent ? ' (URGENT)' : ''} — ${wo.facility || enrichment.facility?.name || ''}`.trim();
    const html = buildEmailHtml(wo, enrichment);
    const sent = await sendEmail({ to: NOTIFY_TO, subject, html });
    // sendEmail returns false when NO provider is configured, the Resend JSON
    // (with an id) on success, or true for SendGrid. Don't claim success on a
    // no-op — that masked a non-delivering pipeline as "sent".
    if (sent === false) {
      return { ok: false, error: 'email NOT sent — no email provider configured (RESEND_API_KEY / SENDGRID_API_KEY)' };
    }
    const id = (sent && typeof sent === 'object' && sent.id) ? sent.id : null;
    return { ok: true, photos: enrichment.photos.length, enrichment, emailId: id };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

// One-shot diagnostic: dump ResQ's real WorkOrder/Equipment/Facility schema, the
// enrichment we'd pull for a given WO, and the live result of a test email. Hit
// via the authed dashboard endpoint ?probeJob=<resqCode>. Read-only except it
// sends one test email to the configured recipients.
export async function probeResqJob(session, code) {
  const out = { code, recipients: NOTIFY_TO };
  try {
    out.workOrderFields = (await typeFields(session, 'WorkOrder')).map(f => f.name);
    out.equipmentFields = (await typeFields(session, 'Equipment')).map(f => f.name);
    out.facilityFields = (await typeFields(session, 'Facility')).map(f => f.name);
    out.discoveredPlan = await discoverPlan(session);
  } catch (e) { out.introspectError = String(e?.message || e).slice(0, 300); }
  try { out.enrichment = await fetchWoEnrichment(session, code); }
  catch (e) { out.enrichmentError = String(e?.message || e).slice(0, 300); }
  try {
    const r = await sendEmail({ to: NOTIFY_TO, subject: `TEST — ResQ probe ${code}`, html: `<p>Test email from the ResQ new-job notifier (probe for ${code}). If you got this, delivery works.</p>` });
    out.emailResult = r === false ? 'NO PROVIDER CONFIGURED (sendEmail returned false)' : (r && r.id ? `sent (id=${r.id})` : `sent (${JSON.stringify(r).slice(0, 120)})`);
  } catch (e) { out.emailError = String(e?.message || e).slice(0, 400); }
  return out;
}

