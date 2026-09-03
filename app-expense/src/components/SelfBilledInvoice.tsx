// Raise the supplier's invoice on their behalf, from the expense itself.
//
// Origins Craft Soda doesn't issue invoices — they authorised us to raise
// theirs. This panel only appears on an expense a self-billing profile claims,
// so it is invisible for every supplier who does send their own paperwork.

import { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2, Mail, Check, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getAccessToken } from '@/lib/supabase';

interface Existing {
  id: string;
  invoice_number: string;
  invoice_date: string;
  total: number | string;
  sent_at: string | null;
  sent_to: string[] | null;
  send_error: string | null;
  voided_at: string | null;
}
interface Status {
  profile: { id: string; code: string; seller_name: string; auto_send: boolean; send_to: string[] } | null;
  existing: Existing | null;
  can_raise: boolean;
  reason: string;
}

async function api(path: string, body?: unknown) {
  const token = await getAccessToken();
  const res = await fetch(`/expense/api/self-bill-invoice${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function SelfBilledInvoice({ expenseId }: { expenseId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await api(`?expense_id=${expenseId}`)); }
    catch { setStatus(null); }   // never let this panel break the expense page
  }, [expenseId]);

  useEffect(() => { void load(); }, [load]);

  // Silent for every vendor who invoices us normally.
  if (!status?.profile) return null;
  const inv = status.existing;

  const run = async (action: 'create' | 'send', label: string) => {
    setBusy(action); setErr(null); setNote(null);
    try {
      const out = await api('', { action, expense_request_id: expenseId });
      setNote(action === 'create'
        ? `Raised ${out.invoice_number} and attached it to this expense.${out.sent?.sent ? ' Emailed to the supplier.' : ''}`
        : `Emailed ${out.invoice_number} to ${(out.sent_to || []).join(', ')}.`);
      if (out.line_mismatch) {
        setErr(`Heads up: the line items add to $${out.line_mismatch.lineSum} but the expense total is `
          + `$${out.line_mismatch.total}. The invoice uses the expense total, and says so on the document.`);
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : `Could not ${label}.`);
    } finally { setBusy(null); }
  };

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <FileText className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
        <div className="text-sm">
          <div className="font-medium">{status.profile.seller_name} doesn’t send invoices</div>
          <div className="text-xs text-muted-foreground">
            They authorised us to raise theirs. The invoice is filed against this expense and becomes its bill number.
          </div>
        </div>
      </div>

      {inv && !inv.voided_at ? (
        <div className="text-xs space-y-1">
          <div className="flex items-center gap-1.5 text-emerald-400">
            <Check className="h-3.5 w-3.5" />
            <span className="font-medium">{inv.invoice_number}</span>
            <span className="text-muted-foreground">· {inv.invoice_date} · ${Number(inv.total).toFixed(2)}</span>
          </div>
          {inv.sent_at
            ? <div className="text-muted-foreground">Emailed to {(inv.sent_to || []).join(', ')}</div>
            : <div className="text-amber-300">Not emailed yet.</div>}
          {inv.send_error && <div className="text-red-300">Last send failed: {inv.send_error}</div>}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">{status.reason}</div>
      )}

      <div className="flex flex-wrap gap-2">
        {(!inv || inv.voided_at) && (
          <Button size="sm" onClick={() => void run('create', 'raise the invoice')}
                  disabled={!status.can_raise || busy === 'create'}>
            {busy === 'create' ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <FileText className="h-4 w-4 mr-1.5" />}
            Raise invoice
          </Button>
        )}
        {inv && !inv.voided_at && (
          <Button size="sm" variant="outline" onClick={() => void run('send', 'email the invoice')} disabled={busy === 'send'}>
            {busy === 'send' ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Mail className="h-4 w-4 mr-1.5" />}
            {inv.sent_at ? 'Send again' : `Email to ${status.profile.send_to?.[0] ?? 'the supplier'}`}
          </Button>
        )}
      </div>

      {note && <div className="text-xs text-emerald-400">{note}</div>}
      {err && (
        <div className="flex items-start gap-1.5 text-xs text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /><span>{err}</span>
        </div>
      )}
    </div>
  );
}
