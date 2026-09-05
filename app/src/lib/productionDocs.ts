import { _sbToken } from './supabase';

/**
 * The production pipeline's printed documents — purchase order, bill of
 * lading, batching sheet — rendered server-side as PDFs in the Melt design
 * and emailed as attachments. Backed by netlify/functions/production-doc.mjs.
 */
const FN = '/margin/.netlify/functions/production-doc';

export type DocKind = 'po' | 'bol' | 'batch_sheet' | 'pull_ticket';

export interface DocRef {
  kind: DocKind;
  id?: string;      // po id, transfer id, or formula id
  wo_id?: string;   // batch sheet sized to a work order
  gal?: number;     // batch sheet at an explicit batch size
}

async function bearer(): Promise<string> {
  const t = await _sbToken();
  if (!t) throw new Error('Not signed in');
  return 'Bearer ' + t;
}

function query(ref: DocRef, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ kind: ref.kind, ...extra });
  if (ref.id) q.set('id', ref.id);
  if (ref.wo_id) q.set('wo_id', ref.wo_id);
  if (ref.gal) q.set('gal', String(ref.gal));
  return FN + '?' + q.toString();
}

/**
 * Open the PDF in a new tab. The function needs a bearer, and a plain
 * window.open cannot carry one — so fetch with the token and hand the browser
 * a blob URL (the same trap melt-dashboard documents for its admin GETs).
 */
export async function openDocPdf(ref: DocRef): Promise<void> {
  const w = window.open('', '_blank');
  try {
    const res = await fetch(query(ref), { headers: { Authorization: await bearer() } });
    if (!res.ok) {
      let msg = 'Could not render (' + res.status + ')';
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* keep msg */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (w) w.location.href = url; else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    if (w) w.close();
    throw e;
  }
}

export interface DocSend {
  id: string;
  recipients: string[];
  cc: string[];
  subject: string;
  status: 'sent' | 'failed';
  error: string | null;
  sent_by_email: string | null;
  sent_at: string;
  storage_path: string | null;
}

export async function fetchDocSends(ref: DocRef): Promise<DocSend[]> {
  const res = await fetch(query(ref, { history: '1' }), { headers: { Authorization: await bearer() } });
  if (!res.ok) return [];
  const j = (await res.json()) as { sends?: DocSend[] };
  return j.sends ?? [];
}

export async function emailDoc(ref: DocRef, args: { to: string[]; cc?: string[]; message?: string; subject?: string }): Promise<DocSend> {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { Authorization: await bearer(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: ref.kind, id: ref.id, wo_id: ref.wo_id, gal: ref.gal, ...args }),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; send?: DocSend; error?: string };
  if (!res.ok || !j.ok) throw new Error(j.error ?? 'Send failed (' + res.status + ')');
  return j.send as DocSend;
}
