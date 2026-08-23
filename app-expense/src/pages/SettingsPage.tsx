// Brixpense → Settings.
//
// Three tabs:
//   You          — which QBO Bank / Credit Card accounts show in *your* "Paid
//                  with" dropdown. Stored per-user under your email in
//                  ops.expense_settings.payment_accounts_by_user.
//   Organization — (admin) the shared lists every form runs on: approval
//                  threshold and approvers, departments, tags, and the expense
//                  accounts. Written via the role-gated
//                  ops.fn_set_expense_setting RPC; expense_settings is
//                  otherwise read-only to clients.
//   Connections  — (admin) the surfaces configured elsewhere, signposted from
//                  here so "where do I change that" has one answer.
//
// A DEPARTMENT is one row, not three lists. Its name, its approver and its
// default account used to live in three separate sections of one long scroll,
// which meant setting a department up was three trips and keeping them lined up
// by eye. Renaming one also silently orphaned its approver and account, because
// both maps are keyed on the name string — renameDepartment() carries them.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, RefreshCw, Save, Plus, Trash2, Search, X, CreditCard, Mail } from 'lucide-react';

type Tab = 'you' | 'org' | 'connections';

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
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { SelectField } from '@/components/ui/select-field';

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
  const navigate = useNavigate();
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
  // Card Connection Services entry (superadmin only — matches the backend
  // gate on expense-cc-match; admins see Organization but not this).
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  const [threshold, setThreshold] = useState('500');
  const [managerEmails, setManagerEmails] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [cogsAccounts, setCogsAccounts] = useState<CogsAccount[]>([]);
  const [deptCogsMap, setDeptCogsMap] = useState<Record<string, string>>({});
  // Auto-routing for approvals: a default approver + per-department overrides.
  const [routingDefault, setRoutingDefault] = useState('');
  const [routingByDept, setRoutingByDept] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>('you');
  const [deptDraft, setDeptDraft] = useState('');
  // Live QBO chart of accounts (COGS / Expense / Other Expense / Fixed Asset)
  // backing the checkbox picker that builds the curated cogs_accounts list.
  const [glAccounts, setGlAccounts] = useState<
    { id: string; name: string; account_type: string; account_sub_type: string | null }[]
  >([]);
  const [glErr, setGlErr] = useState<string | null>(null);
  const [cogsFilter, setCogsFilter] = useState('');
  // Manual fallback entry — lets an admin add an account by id + label even when
  // the live QBO chart can't load (token expired / QBO down), so the picker is
  // never a dead end.
  const [manualId, setManualId] = useState('');
  const [manualLabel, setManualLabel] = useState('');
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
      setIsSuperadmin(role === 'superadmin');

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
            'approval_routing',
          ]);
        const map = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value]));
        setThreshold(String(map.approval_threshold ?? 500));
        setManagerEmails((map.manager_emails ?? []) as string[]);
        setTags((map.tags ?? []) as string[]);
        setDepartments((map.departments ?? []) as string[]);
        setCogsAccounts((map.cogs_accounts ?? []) as CogsAccount[]);
        setDeptCogsMap((map.department_cogs_map ?? {}) as Record<string, string>);
        const routing = (map.approval_routing ?? {}) as {
          default_approver?: string;
          by_department?: Record<string, string>;
        };
        setRoutingDefault(routing.default_approver ?? '');
        setRoutingByDept(routing.by_department ?? {});

        // Live QBO accounts for the COGS/Expense checkbox picker.
        setGlErr(null);
        try {
          const r = await fetch('/expense/api/expense-gl-accounts', {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (!r.ok) throw new Error(`Accounts ${r.status}`);
          const b = await r.json();
          const live = Array.isArray(b.accounts) ? b.accounts : [];
          setGlAccounts(live);
          // Reconcile saved COGS labels against the live QBO chart by id. The
          // expense form renders cogs_accounts verbatim, so stale labels make
          // Setup (live QBO names) and the form (saved labels) disagree. Refresh
          // each saved label to QBO's current name; the next Save persists them.
          const liveById = new Map<string, string>(
            live.map((a: { id: string; name: string }) => [String(a.id), a.name] as [string, string]),
          );
          setCogsAccounts((prev) =>
            prev.map((a) => {
              const name = liveById.get(String(a.id));
              return name && name !== a.label ? { ...a, label: name } : a;
            }),
          );
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
      const validApprovers = new Set(managerEmails.map((s) => s.trim().toLowerCase()).filter(Boolean));
      const cleanByDept: Record<string, string> = {};
      for (const d of cleanDepts) {
        const a = routingByDept[d];
        if (a && validApprovers.has(a.toLowerCase())) cleanByDept[d] = a;
      }
      const cleanRouting = {
        default_approver: validApprovers.has(routingDefault.toLowerCase()) ? routingDefault : '',
        by_department: cleanByDept,
      };
      const writes: [string, unknown][] = [
        ['approval_threshold', Number(threshold) || 0],
        ['manager_emails', managerEmails.map((s) => s.trim()).filter(Boolean)],
        ['tags', tags.map((s) => s.trim()).filter(Boolean)],
        ['departments', cleanDepts],
        ['cogs_accounts', cleanCogs],
        ['department_cogs_map', cleanMap],
        ['approval_routing', cleanRouting],
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

  // Both routing maps are keyed on the department NAME, so a rename has to move
  // them or the department silently loses its approver and its default account
  // while still looking configured.
  function renameDepartment(index: number, next: string) {
    const prev = departments[index];
    setDepartments(departments.map((d, i) => (i === index ? next : d)));
    if (prev === next) return;
    for (const [map, set] of [
      [routingByDept, setRoutingByDept] as const,
      [deptCogsMap, setDeptCogsMap] as const,
    ]) {
      if (!(prev in map)) continue;
      const moved = { ...map, [next]: map[prev] };
      delete moved[prev];
      set(moved);
    }
  }

  function removeDepartment(index: number) {
    const name = departments[index];
    setDepartments(departments.filter((_, i) => i !== index));
    for (const [map, set] of [
      [routingByDept, setRoutingByDept] as const,
      [deptCogsMap, setDeptCogsMap] as const,
    ]) {
      if (!(name in map)) continue;
      const next = { ...map };
      delete next[name];
      set(next);
    }
  }

  function addDepartment() {
    const v = deptDraft.trim();
    if (!v || departments.includes(v)) return;
    setDepartments([...departments, v]);
    setDeptDraft('');
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

  function addManualCogs() {
    const id = manualId.trim();
    if (!id) return;
    const label = manualLabel.trim() || `Account #${id}`;
    setCogsAccounts((prev) => (prev.some((a) => a.id === id) ? prev : [...prev, { id, label }]));
    setManualId('');
    setManualLabel('');
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

  const TABS: { key: Tab; label: string; show: boolean }[] = [
    { key: 'you', label: 'You', show: true },
    { key: 'org', label: 'Organization', show: isAdmin },
    { key: 'connections', label: 'Connections', show: isAdmin },
  ];
  const visibleTabs = TABS.filter((t) => t.show);
  const activeTab = visibleTabs.some((t) => t.key === tab) ? tab : 'you';

  return (
    <div className="space-y-4 pb-28">
      <div>
        <h1 className="page-title">Settings</h1>
        <p className="page-description">
          {userEmail ? <>Signed in as <span className="text-foreground">{userEmail}</span>.</> : null}{' '}
          {isAdmin
            ? 'Your own preferences, the shared lists everyone’s forms run on, and the connected services.'
            : 'Your own preferences.'}
        </p>
      </div>

      {visibleTabs.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {visibleTabs.map((t) => (
            <Button
              key={t.key}
              size="sm"
              variant={activeTab === t.key ? 'default' : 'outline'}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </Button>
          ))}
        </div>
      )}

      {/* ───────────────────────── You ───────────────────────── */}
      {activeTab === 'you' && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="section-title">My payment accounts</h2>
                <p className="section-description">
                  Which accounts appear in <em>your</em> &ldquo;Paid with&rdquo; dropdown. Everyone has their own list.
                </p>
              </div>
              <Badge variant="secondary">{selectedIds.size} of {allAccounts?.length ?? 0}</Badge>
              <Button variant="ghost" size="icon" title="Reload from QuickBooks" onClick={loadAll} disabled={loading || saving}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>

            {loading && <p className="text-sm text-muted-foreground">Loading QuickBooks accounts…</p>}
            {err && (
              <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{err}</div>
            )}
            {!loading && allAccounts && allAccounts.length === 0 && (
              <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                No Bank or Credit Card accounts are active in QuickBooks. Add one there first.
              </div>
            )}

            {groups.map((g) => (
              <div key={g.type}>
                <div className="eyebrow mb-1.5">{g.type}</div>
                <div className="rounded-xl border border-border overflow-hidden">
                  {g.items.map((a, idx) => {
                    const checked = selectedIds.has(a.id);
                    return (
                      <label
                        key={a.id}
                        className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${
                          checked ? 'bg-emerald-500/10' : 'hover:bg-white/[0.04]'
                        }${idx > 0 ? ' border-t border-border' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(a.id)}
                          className="h-4 w-4"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{a.name}</div>
                          <div className="text-xs text-muted-foreground">{a.account_sub_type ?? a.account_type}</div>
                        </div>
                        {checked && <Check size={14} className="text-emerald-400 shrink-0" />}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}

            {selectedIds.size === 0 && allAccounts && allAccounts.length > 0 && (
              <p className="section-description">
                Saving with none selected keeps the dropdown showing the full QuickBooks list.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ────────────────────── Organization ────────────────────── */}
      {activeTab === 'org' && isAdmin && (
        <>
          {orgErr && (
            <Card className="border-red-500/40">
              <CardContent className="p-3 text-sm text-red-300">{orgErr}</CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-4 space-y-4">
              <div>
                <h2 className="section-title">Approvals</h2>
                <p className="section-description">
                  Who signs off, and above what amount. Shared by everyone’s forms.
                </p>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <Label>Approval threshold ($)</Label>
                  <Input
                    type="number" min="0" step="50" className="w-40"
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Over this needs a manager; at or under auto-approves.
                  </p>
                </div>
                <div>
                  <Label>Default approver</Label>
                  <SelectField
                    value={routingDefault}
                    onChange={(e) => setRoutingDefault(e.target.value)}
                    options={[
                      { value: '', label: '— none —' },
                      ...managerEmails.filter((m) => m.trim()).map((m) => ({ value: m, label: m })),
                    ]}
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Used when the department below has no one of its own.
                  </p>
                </div>
              </div>

              <div>
                <Label>Approvers</Label>
                <p className="text-[11px] text-muted-foreground mb-2">
                  The people a submitter can pick from. Removing someone here does not touch requests already waiting on them.
                </p>
                <StringListEditor items={managerEmails} onChange={setManagerEmails} placeholder="approver@brixbev.com" />
              </div>
            </CardContent>
          </Card>

          {/* Departments used to be THREE separate lists of the same names — the
              list itself, the approver routing, and the default account — each
              in its own section, so setting one department up meant scrolling
              between three places and keeping them lined up by eye. One row per
              department says the whole thing at once. */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <div>
                <h2 className="section-title">Departments</h2>
                <p className="section-description">
                  Each department, who approves for it, and which account its expenses default to.
                  A submitter can override both.
                </p>
              </div>

              <div className="data-table-shell">
                <table className="data-table min-w-[660px]">
                  <thead>
                    <tr>
                      <th>Department</th>
                      <th>Approver</th>
                      <th>Default account</th>
                      <th className="w-12" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {departments.map((d, i) => (
                      <tr key={i}>
                        <td>
                          <Input
                            value={d}
                            onChange={(e) => renameDepartment(i, e.target.value)}
                            placeholder="Department name"
                          />
                        </td>
                        <td>
                          <SelectField
                            value={routingByDept[d] || ''}
                            onChange={(e) => setRoutingByDept({ ...routingByDept, [d]: e.target.value })}
                            options={[
                              { value: '', label: '— use default —' },
                              ...managerEmails.filter((m) => m.trim()).map((m) => ({ value: m, label: m })),
                            ]}
                          />
                        </td>
                        <td>
                          <SelectField
                            value={deptCogsMap[d] || ''}
                            onChange={(e) => setDeptCogsMap({ ...deptCogsMap, [d]: e.target.value })}
                            options={[
                              { value: '', label: '— none —' },
                              ...cogsAccounts
                                .filter((a) => a.id.trim() && a.label.trim())
                                .map((a) => ({ value: a.id, label: a.label })),
                            ]}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => removeDepartment(i)}
                            className="p-1.5 text-muted-foreground hover:text-red-400 transition-colors"
                            title={`Remove ${d || 'this department'}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <Input
                          placeholder="Add a department…"
                          value={deptDraft}
                          onChange={(e) => setDeptDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDepartment(); } }}
                        />
                      </td>
                      <td colSpan={3}>
                        <Button size="sm" variant="outline" onClick={addDepartment} disabled={!deptDraft.trim()}>
                          <Plus size={14} className="mr-1" /> Add
                        </Button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {cogsAccounts.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Pick some expense accounts below and they become selectable here.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-2">
              <div>
                <h2 className="section-title">Tags</h2>
                <p className="section-description">
                  The tag list on every expense form. Expense Reports group by these.
                </p>
              </div>
              <StringListEditor items={tags} onChange={setTags} placeholder="Add a tag…" />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between gap-3 mb-1">
          <div className="eyebrow">Expense accounts</div>
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
        <p className="section-description mb-3">
          Pick the QBO accounts that appear in the expense form's account dropdown for everyone — pulled live from the chart of accounts (COGS, Expense, Other Expense, Fixed Asset).
        </p>

        {glErr && (
          <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200 mb-3">
            Couldn't load the QBO chart of accounts ({glErr}). Your saved list is preserved below; reconnect QBO or Refresh to retry — or add an account by id manually below.
          </div>
        )}

        {/* Manual fallback: when the live chart is empty (fetch failed / QBO
            down), the checkbox picker can't render, so offer a direct
            id + label entry. Find the id in QBO under Accounting → Chart
            of Accounts (or via Settings → Refresh once QBO is back). */}
        {glAccounts.length === 0 && (
          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 mb-3">
            <div className="text-xs text-slate-400 mb-2">
              Add an account manually (QBO account id + the label to show on the form):
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                className="w-full sm:w-40 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                placeholder="Account id (e.g. 101)"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addManualCogs()}
              />
              <input
                className="w-full flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                placeholder="Label (e.g. Melt Service COGS)"
                value={manualLabel}
                onChange={(e) => setManualLabel(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addManualCogs()}
              />
              <button
                onClick={addManualCogs}
                disabled={!manualId.trim()}
                className="inline-flex items-center justify-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                <Plus size={14} /> Add
              </button>
            </div>
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
            </CardContent>
          </Card>
        </>
      )}

      {/* ────────────────────── Connections ────────────────────── */}
      {activeTab === 'connections' && isAdmin && (
        <>
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex-1 min-w-[240px]">
                    <h2 className="section-title flex items-center gap-2">
                    <Mail size={16} /> Vendor Inbox
                  </h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    The address bills are emailed to, who gets notified, which senders are accepted,
                    who owns mail that matches nobody, and whether an approval is required before a
                    bill can be posted. Edited on the inbox itself, so you can see the queue it produces.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => navigate('/bills')}>
                  Open the Vendor Inbox →
                </Button>
              </div>
            </CardContent>
          </Card>

          {isSuperadmin && (
            <Card>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex-1 min-w-[240px]">
                  <h2 className="section-title flex items-center gap-2">
                      <CreditCard size={16} /> Card Connection Services
                    </h2>
                    <p className="text-xs text-muted-foreground mt-1">
                      Assign each company card&rsquo;s last-4 to its user and reconcile the QuickBooks
                      card feed with Brixpense records. Superadmin only.
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => navigate('/cards')}>
                    Open Card Connection Services →
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* One save bar, and it saves whichever tab you are looking at. The old
          page had two buttons at the bottom of one long scroll, far from the
          fields they applied to. */}
      {(activeTab === 'you' || (activeTab === 'org' && isAdmin)) && (
        // Sticky INSIDE the content column rather than fixed to the viewport:
        // the shell is a flex row with a sidebar that collapses, so a
        // full-width fixed bar would sit under it and misalign the moment
        // somebody collapses the nav. On mobile it clears the bottom tabbar.
        <div className="sticky bottom-4 max-md:bottom-[86px] z-20">
          <div className="flex items-center justify-end gap-3 rounded-xl border border-white/10 bg-background/90 backdrop-blur px-3 py-2.5 shadow-lg">
            {activeTab === 'you' && savedAt && <span className="text-xs text-emerald-400">Saved at {savedAt}</span>}
            {activeTab === 'org' && orgSavedAt && <span className="text-xs text-emerald-400">Saved at {orgSavedAt}</span>}
            {activeTab === 'you' ? (
              <Button onClick={save} disabled={loading || saving || !allAccounts}>
                <Save size={14} className="mr-1.5" />
                {saving ? 'Saving…' : 'Save my accounts'}
              </Button>
            ) : (
              <Button onClick={saveOrg} disabled={orgSaving}>
                <Save size={14} className="mr-1.5" />
                {orgSaving ? 'Saving…' : 'Save organization settings'}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
