// resend-inbound.mjs — reading attachments off an INBOUND Resend email.
//
// Resend's inbound API is thin on documentation and its path spelling has
// moved (`emails/receiving` / `emails/received` / `emails`), and attachment
// content arrives three different ways depending on the endpoint: inlined
// base64 on the full-email read, a dedicated attachment endpoint returning
// JSON (often only a signed `download_url`), or that endpoint returning raw
// bytes. Every call here tries the known spellings and tolerates all three.
//
// ⚠ READING inbound mail needs a DIFFERENT key than sending.
// A Resend key created with sending access answers every receiving-API read
// with 401 `restricted_api_key` ("This API key is restricted to only send
// emails"). brix-order hit exactly this on its first live purchase order: the
// PDF was in Resend the whole time and could not be read, and because the
// fetch helper swallowed non-OK responses it looked identical to an email
// with no attachment. Two rules came out of it, both implemented here:
//
//   1. Reading requires a FULL-ACCESS key, so it gets its own env var
//      (RESEND_INBOUND_API_KEY). The sending key is left alone — rotating or
//      breaking the reader must never take outbound mail down with it.
//   2. Never swallow the status. Every failed read is recorded verbatim in
//      `diagnostics`, so "no attachment" and "we were not allowed to look"
//      can never again read the same on the queue.

const RESEND_BASES = ['emails/receiving', 'emails/received', 'emails'];

/** Media types Claude can read as a document/image block. */
export const OCRABLE = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/**
 * The key used to READ inbound mail. Falls back to RESEND_API_KEY so a site
 * without a dedicated reader keeps working — and gets the honest 401 in its
 * diagnostics rather than silence.
 */
export function inboundResendKey() {
  return process.env.RESEND_INBOUND_API_KEY || process.env.RESEND_API_KEY || '';
}

/** True when the reader key is the send-only fallback — worth saying out loud. */
export function inboundKeyIsFallback() {
  return !process.env.RESEND_INBOUND_API_KEY && !!process.env.RESEND_API_KEY;
}

// A diagnostics sink: collects one line per failed Resend read so the intake
// row can quote the literal HTTP status back to whoever works the queue.
export function makeDiag() {
  const lines = [];
  return {
    push(line) { if (lines.length < 24) lines.push(line); },
    note(path, status, body) {
      let hint = '';
      if (status === 401 && /restricted_api_key/i.test(body || '')) {
        hint = inboundKeyIsFallback()
          ? ' — the send-only RESEND_API_KEY cannot read inbound mail; set RESEND_INBOUND_API_KEY to a FULL-ACCESS Resend key'
          : ' — RESEND_INBOUND_API_KEY is not a full-access key';
      }
      this.push(`GET ${path} → ${status} ${String(body || '').slice(0, 180)}${hint}`);
    },
    text() { return lines.join('\n') || null; },
  };
}

async function resendJson(path, diag) {
  try {
    const res = await fetch(`https://api.resend.com/${path}`, {
      headers: { Authorization: `Bearer ${inboundResendKey()}` },
    });
    if (!res.ok) {
      diag?.note(path, res.status, await res.text().catch(() => ''));
      return null;
    }
    return await res.json();
  } catch (e) {
    diag?.push(`GET ${path} → network error: ${e?.message || e}`);
    return null;
  }
}

function extractAttachmentList(v) {
  const arr = Array.isArray(v) ? v : (v && Array.isArray(v.data) ? v.data : []);
  return arr
    .map((a) => {
      const o = a && typeof a === 'object' ? a : {};
      return {
        id: String(o.id ?? o.attachment_id ?? '') || null,
        filename: String(o.filename ?? o.name ?? 'attachment').trim() || 'attachment',
        contentType: String(o.content_type ?? o.contentType ?? o.type ?? '') || null,
        content: typeof o.content === 'string' && o.content.length > 0 ? o.content : null,
        size: Number(o.size ?? o.content_length ?? 0) || 0,
      };
    })
    .filter((a) => a.id || a.content);
}

export function guessMediaType(contentType, filename) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (ct && ct !== 'application/octet-stream') return ct;
  const ext = String(filename || '').toLowerCase().split('.').pop() || '';
  return {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
  }[ext] || 'application/octet-stream';
}

async function fetchAttachmentContent(emailId, attId, diag) {
  for (const base of RESEND_BASES) {
    const path = `${base}/${emailId}/attachments/${attId}`;
    try {
      const res = await fetch(`https://api.resend.com/${path}`, {
        headers: { Authorization: `Bearer ${inboundResendKey()}` },
      });
      if (!res.ok) { diag?.note(path, res.status, await res.text().catch(() => '')); continue; }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const j = await res.json();
        const inner = j && typeof j.data === 'object' && j.data ? j.data : j;
        if (typeof inner?.content === 'string' && inner.content.length > 0) return inner.content;
        const url = inner?.download_url ?? inner?.url;
        if (typeof url === 'string' && /^https:\/\//.test(url)) {
          const r2 = await fetch(url);
          if (r2.ok) return Buffer.from(await r2.arrayBuffer()).toString('base64');
          diag?.push(`GET <download_url> → ${r2.status}`);
        }
        continue;
      }
      return Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch (e) {
      diag?.push(`GET ${path} → network error: ${e?.message || e}`);
    }
  }
  return null;
}

// A corporate signature logo outranking the actual invoice is a real failure
// mode (a 67 KB inline PNG did it to brix-order), so rank real documents up
// and drop inline signature art whenever a PDF is present.
function looksLikeSignatureImage(a) {
  return /^(image|img)[-_]?[0-9a-f-]{6,}\.(png|jpe?g|gif)$/i.test(a.filename)
    || (/^image\//i.test(a.mediaType) && a.approxBytes > 0 && a.approxBytes < 24 * 1024);
}

/** PDFs first, then other readable documents; inline signature art last. */
export function rankAttachments(list) {
  const scored = list.map((a) => ({
    ...a,
    _score: a.mediaType === 'application/pdf' ? 0 : OCRABLE.has(a.mediaType) ? 1 : 2,
  }));
  const hasPdf = scored.some((a) => a._score === 0);
  const kept = hasPdf ? scored.filter((a) => a._score === 0 || !looksLikeSignatureImage(a)) : scored;
  return kept.sort((a, b) => a._score - b._score).map(({ _score, ...a }) => a);
}

/** Every attachment on an inbound email, as base64 + a resolved media type. */
export async function fetchResendAttachments(emailId, opts = {}) {
  const diag = opts.diag;
  if (!inboundResendKey()) {
    diag?.push('no Resend API key available to read inbound mail (set RESEND_INBOUND_API_KEY)');
    return [];
  }
  if (!emailId) return [];
  const maxAttachments = opts.maxAttachments ?? 5;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;

  let metas = [];
  for (const base of RESEND_BASES) {
    const email = await resendJson(`${base}/${emailId}`, diag);
    if (!email) continue;
    const inner = email && typeof email.data === 'object' && email.data ? email.data : email;
    metas = extractAttachmentList(inner.attachments);
    if (metas.length > 0) break;
  }
  if (metas.length === 0) {
    for (const base of RESEND_BASES) {
      const list = await resendJson(`${base}/${emailId}/attachments`, diag);
      if (!list) continue;
      metas = extractAttachmentList(list);
      if (metas.length > 0) break;
    }
  }

  const out = [];
  for (const meta of metas.slice(0, maxAttachments)) {
    let base64 = meta.content;
    if (!base64 && meta.id) base64 = await fetchAttachmentContent(emailId, meta.id, diag);
    if (!base64) continue;
    const dataUri = base64.match(/^data:[^;]+;base64,(.+)$/s);
    if (dataUri) base64 = dataUri[1];
    const approxBytes = Math.floor(base64.length * 0.75);
    if (approxBytes > maxBytes) {
      diag?.push(`skipped oversized attachment ${meta.filename} (~${approxBytes} bytes)`);
      continue;
    }
    out.push({
      filename: meta.filename,
      mediaType: guessMediaType(meta.contentType, meta.filename),
      base64,
      approxBytes,
    });
  }
  return out;
}

/** The plain-text body of an inbound email, for the no-attachment case. */
export async function fetchResendBody(emailId, diag) {
  if (!inboundResendKey() || !emailId) return null;
  for (const base of RESEND_BASES) {
    const email = await resendJson(`${base}/${emailId}`, diag);
    if (!email) continue;
    const inner = email && typeof email.data === 'object' && email.data ? email.data : email;
    const text = inner.text || inner.plain || '';
    if (text) return String(text);
    if (inner.html) return stripHtml(String(inner.html));
  }
  return null;
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    // Block tags collapse to a space AND a newline, which leaves every line
    // of a pasted invoice indented by one space. Harmless to read, but it
    // defeats line-anchored matching over the body text.
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Filesystem/bucket-safe filename. */
export function safeFilename(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'attachment').slice(0, 120);
}
