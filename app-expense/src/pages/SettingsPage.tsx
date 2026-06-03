// Brixpense → Settings.
//
// Two sections:
//   1. My Payment Accounts (everyone) — pick which QBO Bank / Credit Card
//      accounts show in *your* "Paid with" dropdown. Stored per-user under your
//      email in ops.expense_settings.payment_accounts_by_user.
//   2. Organization (superadmin/admin only) — edit the shared lists that drive
//      every form: approval threshold, approver emails, tags, departments,
//      COGS accounts, and the department→COGS cascade map. Written via the
//      role-gated ops.fn_set_expense_setting RPC (expense_settings is otherwise
//      read-only to clients).

import { useEffect, useMemo, useState } from 'react';
import { Check, RefreshCw, Save, Plus, Trash2, Search, X } from 'lucide-react';

/** Per-AccountType visual treatment for the COGS/Expense picker pills. */
const ACCT_TYPE_STYLE: Record<string, { short: string; pill: string }> = {
  'Cost of Goods Sold': { short: 'COGS', pill: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  Expense: { short: 'EXP', pill: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  'Other Expense': { short: 'OTHER', pill: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  'Fixed Asset': { short: 'ASSET', pill: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
};
const acctTypeStyle = (t: string) =>
  ACCT_TYPE_STYLE[t] ?? { short: t.toUpperCase().slice(0, 5), pill: 'bg-slate-700/40 text-slate-300 border-slate-600/40' };
import { getAccessToken, supabase } from '@/lib/supabase';

interface QboAccount {
  id: string;
  name: string;
  account_type: string;
  account_sub_type: string | null;
  payment_type: string;
}

interface CogsAccount {
  id: string;
  label: string;
}

const inputCls =
  'rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none';

/** Editable list of free-text strings (emails / tags / departments). */
function StringListEditor({
  items,
  onChange,
  placeholder,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) return;
    onChange([...items, v]);
    setDraft('');
  };
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            className={`flex-1 ${inputCls}`}
            value={it}
            onChange={(e) => {
              const next = [...items];
              next[i] = e.target.value;
              onChange(next);
            }}
          />
          <button
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            className="p-1.5 text-slate-500 hover:text-red-400 transition"
            title="Remove"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          className={`flex-1 ${inputCls} border-slate-800 bg-slate-950 text-slate-300`}
          placeholder={placeholder || 'Add…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          onClick={add}
          className="p-1.5 text-emerald-400 hover:text-emerald-300 transition"
          title="Add"
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  // ── Personal payment accounts ──
  const [allAccounts, setAllAccounts] = useState<QboAccount[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // ── Organization settings (admin only) ──
  const [isAdmin, setIsAdmin] = useState(false);
  const [threshold, setThreshold] = useState('500');
  const [managerEmails, setManagerEmails] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [cogsAccounts, setCogsAccounts] = useState<CogsAccount[]>([]);
  const [deptCogsMap, setDeptCogsMap] = useState<Record<string, string>>({});
  // Live QBO chart of accounts (COGS / Expense / Other Expense / Fixed Asset)
  // backing the checkbox picker that builds the curated cogs_accounts list.
  const [glAccounts, setGlAccounts] = useState<
    { id: string; name: string; account_type: string; account_sub_type: string | null }[]
  >([]);
  const [glErr, setGlErr] = useState<string | null>(null);
  const [cogsFilter, setCogsFilter] = useState('');
  const [orgSaving, setOrgSaving] = useState(false);
  const [orgSavedAt, setOrgSavedAt] = useState<string | null>(null);
  const [orgErr, setOrgErr] = useState<string | null>(null);

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

      const user = userRes.data?.user;
      setUserEmail(user?.email ?? null);
      const role =
        (user?.app_metadata as any)?.role ||
        (user?.user_metadata as any)?.role ||
        '';
      const admin = ['superadmin', 'admin'].includes(role);
      setIsAdmin(admin);

      if (admin) {
        const { data: rows } = await supabase
          .from('expense_settings')
          .select('key, value')
          .in('key', [
            'approval_threshold',
            'manager_emails',
            'tags',
            'departments',
            'cogs_accounts',
            'department_cogs_map',
          ]);
        const map = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value]));
        setThreshold(String(map.approval_threshold ?? 500));
        setManagerEmails((map.manager_emails ?? []) as string[]);
        setTags((map.tags ?? []) as string[]);
        setDepartments((map.departments ?? []) as string[]);
        setCogsAccounts((map.cogs_accounts ?? []) as CogsAccount[]);
        setDeptCogsMap((map.department_cogs_map ?? {}) as Record<string, string>);

        // Live QBO accounts for the COGS/Expense checkbox picker.
        setGlErr(null);
        try {
          const r = await fetch('/expense/api/expense-gl-accounts', {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (!r.ok) throw new Error(`Accounts ${r.status}`);
          const b = await r.json();
          setGlAccounts(Array.isArray(b.accounts) ? b.accounts : []);
        } catch (e) {
          setGlErr((e as Error).message);
        }
      }
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

  async function saveOrg() {
    setOrgSaving(true);
    setOrgErr(null);
    setOrgSavedAt(null);
    try {
      const cleanCogs = cogsAccounts
        .map((a) => ({ id: a.id.trim(), label: a.label.trim() }))
        .filter((a) => a.id && a.label);
      const validIds = new Set(cleanCogs.map((a) => a.id));
      const cleanDepts = departments.map((d) => d.trim()).filter(Boolean);
      const cleanMap: Record<string, string> = {};
      for (const d of cleanDepts) {
        const v = deptCogsMap[d];
        if (v && validIds.has(v)) cleanMap[d] = v;
      }
      const writes: [string, unknown][] = [
        ['approval_threshold', Number(threshold) || 0],
        ['manager_emails', managerEmails.map((s) => s.trim()).filter(Boolean)],
        ['tags', tags.map((s) => s.trim()).filter(Boolean)],
        ['departments', cleanDepts],
        ['cogs_accounts', cleanCogs],
        ['department_cogs_map', cleanMap],
      ];
      for (const [k, v] of writes) {
        const { error } = await supabase
          .schema('ops')
          .rpc('fn_set_expense_setting', { p_key: k, p_value: v });
        if (error) throw new Error(`${k}: ${error.message}`);
      }
      setOrgSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setOrgErr((e as Error).message);
    } finally {
      setOrgSaving(false);
    }
  }

  const cogsIds = useMemo(() => new Set(cogsAccounts.map((a) => a.id)), [cogsAccounts]);

  function toggleCogs(acct: { id: string; name: string }) {
    setCogsAccounts((prev) =>
      prev.some((a) => a.id === acct.id)
        ? prev.filter((a) => a.id !== acct.id)
        : [...prev, { id: acct.id, label: acct.name }],
    );
  }

  function selectCogsGroup(items: { id: string; name: string }[]) {
    setCogsAccounts((prev) => {
      const have = new Set(prev.map((a) => a.id));
      return [...prev, ...items.filter((i) => !have.has(i.id)).map((i) => ({ id: i.id, label: i.name }))];
    });
  }

  function clearCogsGroup(items: { id: string }[]) {
    const rm = new Set(items.map((i) => i.id));
    setCogsAccounts((prev) => prev.filter((a) => !rm.has(a.id)));
  }

  // QBO accounts grouped by AccountType, filtered by the search box.
  const cogsGroups = useMemo(() => {
    const q = cogsFilter.trim().toLowerCase();
    const filtered = q
      ? glAccounts.filter((a) => a.name.toLowerCase().includes(q) || a.id.includes(q))
      : glAccounts;
    const map = new Map<string, typeof glAccounts>();
    for (const a of filtered) {
      if (!map.has(a.account_type)) map.set(a.account_type, []);
      map.get(a.account_type)!.push(a);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, items]) => ({ type, items }));
  }, [glAccounts, cogsFilter]);

  // Selected accounts that aren't in the live active chart (legacy / inactive) —
  // surfaced so the admin can still see + remove them rather than losing them.
  const selectedNotInChart = useMemo(() => {
    const live = new Set(glAccounts.map((a) => a.id));
    return cogsAccounts.filter((a) => !live.has(a.id));
  }, [glAccounts, cogsAccounts]);

  // Group payment accounts by type: Bank section, Credit Card section
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

      {/* ── Organization settings (admin only) ── */}
      {isAdmin && !loading && (
        <div className="mt-12 border-t border-slate-800 pt-8">
          <div className="mb-6">
            <h2 className="text-lg font-bold text-slate-100">Organization settings</h2>
            <p className="text-sm text-slate-400 mt-1">
              Shared lists that drive every Brixpense form for everyone. Changes
              take effect on the next form load. Superadmin / admin only.
            </p>
          </div>

          {orgErr && (
            <div className="rounded border border-red-700/50 bg-red-950/30 px-3 py-2 text-sm text-red-300 mb-4">
              {orgErr}
            </div>
          )}

          <div className="space-y-8">
            <section>
              <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">
                Approval threshold ($)
              </div>
              <input
                type="number"
                min="0"
                step="50"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className={`w-40 ${inputCls}`}
              />
              <p className="text-xs text-slate-500 mt-1">
                Expenses over this amount require a manager approval; at or under auto-approve.
              </p>
            </section>

            <section>
              <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">
                Approver emails
              </div>
              <StringListEditor
                items={managerEmails}
                onChange={setManagerEmails}
                placeholder="approver@brixbev.com"
              />
            </section>

            <section>
              <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Tags</div>
              <StringListEditor items={tags} onChange={setTags} placeholder="Add a tag…" />
            </section>

            <section>
              <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Departments</div>
              <StringListEditor
                items={departments}
                onChange={setDepartments}
                placeholder="Add a department…"
              />
            </section>

            <section>
              <div className="flex items-center justify-between gap-3 mb-1">
                <div className="text-xs uppercase tracking-wider text-slate-500">COGS / Expense accounts</div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
                    {cogsAccounts.length} selected
                  </span>
                  {cogsAccounts.length > 0 && (
                    <button
                      onClick={() => setCogsAccounts([])}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-0.5 text-xs text-slate-400 hover:border-slate-600 hover:text-slate-200 transition"
                    >
                      <X size={12} /> Clear all
                    </button>
                  )}
                </div>
              </div>
              <p className="text-xs text-slate-500 mb-3">
                Pick the QBO accounts that appear in the expense form's account dropdown for everyone — pulled live from the chart of accounts (COGS, Expense, Other Expense, Fixed Asset).
              </p>

              {glErr && (
                <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200 mb-3">
                  Couldn't load the QBO chart of accounts ({glErr}). Your saved list is preserved below; reconnect QBO or Refresh to edit it.
                </div>
              )}

              {glAccounts.length > 0 && (
                <div className="relative mb-3">
                  <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 pl-9 pr-9 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                    placeholder="Filter accounts by name or id…"
                    value={cogsFilter}
                    onChange={(e) => setCogsFilter(e.target.value)}
                  />
                  {cogsFilter && (
                    <button
                      onClick={() => setCogsFilter('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 hover:text-slate-200 transition"
                      title="Clear filter"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              )}

              {glAccounts.length > 0 && (
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 overflow-hidden">
                  <div className="max-h-[26rem] overflow-y-auto divide-y divide-slate-800/70">
                    {cogsGroups.length === 0 && (
                      <div className="px-4 py-10 text-center text-sm text-slate-500">
                        No accounts match “{cogsFilter}”.
                      </div>
                    )}
                    {cogsGroups.map((g) => {
                      const ts = acctTypeStyle(g.type);
                      const selectedInGroup = g.items.filter((i) => cogsIds.has(i.id)).length;
                      const allSelected = selectedInGroup === g.items.length;
                      return (
                        <div key={g.type}>
                          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-slate-800 bg-slate-950/95 px-3 py-2 backdrop-blur">
                            <div className="flex items-center gap-2">
                              <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${ts.pill}`}>
                                {ts.short}
                              </span>
                              <span className="text-xs font-medium text-slate-300">{g.type}</span>
                              <span className="text-xs text-slate-600">
                                {selectedInGroup}/{g.items.length}
                              </span>
                            </div>
                            <button
                              onClick={() => (allSelected ? clearCogsGroup(g.items) : selectCogsGroup(g.items))}
                              className="text-xs text-emerald-400 hover:text-emerald-300 transition"
                            >
                              {allSelected ? 'Clear' : 'Select all'}
                            </button>
                          </div>
                          {g.items.map((a) => {
                            const checked = cogsIds.has(a.id);
                            return (
                              <label
                                key={a.id}
                                className={
                                  'group flex items-center gap-3 border-l-2 px-3 py-2 cursor-pointer transition ' +
                                  (checked
                                    ? 'border-emerald-400 bg-emerald-500/10'
                                    : 'border-transparent hover:bg-slate-900/60')
                                }
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleCogs(a)}
                                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-400 focus:ring-emerald-400"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm text-slate-100" title={a.name}>{a.name}</div>
                                  {a.account_sub_type && (
                                    <div className="truncate text-xs text-slate-500">{a.account_sub_type}</div>
                                  )}
                                </div>
                                <span className="shrink-0 rounded bg-slate-800/70 px-1.5 py-0.5 font-mono text-[11px] text-slate-500">
                                  #{a.id}
                                </span>
                                {checked && <Check size={14} className="shrink-0 text-emerald-400" />}
                              </label>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                  <div className="border-t border-slate-800 bg-slate-950/60 px-3 py-1.5 text-[11px] text-slate-600">
                    Showing {cogsGroups.reduce((n, g) => n + g.items.length, 0)} of {glAccounts.length} accounts
                  </div>
                </div>
              )}

              {selectedNotInChart.length > 0 && (
                <div className="mt-4 rounded-xl border border-amber-800/40 bg-amber-950/10 overflow-hidden">
                  <div className="border-b border-amber-800/30 px-3 py-2 text-[11px] uppercase tracking-wider text-amber-500/80">
                    Selected but not in active chart
                  </div>
                  {selectedNotInChart.map((a, idx) => (
                    <div
                      key={a.id}
                      className={'flex items-center gap-3 px-3 py-2 ' + (idx > 0 ? 'border-t border-amber-800/20' : '')}
                    >
                      <div className="min-w-0 flex-1 truncate text-sm text-slate-300" title={a.label}>{a.label}</div>
                      <span className="shrink-0 rounded bg-slate-800/70 px-1.5 py-0.5 font-mono text-[11px] text-slate-500">#{a.id}</span>
                      <button
                        onClick={() => setCogsAccounts(cogsAccounts.filter((x) => x.id !== a.id))}
                        className="shrink-0 rounded p-1 text-slate-500 hover:text-red-400 transition"
                        title="Remove"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">
                Department → default COGS
              </div>
              <p className="text-xs text-slate-500 mb-3">
                When a submitter picks a department on the form, this COGS account is pre-selected (they can still override it).
              </p>
              <div className="space-y-2">
                {departments.filter((d) => d.trim()).map((d) => (
                  <div key={d} className="flex items-center gap-3">
                    <span className="w-32 text-sm text-slate-300 truncate" title={d}>{d}</span>
                    <select
                      className={`flex-1 ${inputCls}`}
                      value={deptCogsMap[d] || ''}
                      onChange={(e) => setDeptCogsMap({ ...deptCogsMap, [d]: e.target.value })}
                    >
                      <option value="">— none —</option>
                      {cogsAccounts
                        .filter((a) => a.id.trim() && a.label.trim())
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.label}
                          </option>
                        ))}
                    </select>
                  </div>
                ))}
                {departments.filter((d) => d.trim()).length === 0 && (
                  <div className="text-xs text-slate-500">Add a department above to map it.</div>
                )}
              </div>
            </section>
          </div>

          <div className="mt-8 flex items-center justify-end gap-4">
            {orgSavedAt && <span className="text-xs text-emerald-400">Saved at {orgSavedAt}</span>}
            <button
              onClick={saveOrg}
              disabled={orgSaving}
              className="inline-flex items-center gap-2 rounded bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-emerald-950 transition"
            >
              <Save size={14} />
              {orgSaving ? 'Saving…' : 'Save organization settings'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
