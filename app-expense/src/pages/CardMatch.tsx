// Card Connection Services — moved here from Master Control (2026-08-14).
// Superadmin-only, reachable ONLY from Settings → Card Connection Services
// (deliberately no sidebar nav entry — it's module configuration, not a
// daily-driver page).
//
// Every posted card swipe / cash expense / check in QuickBooks is a Purchase
// transaction; Brixpense (ops.expense_requests) holds the human side of the
// same spend. This page joins the two so an operator can reconcile them:
//
//   · Cardholders — assign each company card's last-4 to its user (drives the
//     "whose receipt is missing" attribution). The user picker is server-
//     filtered to internal users whose gateway role grants Brixpense access —
//     customer/melt/driver logins on the shared auth never appear.
//   · Suggested merges — same amount, dates within 14 days.
//   · Charges with no Brixpense record — importable (lands as already-posted,
//     never re-posts to QBO).
//   · Brixpense records with no QBO charge, and the already-merged list.
//
// Backend: netlify/functions/expense-cc-match.mjs (superadmin-gated). This
// page mirrors that gate client-side and hides itself from everyone else.
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase, getAccessToken } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, CreditCard, Loader2, RefreshCw, Link2, Unlink, Download } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';

interface CcPurchase {
  id: string;
  txn_date: string | null;
  payee: string | null;
  amount: number;
  is_credit?: boolean;
  payment_type: string | null;
  account: string | null;
  memo: string | null;
  card_last4: string | null;
}
interface CcExpense {
  id: string;
  receipt_date: string | null;
  vendor_name: string | null;
  total_amount: number;
  status: string | null;
  tag: string | null;
  submitter_name: string | null;
  department: string | null;
}
interface CcSuggestion {
  purchase: CcPurchase;
  expense: CcExpense;
  days_apart: number;
  vendor_similarity: number;
}
interface CcCardSeen { last4: string; count: number; amount: number }
interface CcCardMap {
  last4: string;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  receipts_from: string | null;
}
interface CcData {
  card_summary: CcCardSeen[];
  card_map: CcCardMap[];
  suggestions: CcSuggestion[];
  unmatched_purchases: CcPurchase[];
  unmatched_expenses: CcExpense[];
  linked: { purchase: CcPurchase; expense: CcExpense }[];
  totals: {
    purchases: number;
    purchases_amount: number;
    linked: number;
    suggestions: number;
    unmatched_purchases: number;
    unmatched_purchases_amount: number;
    unmatched_expenses: number;
  };
}
interface CcUser { id: string; email: string; name: string; role: string }

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

async function ccApi<T = Record<string, unknown>>(method: 'GET' | 'POST', body?: unknown, qs = ''): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`/expense/api/expense-cc-match${qs}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

function PurchaseCell({ p, holder }: { p: CcPurchase; holder?: CcCardMap | null }) {
  return (
    <div className="min-w-0">
      <div className="text-sm">
        <span className="font-semibold">{p.txn_date || ''}</span>{' '}
        {p.payee || '(no payee)'} — <span className="font-semibold tabular-nums">{formatCurrency(p.is_credit ? -p.amount : p.amount)}</span>
        {p.is_credit && <span className="ml-1 text-amber-400 text-xs">(credit)</span>}
      </div>
      <div className="text-xs text-muted-foreground truncate">
        {p.payment_type || '?'} · {p.account || ''}{p.memo ? ` · ${p.memo.slice(0, 70)}` : ''}
        {p.card_last4 && (
          holder && (holder.user_name || holder.user_email)
            ? <span className="ml-1 text-sky-400 font-medium">💳 {holder.user_name || holder.user_email} (••{p.card_last4})</span>
            : <span className="ml-1 text-amber-400">💳 ••{p.card_last4} unassigned</span>
        )}
      </div>
    </div>
  );
}

function ExpenseCell({ e }: { e: CcExpense }) {
  return (
    <div className="min-w-0">
      <div className="text-sm">
        <span className="font-semibold">{e.receipt_date || ''}</span>{' '}
        {e.vendor_name || '(no vendor)'} — <span className="font-semibold tabular-nums">{formatCurrency(e.total_amount)}</span>
      </div>
      <div className="text-xs text-muted-foreground truncate">
        {e.status || ''}{e.tag ? ` · ${e.tag}` : ''}{e.submitter_name ? ` · ${e.submitter_name}` : ''}{e.department ? ` · ${e.department}` : ''}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="section-title mt-6 mb-2">{children}</h2>;
}

export default function CardMatch() {
  const navigate = useNavigate();
  const [isSuperadmin, setIsSuperadmin] = useState<boolean | null>(null);
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 45 * 86400000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [data, setData] = useState<CcData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Cardholder assignment editor state
  const [users, setUsers] = useState<CcUser[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [editingCard, setEditingCard] = useState<string | null>(null);
  const [pickUserId, setPickUserId] = useState('');
  const [receiptsFrom, setReceiptsFrom] = useState(() => isoDay(new Date()));

  useEffect(() => {
    supabase.auth.getUser().then(({ data: d }) => {
      const role =
        (d.user?.app_metadata as { role?: string } | undefined)?.role ||
        (d.user?.user_metadata as { role?: string } | undefined)?.role ||
        '';
      setIsSuperadmin(role === 'superadmin');
    });
  }, []);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await ccApi<CcData>('GET', undefined, `?from=${from}&to=${to}`);
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  };

  const mapBy = new Map((data?.card_map ?? []).map((c) => [c.last4, c]));

  const openAssign = async (last4: string) => {
    setEditingCard(last4);
    setPickUserId(mapBy.get(last4)?.user_id ?? '');
    setReceiptsFrom(mapBy.get(last4)?.receipts_from ?? isoDay(new Date()));
    if (!users) {
      try {
        const r = await ccApi<{ users: CcUser[] }>('POST', { action: 'list_users' });
        setUsers(r.users ?? []);
        setUsersError(null);
      } catch (e) {
        setUsersError(e instanceof Error ? e.message : 'Could not load users');
      }
    }
  };

  const saveAssign = async (last4: string) => {
    const u = (users ?? []).find((x) => x.id === pickUserId);
    if (!u) return;
    setBusy(`assign:${last4}`);
    try {
      await ccApi('POST', {
        action: 'assign_card', last4,
        user_id: u.id, user_email: u.email, user_name: u.name || null,
        receipts_from: receiptsFrom,
      });
      setEditingCard(null);
      await load();
    } catch (e) {
      alert(`Assign failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const unassign = async (last4: string) => {
    if (!window.confirm(`Unassign card •••• ${last4}?`)) return;
    setBusy(`assign:${last4}`);
    try {
      await ccApi('POST', { action: 'unassign_card', last4 });
      setEditingCard(null);
      await load();
    } catch (e) {
      alert(`Unassign failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const link = async (purchaseId: string, expenseId: string) => {
    setBusy(`link:${purchaseId}`);
    try {
      await ccApi('POST', { action: 'link', purchaseId, expenseId });
      await load();
    } catch (e) {
      alert(`Merge failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const unlink = async (expenseId: string) => {
    if (!window.confirm('Unlink this charge from the Brixpense record?')) return;
    setBusy(`unlink:${expenseId}`);
    try {
      await ccApi('POST', { action: 'unlink', expenseId });
      await load();
    } catch (e) {
      alert(`Unlink failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const importPurchase = async (purchaseId: string) => {
    if (!window.confirm('Create a Brixpense record from this QBO charge? (It lands as already-posted — nothing re-posts to QuickBooks.)')) return;
    setBusy(`import:${purchaseId}`);
    try {
      await ccApi('POST', { action: 'import', purchaseId });
      await load();
    } catch (e) {
      alert(`Import failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  if (isSuperadmin === null) {
    return <div className="feedback-state"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (!isSuperadmin) {
    return (
      <Card><CardContent className="feedback-state">
        Card Connection Services is superadmin-only.
      </CardContent></Card>
    );
  }

  const inputCls = 'rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none';
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/settings')} title="Back to Settings">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="page-title flex items-center gap-2">
            <CreditCard className="h-5 w-5" /> Card Connection Services
          </h1>
          <p className="page-description">
            Assign card last-4s to their users and merge the QBO credit-card/expense feed with Brixpense records.
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-5">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-muted-foreground">From<br />
              <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="text-xs text-muted-foreground">To<br />
              <input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <Button onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {loading ? 'Loading… (QBO can take ~20s)' : 'Load / Refresh'}
            </Button>
          </div>
          {t && (
            <p className="text-xs text-muted-foreground mt-3">
              {t.purchases} QBO charges ({formatCurrency(t.purchases_amount)}) · {t.linked} merged · {t.suggestions} suggested ·{' '}
              {t.unmatched_purchases} charges w/o Brixpense record ({formatCurrency(t.unmatched_purchases_amount)}) ·{' '}
              {t.unmatched_expenses} Brixpense w/o charge
            </p>
          )}
          {error && <p className="text-sm text-red-400 mt-3">Failed: {error}</p>}
        </CardContent>
      </Card>

      {data && (
        <Card>
          <CardContent className="p-5 pt-4 sm:p-6 sm:pt-5">
            {data.card_summary.length > 0 && (
              <>
                <SectionTitle>💳 Cardholders ({data.card_summary.length} cards seen) — assign each card's last-4 to its user</SectionTitle>
                <p className="text-xs text-muted-foreground mb-2">
                  Only internal users with Brixpense access are listed.{' '}
                  <a href="https://alamedapointbg.com/admin.html" target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">
                    + create a new user (gateway admin) ↗
                  </a>
                </p>
                <div className="space-y-2">
                  {data.card_summary.map((c) => {
                    const m = mapBy.get(c.last4);
                    const assigned = m && (m.user_email || m.user_name);
                    const editing = editingCard === c.last4;
                    return (
                      <div key={c.last4} className="rounded-lg border border-border/60 px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="font-mono text-sm whitespace-nowrap">•••• {c.last4}</span>
                          <span className="text-xs text-muted-foreground whitespace-nowrap">{c.count} txns · {formatCurrency(c.amount)}</span>
                          <div className="flex-1 min-w-[160px] text-sm">
                            {assigned ? (
                              <>
                                <span className="font-semibold">{m!.user_name || m!.user_email}</span>
                                {m!.user_name && m!.user_email && <span className="text-muted-foreground text-xs ml-2">{m!.user_email}</span>}
                                {m!.receipts_from && <div className="text-[11px] text-muted-foreground">receipts expected from {m!.receipts_from}</div>}
                              </>
                            ) : (
                              <Badge variant="warning">unassigned</Badge>
                            )}
                          </div>
                          {!editing && (
                            <Button size="sm" variant="secondary" onClick={() => openAssign(c.last4)}>
                              {assigned ? 'Reassign' : 'Assign'} →
                            </Button>
                          )}
                        </div>
                        {editing && (
                          <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-border/60 pt-3">
                            {usersError ? (
                              <p className="text-sm text-red-400">Could not load users: {usersError}</p>
                            ) : users === null ? (
                              <span className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Loading users…</span>
                            ) : users.length === 0 ? (
                              <p className="text-sm text-amber-400">No Brixpense-access users found — create one in the gateway admin (role with billing access) first.</p>
                            ) : (
                              <>
                                <label className="text-xs text-muted-foreground">User<br />
                                  <select className={inputCls} value={pickUserId} onChange={(e) => setPickUserId(e.target.value)}>
                                    <option value="">— pick a user —</option>
                                    {users.map((u) => (
                                      <option key={u.id} value={u.id}>
                                        {u.name ? `${u.name} — ` : ''}{u.email}{u.role ? ` (${u.role})` : ''}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="text-xs text-muted-foreground" title="Swipes before this date are NOT chased by the Monday receipt audit — back-date if this user has already been submitting receipts.">
                                  Expect receipts from<br />
                                  <input type="date" className={inputCls} value={receiptsFrom} onChange={(e) => setReceiptsFrom(e.target.value)} />
                                </label>
                                <Button size="sm" disabled={!pickUserId || busy === `assign:${c.last4}`} onClick={() => saveAssign(c.last4)}>
                                  {busy === `assign:${c.last4}` ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
                                </Button>
                                {assigned && (
                                  <Button size="sm" variant="destructive" disabled={busy === `assign:${c.last4}`} onClick={() => unassign(c.last4)}>
                                    Unassign
                                  </Button>
                                )}
                              </>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setEditingCard(null)}>Cancel</Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {data.suggestions.length > 0 && (
              <>
                <SectionTitle>🤝 Suggested merges ({data.suggestions.length}) — same amount, dates within 14 days</SectionTitle>
                <div className="space-y-2">
                  {data.suggestions.map((s) => (
                    <div key={`${s.purchase.id}:${s.expense.id}`} className="rounded-lg border border-border/60 px-3 py-2.5 flex flex-wrap items-center gap-3">
                      <div className="flex-1 min-w-[220px]"><PurchaseCell p={s.purchase} holder={s.purchase.card_last4 ? mapBy.get(s.purchase.card_last4) : null} /></div>
                      <div className="flex-1 min-w-[220px]"><ExpenseCell e={s.expense} /></div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">{s.days_apart}d apart · vendor {s.vendor_similarity}%</span>
                      <Button size="sm" variant="success" disabled={busy === `link:${s.purchase.id}`} onClick={() => link(s.purchase.id, s.expense.id)}>
                        <Link2 className="h-4 w-4" /> Merge ✓
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {data.unmatched_purchases.length > 0 && (
              <>
                <SectionTitle>🧾 Charges with NO Brixpense record ({data.unmatched_purchases.length}) — no receipt/context on file</SectionTitle>
                <div className="space-y-2">
                  {data.unmatched_purchases.map((p) => (
                    <div key={p.id} className="rounded-lg border border-border/60 px-3 py-2.5 flex flex-wrap items-center gap-3">
                      <div className="flex-1 min-w-[220px]"><PurchaseCell p={p} holder={p.card_last4 ? mapBy.get(p.card_last4) : null} /></div>
                      <Button size="sm" disabled={busy === `import:${p.id}`} onClick={() => importPurchase(p.id)}>
                        <Download className="h-4 w-4" /> Import to Brixpense →
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {data.unmatched_expenses.length > 0 && (
              <>
                <SectionTitle>📭 Brixpense records with no QBO charge ({data.unmatched_expenses.length}) — submitted but never hit the books as a Purchase</SectionTitle>
                <div className="space-y-2">
                  {data.unmatched_expenses.map((e) => (
                    <div key={e.id} className="rounded-lg border border-border/60 px-3 py-2.5"><ExpenseCell e={e} /></div>
                  ))}
                </div>
              </>
            )}

            {data.linked.length > 0 && (
              <>
                <SectionTitle>✅ Already merged ({data.linked.length})</SectionTitle>
                <div className="space-y-2">
                  {data.linked.map((l) => (
                    <div key={l.expense.id} className="rounded-lg border border-border/60 px-3 py-2.5 flex flex-wrap items-center gap-3">
                      <div className="flex-1 min-w-[220px]"><PurchaseCell p={l.purchase} holder={l.purchase.card_last4 ? mapBy.get(l.purchase.card_last4) : null} /></div>
                      <div className="flex-1 min-w-[220px]"><ExpenseCell e={l.expense} /></div>
                      <Button size="sm" variant="ghost" disabled={busy === `unlink:${l.expense.id}`} onClick={() => unlink(l.expense.id)}>
                        <Unlink className="h-4 w-4" /> Unlink
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {data.card_summary.length === 0 && data.suggestions.length === 0 && data.unmatched_purchases.length === 0 &&
              data.unmatched_expenses.length === 0 && data.linked.length === 0 && (
              <p className="text-sm text-muted-foreground py-4">Nothing in this window — pick a range and Load.</p>
            )}
          </CardContent>
        </Card>
      )}

      {!data && !loading && !error && (
        <p className="text-xs text-muted-foreground">Pick a date range and hit Load — the QBO read can take ~20 seconds.</p>
      )}
    </div>
  );
}
