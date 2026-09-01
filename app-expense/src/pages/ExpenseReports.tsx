import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAccessToken } from '@/lib/supabase';
import { useSession } from '@/lib/hooks';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertTriangle, ArrowLeft, BookOpen, Download, Loader2, Lock, Plus, Search, Trash2, Unlock, X,
} from 'lucide-react';
import { formatCurrency } from '@/lib/utils';

// Expense Reports — "books".
//
// A book bundles expenses that belong together for reporting, ACROSS payment
// types: a card charge, a check, an emailed vendor bill and an SF job expense
// can all sit in one book tied to a job or a tag. That grouping is the point —
// a filter can't express "these five things, which happen to share a job".
//
// Totals are broken out BY PAYMENT TYPE, because that is the axis an expense
// report has to be read on and no single column on the row carries it.

interface Totals {
  count: number; total: number; posted: number; unposted: number;
  by_payment: { label: string; amount: number }[];
  by_account: { label: string; amount: number }[];
  by_entity: { label: string; amount: number }[];
}
interface Book {
  id: string; name: string; description: string | null; status: 'open' | 'closed';
  period_start: string | null; period_end: string | null;
  tag: string | null; job_number: string | null; customer_name: string | null; entity: string | null;
  created_by_email: string | null; closed_at: string | null; closed_by: string | null;
  can_edit: boolean;
  totals?: { item_count: number; total_amount: number };
}
interface Line {
  id: string; vendor_name: string | null; bill_number: string | null;
  total_amount: number | null; receipt_date: string | null; created_at: string;
  paid_with: string; cogs_account_label: string | null; job_number: string | null;
  entity: string | null; qbo_bill_id: string | null; qbo_purchase_id: string | null;
  submitter_email: string | null; _note?: string | null;
}

async function api(path = '', body?: unknown) {
  const token = await getAccessToken();
  const res = await fetch(`/expense/api/expense-books${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function TotalsPanel({ t }: { t: Totals }) {
  const Block = ({ title, rows }: { title: string; rows: { label: string; amount: number }[] }) => (
    rows.length === 0 ? null : (
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">{title}</div>
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.label} className="flex justify-between gap-3 text-[13px]">
              <span className="truncate text-muted-foreground">{r.label}</span>
              <span className="tabular-nums flex-shrink-0">{formatCurrency(r.amount)}</span>
            </div>
          ))}
        </div>
      </div>
    )
  );
  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <div>
            <div className="text-2xl font-bold tabular-nums">{formatCurrency(t.total)}</div>
            <div className="text-[11px] text-muted-foreground">{t.count} expense{t.count === 1 ? '' : 's'}</div>
          </div>
          <div className="text-[13px] text-muted-foreground">
            <span className="text-emerald-400">{formatCurrency(t.posted)}</span> in QuickBooks ·{' '}
            <span className="text-amber-300">{formatCurrency(t.unposted)}</span> not yet
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Block title="By payment type" rows={t.by_payment} />
          <Block title="By GL account" rows={t.by_account} />
          <Block title="By entity" rows={t.by_entity} />
        </div>
      </CardContent>
    </Card>
  );
}

export default function ExpenseReports() {
  const navigate = useNavigate();
  const { session } = useSession();
  const [books, setBooks] = useState<Book[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ book: Book; lines: Line[]; totals: Totals } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', tag: '', job_number: '', period_start: '', period_end: '' });

  // add-expenses picker
  const [picking, setPicking] = useState(false);
  const [candidates, setCandidates] = useState<(Line & { tag?: string | null })[]>([]);
  const [pickQuery, setPickQuery] = useState({ vendor: '', tag: '', job: '', from: '', to: '' });
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const loadBooks = useCallback(async () => {
    if (!session) return;
    try { setBooks((await api()).books ?? []); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load reports.'); }
    finally { setLoading(false); }
  }, [session]);

  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await api(`?id=${id}`)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load that report.'); }
  }, []);

  useEffect(() => { void loadBooks(); }, [loadBooks]);
  useEffect(() => { if (openId) void loadDetail(openId); else setDetail(null); }, [openId, loadDetail]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  };

  const create = () => run(async () => {
    if (!draft.name.trim()) throw new Error('Give the report a name.');
    const out = await api('', { action: 'save', ...draft });
    setCreating(false);
    setDraft({ name: '', tag: '', job_number: '', period_start: '', period_end: '' });
    await loadBooks();
    setOpenId(out.id);
  });

  const findCandidates = () => run(async () => {
    const qs = new URLSearchParams({ candidates: '1' });
    for (const [k, v] of Object.entries(pickQuery)) if (v) qs.set(k, v);
    setCandidates((await api(`?${qs}`)).candidates ?? []);
  });

  const addChosen = () => run(async () => {
    if (!openId || chosen.size === 0) return;
    await api('', { action: 'add_many', book_id: openId, expense_ids: [...chosen] });
    setChosen(new Set()); setPicking(false); setCandidates([]);
    await Promise.all([loadDetail(openId), loadBooks()]);
  });

  const downloadCsv = async () => {
    if (!openId) return;
    const token = await getAccessToken();
    const res = await fetch(`/expense/api/expense-books?id=${openId}&format=csv`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) { setError('Could not build the CSV.'); return; }
    // The endpoint is auth-gated, so a plain link can't fetch it — pull the
    // bytes with the bearer and hand the browser a blob.
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(detail?.book.name || 'expense-report').replace(/[^A-Za-z0-9._-]+/g, '-')}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  // ── Detail view ──
  if (openId && detail) {
    const { book, lines, totals } = detail;
    const editable = book.can_edit && book.status === 'open';
    return (
      <div className="space-y-4 pb-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setOpenId(null)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="page-title truncate">{book.name}</h1>
            <p className="page-description">
              {[book.tag && `Tag ${book.tag}`, book.job_number && `Job ${book.job_number}`,
                (book.period_start || book.period_end) && `${book.period_start || '…'} → ${book.period_end || '…'}`]
                .filter(Boolean).join(' · ') || 'No filters set'}
            </p>
          </div>
          {book.status === 'closed' && <Badge variant="secondary">Closed</Badge>}
        </div>

        {error && (
          <Card className="border-red-500/40">
            <CardContent className="p-3 text-sm text-red-300 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </CardContent>
          </Card>
        )}

        <TotalsPanel t={totals} />

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void downloadCsv()}>
            <Download className="h-4 w-4 mr-1.5" /> Download CSV
          </Button>
          {editable && (
            <Button size="sm" onClick={() => setPicking((v) => !v)}>
              <Plus className="h-4 w-4 mr-1.5" /> Add expenses
            </Button>
          )}
          {book.can_edit && (
            <Button
              size="sm" variant="outline" disabled={busy}
              onClick={() => run(async () => {
                await api('', { action: book.status === 'open' ? 'close' : 'reopen', book_id: book.id });
                await Promise.all([loadDetail(book.id), loadBooks()]);
              })}
            >
              {book.status === 'open'
                ? <><Lock className="h-4 w-4 mr-1.5" /> Close report</>
                : <><Unlock className="h-4 w-4 mr-1.5" /> Reopen</>}
            </Button>
          )}
        </div>

        {picking && editable && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="text-sm font-medium">Find expenses to add</div>
              <div className="grid gap-2 sm:grid-cols-5">
                <Input placeholder="Vendor" value={pickQuery.vendor} onChange={(e) => setPickQuery({ ...pickQuery, vendor: e.target.value })} />
                <Input placeholder="Tag" value={pickQuery.tag} onChange={(e) => setPickQuery({ ...pickQuery, tag: e.target.value })} />
                <Input placeholder="Job #" value={pickQuery.job} onChange={(e) => setPickQuery({ ...pickQuery, job: e.target.value })} />
                <Input type="date" value={pickQuery.from} onChange={(e) => setPickQuery({ ...pickQuery, from: e.target.value })} />
                <Input type="date" value={pickQuery.to} onChange={(e) => setPickQuery({ ...pickQuery, to: e.target.value })} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={findCandidates} disabled={busy}>
                  <Search className="h-4 w-4 mr-1.5" /> Search
                </Button>
                {chosen.size > 0 && (
                  <Button size="sm" onClick={addChosen} disabled={busy}>
                    Add {chosen.size} to this report
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => { setPicking(false); setCandidates([]); setChosen(new Set()); }}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {candidates.length > 0 && (
                <div className="max-h-80 overflow-y-auto space-y-1 pt-1">
                  {candidates.map((c) => {
                    const on = chosen.has(c.id);
                    return (
                      <button
                        key={c.id} type="button"
                        onClick={() => setChosen((s) => {
                          const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n;
                        })}
                        className={`w-full text-left rounded-lg px-3 py-2 text-[13px] flex items-center gap-3 ${on ? 'bg-sky-500/15 ring-1 ring-sky-400/40' : 'bg-white/5 hover:bg-white/10'}`}
                      >
                        <span className="flex-1 min-w-0 truncate">
                          {c.vendor_name || 'No vendor'}
                          <span className="text-muted-foreground"> · {c.paid_with}</span>
                        </span>
                        <span className="tabular-nums flex-shrink-0">{formatCurrency(c.total_amount ?? 0)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <div className="space-y-2">
          {lines.length === 0 ? (
            <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
              Nothing in this report yet.
            </CardContent></Card>
          ) : lines.map((l) => (
            <Card key={l.id}>
              <CardContent className="p-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate text-sm">{l.vendor_name || 'No vendor'}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {l.receipt_date || l.created_at.slice(0, 10)} · {l.paid_with}
                    {l.cogs_account_label ? ` · ${l.cogs_account_label}` : ''}
                    {(l.qbo_bill_id || l.qbo_purchase_id) ? ' · in QuickBooks' : ' · not posted'}
                  </div>
                </div>
                <div className="text-sm font-semibold tabular-nums flex-shrink-0">
                  {formatCurrency(l.total_amount ?? 0)}
                </div>
                {editable && (
                  <Button
                    size="icon" variant="ghost" disabled={busy}
                    title="Remove from this report (the expense itself is untouched)"
                    onClick={() => run(async () => {
                      await api('', { action: 'remove', book_id: book.id, expense_id: l.id });
                      await Promise.all([loadDetail(book.id), loadBooks()]);
                    })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // ── List view ──
  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="page-title">Expense Reports</h1>
          <p className="page-description">
            Bundle expenses across payment types — card, check, bill, job — and tie them to a tag or job.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          <Plus className="h-4 w-4 mr-1.5" /> New report
        </Button>
      </div>

      {error && (
        <Card className="border-red-500/40">
          <CardContent className="p-3 text-sm text-red-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </CardContent>
        </Card>
      )}

      {creating && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label>Report name</Label>
                <Input autoFocus placeholder="Melt Danville install — August"
                  value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div><Label>Tag</Label><Input placeholder="Installations" value={draft.tag} onChange={(e) => setDraft({ ...draft, tag: e.target.value })} /></div>
              <div><Label>Job #</Label><Input placeholder="1095464155" value={draft.job_number} onChange={(e) => setDraft({ ...draft, job_number: e.target.value })} /></div>
              <div><Label>From</Label><Input type="date" value={draft.period_start} onChange={(e) => setDraft({ ...draft, period_start: e.target.value })} /></div>
              <div><Label>To</Label><Input type="date" value={draft.period_end} onChange={(e) => setDraft({ ...draft, period_end: e.target.value })} /></div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={create} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />} Create
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="feedback-state">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
        </div>
      ) : books.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          <BookOpen className="h-8 w-8 mx-auto mb-3 opacity-40" />
          No reports yet. Create one, then add expenses to it from any payment type.
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {books.map((b) => (
            <Card key={b.id} className="cursor-pointer hover:bg-white/[0.03]" onClick={() => setOpenId(b.id)}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold truncate">{b.name}</span>
                    {b.status === 'closed' && <Badge variant="secondary">Closed</Badge>}
                    {b.tag && <Badge variant="info">{b.tag}</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 truncate">
                    {[b.job_number && `Job ${b.job_number}`,
                      (b.period_start || b.period_end) && `${b.period_start || '…'} → ${b.period_end || '…'}`,
                      b.created_by_email].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-[15px] font-bold tabular-nums">
                    {formatCurrency(Number(b.totals?.total_amount ?? 0))}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {b.totals?.item_count ?? 0} item{(b.totals?.item_count ?? 0) === 1 ? '' : 's'}
                  </div>
                </div>
                {b.can_edit && (
                  <Button
                    size="icon" variant="ghost" title="Delete this report (the expenses are untouched)"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!window.confirm(`Delete "${b.name}"? The expenses in it are not affected.`)) return;
                      void run(async () => { await api('', { action: 'delete', book_id: b.id }); await loadBooks(); });
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
