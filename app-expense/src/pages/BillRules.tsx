import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAccessToken } from '@/lib/supabase';
import { useSession } from '@/lib/hooks';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select-field';
import {
  AlertTriangle, ArrowLeft, Archive, FlaskConical, Loader2, Plus, Repeat, Wand2,
} from 'lucide-react';
import { formatCurrency } from '@/lib/utils';

// Bill Rules — recognise a bill and fill the coding in automatically.
//
// A rule MATCHES on what we can see about an inbound bill (vendor, sender,
// text, amount) and SETS the fields somebody would otherwise retype every
// month. It never posts anything: auto-populate fills the form, a human still
// clicks Post to QuickBooks.
//
// The Test button is the important one. It replays a draft rule against the
// last 100 real expenses and shows exactly what it would have claimed and
// coded — so you can see a too-greedy rule BEFORE it starts claiming things.

interface Rule {
  id: string; name: string; active: boolean; priority: number;
  match_vendor: string | null; match_sender: string | null; match_text: string | null;
  match_min_amount: number | null; match_max_amount: number | null;
  set_department: string | null; set_entity: string | null;
  set_cogs_account_id: string | null; set_cogs_account_label: string | null;
  set_tag: string | null; set_job_number: string | null; set_customer_name: string | null;
  set_owner_email: string | null; set_memo: string | null;
  recurring: boolean; recurring_period: string | null;
  expected_amount: number | null; amount_tolerance_pct: number | null;
  match_count: number; last_matched_at: string | null; last_amount: number | null;
  notes: string | null;
}
type Draft = Partial<Rule>;

const ENTITY_OPTIONS = [
  { value: '', label: '—' },
  { value: 'brix', label: 'brix' },
  { value: 'freeflow', label: 'freeflow' },
  { value: 'shared', label: 'shared' },
];
const PERIOD_OPTIONS = [
  { value: '', label: '—' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annual', label: 'Annual' },
];

const EMPTY: Draft = {
  name: '', active: true, priority: 100, recurring: false, amount_tolerance_pct: 10,
};

async function api(body?: unknown) {
  const token = await getAccessToken();
  const res = await fetch('/expense/api/expense-rules', {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function describe(r: Rule | Draft): string {
  const when: string[] = [];
  if (r.match_vendor) when.push(`vendor contains “${r.match_vendor}”`);
  if (r.match_sender) when.push(`from ${r.match_sender}`);
  if (r.match_text) when.push(`text contains “${r.match_text}”`);
  if (r.match_min_amount != null || r.match_max_amount != null) {
    when.push(`amount ${r.match_min_amount ?? '0'}–${r.match_max_amount ?? '∞'}`);
  }
  const then: string[] = [];
  if (r.set_cogs_account_label) then.push(r.set_cogs_account_label);
  if (r.set_department) then.push(r.set_department);
  if (r.set_tag) then.push(`tag ${r.set_tag}`);
  if (r.set_job_number) then.push(`job ${r.set_job_number}`);
  if (r.set_entity) then.push(r.set_entity);
  if (r.set_owner_email) then.push(`→ ${r.set_owner_email}`);
  return `${when.join(' and ') || 'nothing yet'} → ${then.join(', ') || 'sets nothing yet'}`;
}

export default function BillRules() {
  const navigate = useNavigate();
  const { session } = useSession();
  const [rules, setRules] = useState<Rule[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [test, setTest] = useState<{ scanned: number; matched: number; sample: Array<{
    id: string; vendor: string | null; amount: number | null; date: string;
    why: string[]; would_set: Record<string, unknown>; recurring_note: string | null;
  }> } | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const d = await api();
      setRules(d.rules ?? []); setCanEdit(!!d.can_edit); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load rules.');
    } finally { setLoading(false); }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  };

  const set = (k: keyof Rule, v: unknown) => setDraft((d) => ({ ...(d ?? {}), [k]: v }));

  const save = () => run(async () => {
    await api({ action: 'save', ...draft });
    setDraft(null); setTest(null);
    await load();
  });

  const dryRun = () => run(async () => setTest(await api({ action: 'test', rule: draft })));

  const field = (label: string, k: keyof Rule, placeholder = '', type = 'text') => (
    <div>
      <Label>{label}</Label>
      <Input
        type={type} placeholder={placeholder}
        value={(draft?.[k] as string | number | null) ?? ''}
        onChange={(e) => set(k, type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
      />
    </div>
  );

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="page-title">Bill Rules</h1>
          <p className="page-description">
            Recognise a bill and fill in its coding automatically. Rules never post anything —
            a human still clicks Post to QuickBooks.
          </p>
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => { setDraft({ ...EMPTY }); setTest(null); }}>
            <Plus className="h-4 w-4 mr-1.5" /> New rule
          </Button>
        )}
      </div>

      {error && (
        <Card className="border-red-500/40">
          <CardContent className="p-3 text-sm text-red-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </CardContent>
        </Card>
      )}

      {draft && (
        <Card>
          <CardContent className="p-4 space-y-4">
            <div>
              <Label>Rule name</Label>
              <Input autoFocus placeholder="Pro Mechanical — monthly service"
                value={draft.name ?? ''} onChange={(e) => set('name', e.target.value)} />
            </div>

            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                When a bill matches — all of these
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {field('Vendor contains', 'match_vendor', 'pro mechanical')}
                {field('Sender is', 'match_sender', 'ar@vendor.com or vendor.com')}
                {field('Text contains', 'match_text', 'monthly service')}
                <div className="grid grid-cols-2 gap-2">
                  {field('Min $', 'match_min_amount', '0', 'number')}
                  {field('Max $', 'match_max_amount', '', 'number')}
                </div>
              </div>
            </div>

            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                Fill in — blanks only; what we read off the document always wins
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {field('GL account label', 'set_cogs_account_label', 'Service Expense')}
                {field('GL account id', 'set_cogs_account_id', '101')}
                {field('Department', 'set_department', 'service')}
                <div>
                  <Label>Entity</Label>
                  <SelectField
                    value={draft.set_entity ?? ''}
                    onChange={(e) => set('set_entity', e.target.value || null)}
                    options={ENTITY_OPTIONS}
                  />
                </div>
                {field('Tag', 'set_tag', 'Installations')}
                {field('Job #', 'set_job_number')}
                {field('Route to', 'set_owner_email', 'anthonyv@brixbev.com')}
                {field('Priority', 'priority', '100', 'number')}
              </div>
            </div>

            <div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!draft.recurring}
                  onChange={(e) => set('recurring', e.target.checked)} />
                <Repeat className="h-4 w-4" /> This is a recurring bill
              </label>
              {draft.recurring && (
                <div className="grid gap-3 sm:grid-cols-3 mt-3">
                  <div>
                    <Label>How often</Label>
                    <SelectField
                      value={draft.recurring_period ?? ''}
                      onChange={(e) => set('recurring_period', e.target.value || null)}
                      options={PERIOD_OPTIONS}
                    />
                  </div>
                  {field('Usual amount', 'expected_amount', '250.00', 'number')}
                  {field('Flag if off by %', 'amount_tolerance_pct', '10', 'number')}
                </div>
              )}
              {draft.recurring && (
                <p className="text-[11px] text-muted-foreground mt-2">
                  A bill outside the tolerance is flagged for review — it never blocks anything.
                  This is what catches a monthly service that quietly triples.
                </p>
              )}
            </div>

            <div className="text-[13px] text-muted-foreground bg-white/5 rounded-lg px-3 py-2">
              {describe(draft)}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={dryRun} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <FlaskConical className="h-4 w-4 mr-1.5" />}
                Test against recent bills
              </Button>
              <Button size="sm" onClick={save} disabled={busy}>Save rule</Button>
              <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setTest(null); }}>Cancel</Button>
            </div>

            {test && (
              <div className={`rounded-lg p-3 text-[13px] ${test.matched === 0 ? 'bg-white/5' : 'bg-sky-500/10'}`}>
                <div className="font-medium mb-1">
                  Would have matched {test.matched} of the last {test.scanned} expenses.
                </div>
                {test.matched > test.scanned / 2 && (
                  <div className="text-amber-300 mb-2">
                    That is most of them — the conditions are probably too broad.
                  </div>
                )}
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {test.sample.map((m) => (
                    <div key={m.id} className="flex justify-between gap-3">
                      <span className="truncate text-muted-foreground">
                        {m.date} · {m.vendor || 'no vendor'}
                        {m.recurring_note?.startsWith('⚠') ? ' ⚠' : ''}
                      </span>
                      <span className="tabular-nums flex-shrink-0">{formatCurrency(m.amount ?? 0)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="feedback-state">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
        </div>
      ) : rules.length === 0 && !draft ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">
          <Wand2 className="h-8 w-8 mx-auto mb-3 opacity-40" />
          No rules yet. A rule saves retyping the same GL account and job every time a
          familiar vendor sends a bill.
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <Card key={r.id}>
              <CardContent className="p-4 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold truncate">{r.name}</span>
                    {!r.active && <Badge variant="secondary">Off</Badge>}
                    {r.recurring && <Badge variant="info">Recurring{r.recurring_period ? ` · ${r.recurring_period}` : ''}</Badge>}
                    <span className="text-[11px] text-muted-foreground">priority {r.priority}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{describe(r)}</div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    Matched {r.match_count} time{r.match_count === 1 ? '' : 's'}
                    {r.last_matched_at ? ` · last ${r.last_matched_at.slice(0, 10)}` : ''}
                    {r.last_amount != null ? ` at ${formatCurrency(Number(r.last_amount))}` : ''}
                    {r.recurring && r.expected_amount != null
                      ? ` · usually ${formatCurrency(Number(r.expected_amount))}` : ''}
                  </div>
                </div>
                {canEdit && (
                  <div className="flex gap-1 flex-shrink-0">
                    <Button size="sm" variant="outline" onClick={() => { setDraft(r); setTest(null); }}>Edit</Button>
                    <Button
                      size="icon" variant="ghost" title="Retire this rule"
                      onClick={() => {
                        if (!window.confirm(`Retire "${r.name}"? Bills it already coded keep their coding.`)) return;
                        void run(async () => { await api({ action: 'archive', id: r.id }); await load(); });
                      }}
                    >
                      <Archive className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
