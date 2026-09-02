// production-doc — the production pipeline's printed documents, as PDFs.
//
//   GET  ?kind=po&id=<po uuid>                     → application/pdf
//   GET  ?kind=bol&id=<transfer uuid>              → application/pdf
//   GET  ?kind=batch_sheet&id=<formula uuid>&gal=N → application/pdf
//   GET  ?kind=batch_sheet&wo_id=<work order uuid> → sized to that run
//   GET  ?kind=<k>&id=<ref>&history=1              → JSON: what has been emailed for it
//   POST { kind, id | wo_id, gal?, to[], cc?[], message? }
//        → renders, files the PDF in the production-docs bucket, emails it as an
//          attachment, records ops.production_doc_sends. Returns the send row.
//
// The three documents share one renderer (lib/production-docs.mjs) in the
// Melt PO/BOL design, so the batch sheet a co-packer receives looks like the
// PO that came with it.
//
// ⚠ The PDF we EMAIL is the PDF we KEEP. Prices and addresses move; "what did
// we send them" must not. The bytes go to storage before the send, and the
// send row records the path -- a failed send still records what was built.
//
// Auth: hub superadmin/admin (the roles that run production in Refractor).
// Reads use the service role because purchase_orders / inventory_transfers
// carry staff-only RLS and a document render should not depend on which
// policy the caller happens to satisfy today.

import { requireAuth } from './lib/auth.mjs';
import { corsHeaders } from './qbo-helpers.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';
import { sendEmail } from './email-helpers.mjs';
import {
  renderPurchaseOrderPdf, renderBillOfLadingPdf, renderBatchSheetPdf,
  fmtMoney, fmtQty, fmtDate,
} from './lib/production-docs.mjs';

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'production-docs';
const KINDS = new Set(['po', 'bol', 'batch_sheet']);

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
function pdfResponse(bytes, filename, inline = true) {
  return {
    statusCode: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
    body: Buffer.from(bytes).toString('base64'),
    isBase64Encoded: true,
  };
}

const svc = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` });
async function sbGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: { ...svc(), 'Accept-Profile': 'ops' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`read ${pathAndQuery.split('?')[0]} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}
async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...svc(), 'Content-Type': 'application/json', 'Content-Profile': 'ops', 'Accept-Profile': 'ops', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`insert ${table} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text)[0] : null;
}
async function rpc(name, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...svc(), 'Content-Type': 'application/json', 'Content-Profile': 'ops', 'Accept-Profile': 'ops' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${name} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
async function storagePut(path, bytes) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...svc(), 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
    body: Buffer.from(bytes),
  });
  if (!res.ok) throw new Error(`storage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return `${BUCKET}/${path}`;
}

const inList = (ids) => `in.(${[...new Set(ids.filter(Boolean))].map((s) => `"${String(s).replace(/"/g, '')}"`).join(',')})`;
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

// ── Shared lookups ───────────────────────────────────────────────────────────
async function company() {
  const rows = await sbGet('production_settings?select=*&id=eq.true&limit=1');
  const s = rows[0] || {};
  return {
    accent: s.doc_accent || '#dc2626',
    from: s.doc_from || 'Brix Beverage Purchasing <alerts@alamedapointbg.com>',
    company: {
      name: s.company_name || 'Brix Beverage Dba Alameda Point Beverage Group',
      addr1: s.company_addr1 || '1951 Monarch St',
      addr2: s.company_addr2 ?? 'Suite 200',
      city_state_zip: s.company_city_state_zip || 'Alameda, CA 94501',
      phone: s.company_phone || null,
      email: s.company_email || 'service@brixbev.com',
      web: s.company_web || 'alamedapointbg.com',
    },
  };
}
async function itemsById(ids) {
  if (!ids.length) return new Map();
  const rows = await sbGet(`qbo_items?select=qbo_item_id,name,sku&qbo_item_id=${inList(ids)}`);
  return new Map(rows.map((r) => [String(r.qbo_item_id), r]));
}
function itemNo(item, id) {
  if (item?.sku) return item.sku;
  const first = String(item?.name || '').split(/\s+/)[0] || '';
  return /^[A-Z0-9][A-Z0-9-]{3,}$/.test(first) ? first : (id || '');
}
function locationBlock(l) {
  if (!l) return null;
  return {
    name: l.name, addr1: l.address_line1, addr2: l.address_line2,
    city_state_zip: [l.city, l.state].filter(Boolean).join(', ') + (l.postal_code ? ' ' + l.postal_code : ''),
    contact: l.contact_name, phone: l.contact_phone,
  };
}
function vendorBlock(v) {
  if (!v) return null;
  return {
    name: v.display_name, addr1: v.address_line1,
    city_state_zip: [v.city, v.state].filter(Boolean).join(', ') + (v.postal_code ? ' ' + v.postal_code : ''),
    email: (v.email || '').split(',')[0].trim() || null, phone: v.phone, terms: v.default_terms,
  };
}

// ── Payload builders ─────────────────────────────────────────────────────────
async function buildPo(id) {
  const [po] = await sbGet(`purchase_orders?select=*&id=eq.${id}&limit=1`);
  if (!po) throw Object.assign(new Error('purchase order not found'), { status: 404 });
  const lines = await sbGet(`purchase_order_lines?select=*&po_id=eq.${id}&order=sort_order,created_at`);
  const details = lines.length
    ? await sbGet(`purchase_order_line_details?select=*&po_line_id=${inList(lines.map((l) => l.id))}&order=sort_order`)
    : [];
  const [vendor] = po.qbo_vendor_id ? await sbGet(`qbo_vendors?select=*&qbo_vendor_id=eq.${encodeURIComponent(po.qbo_vendor_id)}&limit=1`) : [];
  const [dest] = po.destination_location_id ? await sbGet(`inventory_locations?select=*&id=eq.${po.destination_location_id}&limit=1`) : [];
  const items = await itemsById(lines.map((l) => l.qbo_item_id));
  let workOrder = null;
  if (po.work_order_id) {
    const [wo] = await sbGet(`work_orders?select=batch_code,qty_to_produce,bom_id&id=eq.${po.work_order_id}&limit=1`);
    if (wo) {
      const [bom] = wo.bom_id ? await sbGet(`product_bom?select=name&id=eq.${wo.bom_id}&limit=1`) : [];
      workOrder = { batch: wo.batch_code, cases: Number(wo.qty_to_produce), flavour: bom?.name || '' };
    }
  }
  const byLine = new Map();
  for (const d of details) { if (!byLine.has(d.po_line_id)) byLine.set(d.po_line_id, []); byLine.get(d.po_line_id).push(d); }
  const outLines = lines.map((l) => {
    const it = items.get(String(l.qbo_item_id));
    const qty = Number(l.qty_ordered) || 0, cost = Number(l.unit_cost) || 0;
    return {
      itemNo: itemNo(it, l.qbo_item_id),
      description: l.description || it?.name || l.qbo_item_id,
      // PO lines carry no unit; the gallon items are the one case where the
      // unit changes what the number means, so it is named.
      qty, uom: /^1GNS/.test(it?.name || '') ? 'gal' : '',
      unitCost: cost, lineTotal: qty * cost,
      detail: (byLine.get(l.id) || []).map((d) => ({
        name: d.item_name, qty: Number(d.qty), uom: d.uom,
        note: d.allocated_cost != null ? `allocated ${fmtMoney(d.allocated_cost)}` : null,
      })),
    };
  });
  const subtotal = outLines.reduce((t, l) => t + l.lineTotal, 0);
  const meta = await company();
  return {
    payload: {
      ...meta, poNumber: po.po_number, issued: po.ordered_at || po.created_at, expected: po.expected_date,
      status: po.status, vendor: vendorBlock(vendor), shipTo: locationBlock(dest), workOrder,
      lines: outLines, subtotal, total: subtotal, notes: po.notes,
    },
    label: po.po_number, filename: `${po.po_number}.pdf`,
    recipientHint: (vendor?.email || '').split(',').map((s) => s.trim()).filter(Boolean),
    summary: { vendor: vendor?.display_name || '', total: subtotal, lineCount: outLines.length },
  };
}

async function buildBol(id) {
  const [t] = await sbGet(`inventory_transfers?select=*&id=eq.${id}&limit=1`);
  if (!t) throw Object.assign(new Error('transfer not found'), { status: 404 });
  const lines = await sbGet(`inventory_transfer_lines?select=*&transfer_id=eq.${id}&order=created_at`);
  const locs = await sbGet(`inventory_locations?select=*&id=${inList([t.from_location_id, t.to_location_id])}`);
  const from = locs.find((l) => l.id === t.from_location_id), to = locs.find((l) => l.id === t.to_location_id);
  const items = await itemsById(lines.map((l) => l.qbo_item_id));
  const [wo] = await sbGet(`work_orders?select=batch_code&transfer_id=eq.${id}&limit=1`);
  const meta = await company();
  return {
    payload: {
      ...meta, bolNumber: t.bol_number, status: t.status, issued: t.created_at, shipDate: t.ship_date,
      shipper: locationBlock(from), consignee: locationBlock(to),
      carrier: t.carrier, pro: t.pro_number, tracking: t.tracking_number, freightTerms: t.freight_terms,
      weight: t.total_weight_lbs, pallets: t.total_pallets, declaredValue: t.declared_value_usd,
      specialInstructions: t.special_instructions, notes: t.notes,
      workOrder: wo ? { batch: wo.batch_code } : null,
      signatures: { shipperName: t.shipper_signature_name, shipperAt: t.shipper_signature_at,
                    receiverName: t.receiver_signature_name, receiverAt: t.receiver_signature_at },
      lines: lines.map((l) => {
        const it = items.get(String(l.qbo_item_id));
        return { itemNo: itemNo(it, l.qbo_item_id), description: it?.name || l.qbo_item_id,
                 qty: Number(l.qty), uom: '', weight: l.line_weight_lbs, pallets: l.line_pallets };
      }),
    },
    label: t.bol_number, filename: `${t.bol_number}.pdf`,
    recipientHint: [],
    summary: { from: from?.name || '', to: to?.name || '', lineCount: lines.length },
  };
}

async function buildBatchSheet({ formulaId, woId, gal }) {
  let wo = null, bom = null, formula = null;
  if (woId) {
    [wo] = await sbGet(`work_orders?select=*&id=eq.${woId}&limit=1`);
    if (!wo) throw Object.assign(new Error('work order not found'), { status: 404 });
    [bom] = wo.bom_id ? await sbGet(`product_bom?select=*&id=eq.${wo.bom_id}&limit=1`) : [];
    formulaId = wo.formula_id || bom?.formula_id;
  }
  if (!formulaId) throw Object.assign(new Error('formula id required'), { status: 400 });
  [formula] = await sbGet(`product_formulas?select=*&id=eq.${formulaId}&limit=1`);
  if (!formula) throw Object.assign(new Error('formula not found'), { status: 404 });
  const ingredients = await sbGet(`product_formula_ingredients?select=*&formula_id=eq.${formulaId}&order=sort_order`);

  // Batch size: an explicit gal wins; else the run's tank / batch size; else
  // the finished volume the run needs; else the formula's default.
  let batchGal = Number(gal) > 0 ? Number(gal) : null;
  let cases = null, copacker = null;
  if (wo) {
    cases = Number(wo.qty_to_produce) || null;
    if (!batchGal) batchGal = Number(wo.tank_size_gal) || Number(wo.batch_size_gal) || null;
    if (!batchGal && bom) {
      const plan = await rpc('fn_batch_plan', { p_bom_id: bom.id, p_cases: wo.qty_to_produce });
      batchGal = Number(plan?.gal_to_batch) || null;
    }
    if (wo.copacker_qbo_vendor_id) {
      const [v] = await sbGet(`qbo_vendors?select=display_name&qbo_vendor_id=eq.${encodeURIComponent(wo.copacker_qbo_vendor_id)}&limit=1`);
      copacker = v?.display_name || null;
    }
  }
  if (!batchGal) batchGal = Number(formula.default_batch_size_gal) || 1000;

  const density = Number(formula.density_lbs_per_gal) || 0;
  const totalLbs = batchGal * density;
  const canOz = Number(bom?.oz_per_can) || Number(formula.can_size_oz) || null;
  const targetUnits = canOz ? (batchGal * 128) / canOz : null;
  const throwRatio = Number(formula.dilution_ratio) || 0;
  const rows = ingredients.map((i) => ({
    name: i.ingredient_name, pct: Number(i.pct_by_weight) || 0,
    lbs: totalLbs * (Number(i.pct_by_weight) || 0), uom: i.uom || 'lbs',
  }));
  const qc = formula.qc_specs && typeof formula.qc_specs === 'object' && !Array.isArray(formula.qc_specs)
    ? Object.entries(formula.qc_specs).map(([check, spec]) => ({ check, spec: typeof spec === 'string' ? spec : JSON.stringify(spec) }))
    : Array.isArray(formula.qc_specs) ? formula.qc_specs.map((q) => ({ check: q.check || q.name || '', spec: q.spec || q.value || '' })) : [];
  const steps = Array.isArray(formula.batching_instructions) ? formula.batching_instructions.map(String) : [];
  const meta = await company();
  const galLabel = fmtQty(batchGal, 0).replace(/,/g, '');
  return {
    payload: {
      ...meta,
      formula: { name: formula.name, code: formula.code, title: formula.title, docRev: formula.doc_rev, effectiveDate: formula.effective_date },
      batchGal, concentrateGal: throwRatio > 0 ? batchGal / (1 + throwRatio) : null,
      tank: wo?.tank_size_gal || null, targetUnits, canSizeOz: canOz,
      cases: cases ?? (targetUnits && bom?.cans_per_case ? targetUnits / Number(bom.cans_per_case) : null),
      totalLbs, densityLbsPerGal: density, dilutionRatio: throwRatio,
      workOrder: wo ? { batch: wo.batch_code, copacker, scheduled: wo.scheduled_date } : null,
      copacker, rows, qcSpecs: qc, steps, comments: formula.comments,
    },
    label: `${formula.name} · ${galLabel} gal`,
    filename: `Batching-Sheet-${String(formula.code || formula.name).replace(/[^A-Za-z0-9-]+/g, '-')}-${galLabel}gal.pdf`,
    recipientHint: [],
    summary: { formula: formula.name, batchGal, ingredientCount: rows.length },
    refId: formula.id,
  };
}

async function build(kind, q) {
  if (kind === 'po') return { ...(await buildPo(q.id)), refId: q.id, render: renderPurchaseOrderPdf };
  if (kind === 'bol') return { ...(await buildBol(q.id)), refId: q.id, render: renderBillOfLadingPdf };
  const b = await buildBatchSheet({ formulaId: q.id, woId: q.wo_id, gal: q.gal });
  return { ...b, render: renderBatchSheetPdf };
}

// ── Email ────────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function emailHtml({ kind, label, payload, message, company: c, accent }) {
  const title = kind === 'po' ? 'Purchase Order' : kind === 'bol' ? 'Bill of Lading' : 'Batching Sheet';
  const intro = kind === 'po'
    ? `Please find Purchase Order <strong>${esc(label)}</strong> attached. Confirm receipt and an estimated ship date when you can, and reference the PO number on your invoice.`
    : kind === 'bol'
      ? `Please find Bill of Lading <strong>${esc(label)}</strong> attached${payload.shipper?.name && payload.consignee?.name ? ` — ${esc(payload.shipper.name)} to ${esc(payload.consignee.name)}` : ''}. Note any shortage or damage on the document before signing.`
      : `Please find the batching sheet for <strong>${esc(label)}</strong> attached. Record lot numbers and measured weights on it and return it with the run.`;
  const facts = kind === 'po'
    ? [['Vendor', payload.vendor?.name], ['Total', fmtMoney(payload.total)], ['Expected', payload.expected ? fmtDate(payload.expected) : null]]
    : kind === 'bol'
      ? [['From', payload.shipper?.name], ['To', payload.consignee?.name], ['Carrier', payload.carrier], ['Ship date', payload.shipDate ? fmtDate(payload.shipDate) : null]]
      : [['Batch', `${fmtQty(payload.batchGal, 0)} gal`], ['Yield', payload.targetUnits ? `${fmtQty(payload.targetUnits, 0)} cans` : null], ['Rev', payload.formula.docRev]];
  const factCells = facts.filter(([, v]) => v).map(([k, v]) => `
    <td style="padding:10px 14px;background:#f7f7f9;border-left:3px solid ${accent};vertical-align:top;">
      <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:4px;">${esc(k)}</div>
      <div style="font-weight:700;color:#111827;font-size:13px;">${esc(v)}</div>
    </td><td style="width:8px;"></td>`).join('');
  const note = message ? `<div style="margin:18px 0;padding:14px;background:#fff7ed;border-left:4px solid ${accent};border-radius:4px;">
      <div style="font-size:12px;font-weight:700;color:#7c2d12;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Note from ${esc(c.name)}</div>
      <div style="font-size:14px;color:#111827;white-space:pre-wrap;">${esc(message)}</div></div>` : '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:680px;margin:0 auto;background:#ffffff;padding:32px 28px;">
    <div style="display:table;width:100%;border-bottom:3px solid ${accent};padding-bottom:14px;margin-bottom:22px;">
      <div style="display:table-cell;vertical-align:top;">
        <div style="font-size:20px;font-weight:800;color:${accent};letter-spacing:0.3px;">${esc(c.name)}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:4px;line-height:1.55;">${esc([c.addr1, c.addr2].filter(Boolean).join(' '))}<br>${esc(c.city_state_zip)}<br>${esc(c.email)}</div>
      </div>
      <div style="display:table-cell;vertical-align:top;text-align:right;width:220px;">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#6b7280;">${esc(title)}</div>
        <div style="font-size:20px;font-weight:800;color:#111827;font-family:'SF Mono',Menlo,monospace;margin-top:4px;">${esc(label)}</div>
      </div>
    </div>
    <p style="font-size:15px;color:#111827;line-height:1.55;margin:0 0 14px 0;">${intro}</p>
    ${note}
    <table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr>${factCells}</tr></table>
    <p style="font-size:12px;color:#6b7280;line-height:1.6;margin:22px 0 0 0;">The document is attached as a PDF. Reply to this email or contact us at ${esc(c.email)} with any questions.</p>
  </div></body></html>`;
}

const splitEmails = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]/))
  .map((s) => String(s).trim()).filter(Boolean);
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// ── Handler ──────────────────────────────────────────────────────────────────
export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(), body: '' };
  if (!SERVICE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }, 500);

  const auth = await requireAuth(event, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;

  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const kind = String(q.kind || '');
      if (!KINDS.has(kind)) return json({ error: 'kind must be po, bol or batch_sheet' }, 400);
      if (q.id && !isUuid(q.id)) return json({ error: 'id must be a uuid' }, 400);
      if (q.wo_id && !isUuid(q.wo_id)) return json({ error: 'wo_id must be a uuid' }, 400);

      if (q.history === '1') {
        const ref = q.id || q.wo_id;
        const rows = await sbGet(`production_doc_sends?select=id,recipients,cc,subject,status,error,sent_by_email,sent_at,storage_path&doc_kind=eq.${kind}&ref_id=eq.${ref}&order=sent_at.desc&limit=20`);
        return json({ ok: true, sends: rows });
      }

      const built = await build(kind, q);
      const bytes = await built.render(built.payload);
      return pdfResponse(bytes, built.filename, q.download !== '1');
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const kind = String(body.kind || '');
      if (!KINDS.has(kind)) return json({ error: 'kind must be po, bol or batch_sheet' }, 400);
      if (body.id && !isUuid(body.id)) return json({ error: 'id must be a uuid' }, 400);
      if (body.wo_id && !isUuid(body.wo_id)) return json({ error: 'wo_id must be a uuid' }, 400);
      const to = splitEmails(body.to), cc = splitEmails(body.cc);
      const bad = [...to, ...cc].filter((e) => !validEmail(e));
      if (!to.length) return json({ error: 'at least one recipient is required' }, 400);
      if (bad.length) return json({ error: `not an email address: ${bad.join(', ')}` }, 400);
      if (to.length + cc.length > 10) return json({ error: 'at most 10 recipients' }, 400);
      const message = body.message ? String(body.message).slice(0, 2000) : null;

      const built = await build(kind, { id: body.id, wo_id: body.wo_id, gal: body.gal });
      const bytes = await built.render(built.payload);
      const title = kind === 'po' ? 'Purchase Order' : kind === 'bol' ? 'Bill of Lading' : 'Batching Sheet';
      const subject = body.subject ? String(body.subject).slice(0, 200) : `${title} ${built.label} — ${built.payload.company.name.split(' Dba ')[0]}`;

      // File first. A failed send still leaves the exact bytes we tried to send.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const path = `${kind}/${built.refId}/${stamp}-${built.filename}`;
      let storagePath = null;
      try { storagePath = await storagePut(path, bytes); } catch (e) { console.warn('[production-doc] storage failed:', e.message); }

      const row = {
        doc_kind: kind, ref_id: built.refId, ref_label: built.label,
        recipients: to, cc, subject, message, storage_path: storagePath,
        sent_by: auth.user?.id || null, sent_by_email: auth.user?.email || null,
        status: 'sent', resend_id: null, error: null,
      };
      try {
        const r = await sendEmail({
          to, from: built.payload.from, replyTo: built.payload.company.email,
          subject,
          html: emailHtml({ kind, label: built.label, payload: built.payload, message, company: built.payload.company, accent: built.payload.accent }),
          text: `${title} ${built.label} from ${built.payload.company.name} is attached as a PDF.${message ? '\n\n' + message : ''}`,
          attachments: [{ filename: built.filename, content: Buffer.from(bytes).toString('base64') }],
          ...(cc.length ? { cc } : {}),
        });
        row.resend_id = r?.id || null;
        if (r === false) { row.status = 'failed'; row.error = 'No email service configured'; }
      } catch (e) {
        row.status = 'failed'; row.error = String(e.message || e).slice(0, 500);
      }
      const saved = await sbInsert('production_doc_sends', row).catch((e) => { console.warn('[production-doc] log failed:', e.message); return row; });
      return json({ ok: row.status === 'sent', send: saved, error: row.error }, row.status === 'sent' ? 200 : 502);
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    const status = e.status || 500;
    return json({ error: String(e.message || e) }, status);
  }
}
