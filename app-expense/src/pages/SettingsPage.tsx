// Brixpense → Settings → My Payment Accounts.
//
// Pick which QBO Bank / Credit Card accounts show up in *your* "Paid with"
// dropdown on the expense form. The list is per-user (stored under your
// email in ops.expense_settings.payment_accounts_by_user) — your selections
// don't affect anyone else. When you have zero selections saved, the form
// falls back to the full QBO list.

import { useEffect, useMemo, useState } from 'react';
import { Check, RefreshCw, Save } from 'lucide-react';
import { getAccessToken, supabase } from '@/lib/supabase';

interface QboAccount {
  id: string;
  name: string;
  account_type: string;
  account_sub_type: string | null;
  payment_type: string;
}

export default function SettingsPage() {
  const [allAccounts, setAllAccounts] = useState<QboAccount[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  async function loadAll() {
    setLoading(true);
    setErr(null);
    try {
      const token = await getAccessToken();
      const [acctRes, currRes, userRes] = await Promise.all([
        fetch('/expense/api/expense-payment-accounts?all=1', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
        supabase.schema('ops').rpc('fn_get_user_payment_accounts'),
        supabase.auth.getUser(),
      ]);
      if (!acctRes.ok) throw new Error(`Payment accounts ${acctRes.status}`);
      const body = await acctRes.json();
      const accounts: QboAccount[] = Array.isArray(body.accounts) ? body.accounts : [];
      setAllAccounts(accounts);

      const current = (currRes.data as QboAccount[] | null) ?? [];
      setSelectedIds(new Set(current.map((a) => String(a.id))));
      setUserEmail(userRes.data?.user?.email ?? null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  function toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  async function save() {
    if (!allAccounts) return;
    setSaving(true);
    setErr(null);
    setSavedAt(null);
    try {
      const picked = allAccounts.filter((a) => selectedIds.has(a.id));
      const { error } = await supabase.schema('ops').rpc('fn_set_user_payment_accounts', { p_accounts: picked });
      if (error) throw new Error(error.message);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Group accounts by type so the page reads as: Bank section, Credit Card section
  const groups = useMemo(() => {
    if (!allAccounts) return [] as { type: string; items: QboAccount[] }[];
    const map = new Map<string, QboAccount[]>();
    for (const a of allAccounts) {
      if (!map.has(a.account_type)) map.set(a.account_type, []);
      map.get(a.account_type)!.push(a);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, items]) => ({ type, items: items.sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [allAccounts]);

  return (
    <div className="mx-auto max-w-3xl py-8 px-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-100">Settings</h1>
        <p className="text-sm text-slate-400 mt-1">
          Your personal "Paid with" dropdown. Pick the accounts you use to pay
          for receipts. Only your selections appear when you submit an expense
          — everyone else has their own list.
        </p>
        {userEmail && (
          <p className="text-xs text-slate-500 mt-2">Signed in as <span className="text-slate-300">{userEmail}</span></p>
        )}
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
          My payment accounts ({selectedIds.size} of {allAccounts?.length ?? 0} selected)
        </h2>
        <button
          onClick={loadAll}
          disabled={loading || saving}
          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition"
          title="Reload from QBO"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {loading && <div className="text-sm text-slate-400">Loading QBO accounts…</div>}
      {err && (
        <div className="rounded border border-red-700/50 bg-red-950/30 px-3 py-2 text-sm text-red-300 mb-4">
          {err}
        </div>
      )}

      {!loading && allAccounts && allAccounts.length === 0 && (
        <div className="rounded border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          No Bank or Credit Card accounts are active in QBO. Add one in QuickBooks first.
        </div>
      )}

      <div className="space-y-6">
        {groups.map((g) => (
          <section key={g.type}>
            <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">{g.type}</div>
            <div className="rounded border border-slate-800 bg-slate-950/50 overflow-hidden">
              {g.items.map((a, idx) => {
                const checked = selectedIds.has(a.id);
                return (
                  <label
                    key={a.id}
                    className={
                      'flex items-center gap-3 px-4 py-3 cursor-pointer transition ' +
                      (checked ? 'bg-emerald-950/30' : 'hover:bg-slate-900/60') +
                      (idx > 0 ? ' border-t border-slate-800' : '')
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(a.id)}
                      className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-400 focus:ring-emerald-400"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-slate-100">{a.name}</div>
                      <div className="text-xs text-slate-500">{a.account_sub_type ?? a.account_type}</div>
                    </div>
                    {checked && <Check size={14} className="text-emerald-400" />}
                  </label>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-between gap-4">
        <div className="text-xs text-slate-500">
          {selectedIds.size === 0 && allAccounts && allAccounts.length > 0 && (
            <>Save with zero selections to keep the dropdown defaulting to the full QBO list.</>
          )}
          {savedAt && <span className="text-emerald-400">Saved at {savedAt}</span>}
        </div>
        <button
          onClick={save}
          disabled={loading || saving || !allAccounts}
          className="inline-flex items-center gap-2 rounded bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-emerald-950 transition"
        >
          <Save size={14} />
          {saving ? 'Saving…' : 'Save my list'}
        </button>
      </div>
    </div>
  );
}
