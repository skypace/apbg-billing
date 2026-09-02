// Settings → Organization → People & approvals.
//
// The Brixpense roster: who may approve how much, who approves them, and who
// sees the company's payables. Deliberately separate from the gateway role —
// every staff login here is a gateway superadmin, so keying visibility off
// that showed everyone every vendor bill.
//
// AP admins only, both here and in the RLS on ops.expense_people.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Save, Trash2, ShieldCheck } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabase } from '@/lib/supabase';
import { useExpenseRole } from '@/lib/useExpenseRole';

type Job = 'driver' | 'office' | 'tech' | 'manager' | 'owner';

interface Person {
  email: string;
  full_name: string | null;
  job: Job;
  approval_limit: number | null;
  approver_email: string | null;
  ap_admin: boolean;
  active: boolean;
}

// Mirrors LIMITS_BY_JOB in netlify/functions/lib/expense-approval.mjs. Changing
// a default here changes what a NEW row starts at; it never rewrites a limit
// somebody set by hand.
const DEFAULT_LIMIT: Record<Job, number | null> = {
  driver: 500, office: 500, tech: 800, manager: 2500, owner: null,
};
const JOBS: { value: Job; label: string }[] = [
  { value: 'driver', label: 'Driver' },
  { value: 'office', label: 'Office' },
  { value: 'tech', label: 'Tech' },
  { value: 'manager', label: 'Manager' },
  { value: 'owner', label: 'Owner' },
];

const blank = (): Person => ({
  email: '', full_name: '', job: 'office', approval_limit: 500,
  approver_email: null, ap_admin: false, active: true,
});

export function PeopleApprovals() {
  // ⚠ Gated here, not at the mount site. The Organization tab is gated on the
  // GATEWAY role, which every staff login holds — so without this a manager
  // would get a one-row table they cannot write to (the RLS returns only their
  // own row and refuses the update), which reads as broken rather than as
  // "not yours".
  const role = useExpenseRole();
  const [rows, setRows] = useState<Person[]>([]);
  const [draft, setDraft] = useState<Person | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('expense_people')
      .select('email,full_name,job,approval_limit,approver_email,ap_admin,active')
      .order('ap_admin', { ascending: false })
      .order('email');
    if (error) setErr(error.message);
    else { setRows((data ?? []) as Person[]); setErr(null); }
    setLoading(false);
  }, []);

  useEffect(() => { if (role.apAdmin) void load(); }, [load, role.apAdmin]);

  const save = async (p: Person, isNew: boolean) => {
    const email = p.email.trim().toLowerCase();
    if (!email || !email.includes('@')) { setErr('That needs to be the email they sign in with.'); return; }
    // Mirrors the DB CHECK: only an owner may be unlimited, because a blank
    // limit on anyone else is a blank cheque rather than a tidy default.
    if (p.approval_limit === null && p.job !== 'owner') {
      setErr('Only an owner can have no limit. Give them a number, or set the job to Owner.'); return;
    }
    if (p.approver_email && p.approver_email.toLowerCase() === email) {
      setErr('Somebody cannot approve themselves — that is an escalation loop.'); return;
    }
    setBusy(email); setErr(null);
    const payload = {
      email,
      full_name: p.full_name?.trim() || null,
      job: p.job,
      approval_limit: p.approval_limit,
      approver_email: p.approver_email?.trim().toLowerCase() || null,
      ap_admin: p.ap_admin,
      active: p.active,
      updated_at: new Date().toISOString(),
    };
    const { error } = isNew
      ? await supabase.from('expense_people').insert(payload)
      : await supabase.from('expense_people').update(payload).eq('email', email);
    if (error) setErr(error.message);
    else {
      setSavedAt(new Date().toLocaleTimeString());
      if (isNew) setDraft(null);
      await load();
    }
    setBusy(null);
  };

  const patch = (email: string, next: Partial<Person>) =>
    setRows((rs) => rs.map((r) => (r.email === email ? { ...r, ...next } : r)));

  const onJobChange = (p: Person, job: Job, isDraft: boolean) => {
    // Moving someone between jobs re-points their limit at that job's default,
    // which is what anyone changing a job expects — but only when the current
    // value is still the OLD job's default. A hand-set number survives.
    const wasDefault = p.approval_limit === DEFAULT_LIMIT[p.job];
    const next = { job, approval_limit: wasDefault ? DEFAULT_LIMIT[job] : p.approval_limit };
    if (isDraft) setDraft((d) => (d ? { ...d, ...next } : d));
    else patch(p.email, next);
  };

  const RowEditor = ({ p, isDraft }: { p: Person; isDraft: boolean }) => (
    <div className="grid gap-2 md:grid-cols-[1.6fr_1fr_0.8fr_1.4fr_auto_auto] items-center py-2 border-b border-white/5 last:border-0">
      <Input
        placeholder="name@brixbev.com" value={p.email} disabled={!isDraft}
        onChange={(e) => (isDraft ? setDraft({ ...p, email: e.target.value }) : undefined)}
      />
      <select
        className="h-9 rounded-md bg-white/5 border border-white/10 px-2 text-sm"
        value={p.job}
        onChange={(e) => onJobChange(p, e.target.value as Job, isDraft)}
      >
        {JOBS.map((j) => <option key={j.value} value={j.value}>{j.label}</option>)}
      </select>
      <Input
        type="number" min={0} step={50}
        placeholder={p.job === 'owner' ? 'no limit' : '500'}
        value={p.approval_limit === null ? '' : String(p.approval_limit)}
        onChange={(e) => {
          const v = e.target.value === '' ? null : Number(e.target.value);
          if (isDraft) setDraft({ ...p, approval_limit: v }); else patch(p.email, { approval_limit: v });
        }}
      />
      <Input
        placeholder="approved by (email)" value={p.approver_email ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (isDraft) setDraft({ ...p, approver_email: v }); else patch(p.email, { approver_email: v });
        }}
      />
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap px-1">
        <input
          type="checkbox" checked={p.ap_admin}
          onChange={(e) => {
            const v = e.target.checked;
            if (isDraft) setDraft({ ...p, ap_admin: v }); else patch(p.email, { ap_admin: v });
          }}
        />
        Sees all bills
      </label>
      <div className="flex gap-1">
        <Button size="sm" variant={isDraft ? 'default' : 'outline'}
          onClick={() => void save(p, isDraft)} disabled={busy === p.email}>
          {busy === p.email ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        </Button>
        {isDraft && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );

  if (role.loading || !role.apAdmin) return null;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div>
          <h2 className="section-title flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> People &amp; approvals
          </h2>
          <p className="section-description">
            Who approves how much, who approves them, and who sees the company’s payables.
            Someone who isn’t listed here sees only their own expenses and approves nothing —
            so add a driver or tech when they get a login. Defaults: driver and office $500,
            tech $800, manager $2,500, owner unlimited.
          </p>
        </div>

        {err && <div className="text-sm text-red-300">{err}</div>}

        <div className="hidden md:grid gap-2 grid-cols-[1.6fr_1fr_0.8fr_1.4fr_auto_auto] text-[11px] uppercase tracking-wide text-muted-foreground">
          <span>Login</span><span>Job</span><span>Approves up to</span><span>Approved by</span><span /><span />
        </div>

        {loading ? (
          <div className="flex items-center py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading the roster…
          </div>
        ) : (
          <>
            {rows.map((p) => <RowEditor key={p.email} p={p} isDraft={false} />)}
            {draft && <RowEditor p={draft} isDraft />}
            {!draft && (
              <Button size="sm" variant="outline" onClick={() => setDraft(blank())}>
                <Plus className="h-4 w-4 mr-1.5" /> Add someone
              </Button>
            )}
          </>
        )}
        {savedAt && <div className="text-xs text-emerald-400">Saved at {savedAt}</div>}
      </CardContent>
    </Card>
  );
}
