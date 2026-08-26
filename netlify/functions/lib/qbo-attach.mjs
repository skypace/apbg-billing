// qbo-attach.mjs — push a Brixpense request's receipt images onto the QBO
// transaction (Bill or Purchase) as Attachable uploads, so the reviewer sees
// the receipt INSIDE QuickBooks instead of having to open Brixpense.
//
// Best-effort by design: a failed upload must never unwind or block the posted
// bill — the receipt still lives on the Brixpense draft either way. Callers get
// {attached, skipped, errors[]} for logging.
//
// QBO API shape: POST /v3/company/{realm}/upload, multipart/form-data with
// paired parts per file — file_metadata_N (JSON incl. AttachableRef to the
// entity) + file_content_N (the bytes). 100MB request cap; we guard per-file.

import { getAccessToken } from '../qbo-helpers.mjs';
import { SUPABASE_URL } from '../supabase-helpers.mjs';

const QBO_BASE = 'https://quickbooks.api.intuit.com';
const ATTACH_BUCKET = 'expense-attachments';
const MAX_FILE_BYTES = 20 * 1024 * 1024; // stay far under QBO's request cap
const MAX_FILES = 6;

function srHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return { apikey: key, Authorization: `Bearer ${key}` };
}

// entityType: 'Bill' | 'Purchase'; entityId: QBO txn id; requestId: expense_requests.id
// opts.attachmentId: push ONLY that one attachment row — the attach-after-post
// path uses this so re-attaching a late-arriving bill never re-uploads files
// QBO already has (this function has no dedup against QBO's side).
export async function attachReceiptsToQBO(entityType, entityId, requestId, opts = {}) {
  const out = { attached: 0, skipped: 0, errors: [] };
  try {
    const onlyOne = opts.attachmentId ? `&id=eq.${encodeURIComponent(opts.attachmentId)}` : '';
    const listRes = await fetch(
      `${SUPABASE_URL}/rest/v1/expense_request_attachments?request_id=eq.${requestId}${onlyOne}&select=file_name,file_type,storage_path&limit=${MAX_FILES}`,
      { headers: { ...srHeaders(), 'Accept-Profile': 'ops' } },
    );
    if (!listRes.ok) { out.errors.push(`attachment list failed (${listRes.status})`); return out; }
    const rows = await listRes.json();
    if (!rows.length) return out;

    const token = await getAccessToken();
    const realmId = process.env.QBO_REALM_ID;

    for (const [i, row] of rows.entries()) {
      try {
        const fileRes = await fetch(
          `${SUPABASE_URL}/storage/v1/object/${ATTACH_BUCKET}/${row.storage_path}`,
          { headers: srHeaders() },
        );
        if (!fileRes.ok) { out.errors.push(`${row.file_name}: storage ${fileRes.status}`); continue; }
        const bytes = await fileRes.arrayBuffer();
        if (!bytes.byteLength) { out.skipped++; continue; }
        if (bytes.byteLength > MAX_FILE_BYTES) { out.skipped++; out.errors.push(`${row.file_name}: too large`); continue; }

        const contentType = row.file_type || 'application/octet-stream';
        const fileName = (row.file_name || `receipt-${i}`).replace(/[^\w.\- ]/g, '_').slice(0, 100);
        const metadata = {
          AttachableRef: [{ EntityRef: { type: entityType, value: String(entityId) }, IncludeOnSend: false }],
          FileName: fileName,
          ContentType: contentType,
        };
        const fd = new FormData();
        fd.append('file_metadata_01', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
        fd.append('file_content_01', new Blob([bytes], { type: contentType }), fileName);

        const up = await fetch(`${QBO_BASE}/v3/company/${realmId}/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          body: fd,
        });
        const bodyText = await up.text();
        if (!up.ok) { out.errors.push(`${fileName}: QBO upload ${up.status} ${bodyText.slice(0, 120)}`); continue; }
        // QBO returns 200 with a per-file AttachableResponse that can still carry a Fault.
        if (/"Fault"/.test(bodyText) && !/"Attachable"/.test(bodyText)) {
          out.errors.push(`${fileName}: QBO fault ${bodyText.slice(0, 120)}`);
          continue;
        }
        out.attached++;
      } catch (e) {
        out.errors.push(`${row.file_name}: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
  } catch (e) {
    out.errors.push(String(e?.message || e).slice(0, 160));
  }
  return out;
}
