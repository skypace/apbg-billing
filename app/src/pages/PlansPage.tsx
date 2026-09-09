import { useEffect, useState } from 'react';
import { PrintableTable } from '../components/PrintableTable';
import { ArrowRight, Copy, Download, Plus } from 'lucide-react';
import { sbDelete, sbInsert, sbrpc } from '../lib/rpc';
import { SB_KEY, SB_URL, _sbToken } from '../lib/supabase';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../lib/styles';
import { fm, fp } from '../lib/formatters';
import { SalesPlan, fetchPlanForecast, fetchPlans, type PlanForecastRow } from '../lib/plans';
import { PlanEditor } from './plans/PlanEditor';
import { useToast } from '../lib/toast';
import { TableSkeleton } from '../components/Skeletons';

async function callImportQboBudget(body: Record<string, unknown>) {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/functions/v1/import-qbo-budget', {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok && !j) throw new Error('HTTP ' + res.status);
  return j;
}

interface PlanHomeSummary {
  planRevenue: number;
  actualYtd: number;
  projectedFy: number | null;
  projectedVsPlanPct: number | null;
  lineCount: number;
  atRiskCount: number;
  error?: string;
}

function summarizeForecast(rows: PlanForecastRow[]): PlanHomeSummary {
  const planRevenue = rows.reduce((s, r) => s + Number(r.full_year_plan || 0), 0);
  const actualYtd = rows.reduce((s, r) => s + Number(r.ytd_actual || 0), 0);
  const projectedRows = rows.filter((r) => r.projected_full_year != null);
  const projectedFy = projectedRows.length
    ? projectedRows.reduce((s, r) => s + Number(r.projected_full_year || 0), 0)
    : null;
  const projectedVsPlanPct = projectedFy != null && planRevenue > 0
    ? (projectedFy - planRevenue) / planRevenue
    : null;
  const atRiskCount = rows.filter((r) => r.status === 'behind' || r.status === 'critical').length;
  return { planRevenue, actualYtd, projectedFy, projectedVsPlanPct, lineCount: rows.length, atRiskCount };
}

function deltaLabel(v: number | null | undefined) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  return (Number(v) > 0 ? '+' : '') + fp(v);
}

function deltaColor(v: number | null | undefined) {
  if (v == null || !Number.isFinite(Number(v))) return 'var(--mt)';
  if (Number(v) >= 0.05) return 'var(--gn)';
  if (Number(v) <= -0.1) return 'var(--rd)';
  if (Number(v) < 0) return 'var(--am)';
  return 'var(--tx)';
}

function readoutLabel(summary: PlanHomeSummary | null | undefined) {
  if (summary == null) return 'checking';
  if (summary.error) return 'check failed';
  if (summary.atRiskCount > 0) return summary.atRiskCount + ' risk' + (summary.atRiskCount === 1 ? '' : 's');
  if (summary.projectedVsPlanPct == null) return summary.lineCount > 0 ? 'no pace' : 'empty';
  if (summary.projectedVsPlanPct >= 0.05) return 'ahead';
  if (summary.projectedVsPlanPct <= -0.1) return 'behind';
  return 'on track';
}

function readoutColor(summary: PlanHomeSummary | null | undefined) {
  if (summary == null) return 'var(--mt)';
  if (summary.error) return 'var(--am)';
  if (summary.atRiskCount > 0) return 'var(--am)';
  return deltaColor(summary.projectedVsPlanPct);
}

export function PlansPage() {
  const toast = useToast();
  const [plans, setPlans] = useState<SalesPlan[] | null>(null);
  const [summaries, setSummaries] = useState<Record<string, PlanHomeSummary | null>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [newPlan, setNewPlan] = useState({
    name: '',
    fiscal_year: new Date().getFullYear() + 1,
    scenario: 'plan',
  });

  function load() {
    fetchPlans()
      .then(setPlans)
      .catch(() => setPlans([]));
  }
  useEffect(load, []);

  useEffect(() => {
    if (!plans) return;
    let cancelled = false;
    setSummaries((cur) => {
      const next: Record<string, PlanHomeSummary | null> = {};
      for (const plan of plans) next[plan.id] = cur[plan.id] ?? null;
      return next;
    });
    Promise.all(plans.map((plan) =>
      fetchPlanForecast(plan.id)
        .then((rows) => [plan.id, summarizeForecast(rows)] as const)
        .catch((err) => [plan.id, {
          planRevenue: 0,
          actualYtd: 0,
          projectedFy: null,
          projectedVsPlanPct: null,
          lineCount: 0,
          atRiskCount: 0,
          error: err instanceof Error ? err.message : 'Forecast check failed',
        }] as const),
    )).then((entries) => {
      if (cancelled) return;
      setSummaries(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [plans]);

  function createPlan() {
    if (!newPlan.name.trim()) {
      toast.warn('Name required');
      return;
    }
    sbInsert<Partial<SalesPlan>>('sales_plans', {
      name: newPlan.name.trim(),
      fiscal_year: Number(newPlan.fiscal_year),
      scenario: newPlan.scenario,
      status: 'active',
    })
      .then(() => {
        toast.success('Created plan ' + newPlan.name.trim());
        setCreating(false);
        setNewPlan({ name: '', fiscal_year: new Date().getFullYear() + 1, scenario: 'plan' });
        load();
      })
      .catch((e) => toast.error('Failed: ' + e.message));
  }

  function deletePlan(id: string, name: string) {
    if (!confirm(`Delete plan "${name}"? Lines will be deleted too.`)) return;
    sbDelete('sales_plan_lines', 'plan_id=eq.' + id).then(() =>
      sbDelete('sales_plans', 'id=eq.' + id).then(() => {
        toast.success('Deleted ' + name);
        load();
      }),
    );
  }

  function duplicatePlan(source: SalesPlan) {
    const newName = prompt('New plan name:', source.name + ' (copy)');
    if (!newName || !newName.trim()) return;
    const fyDefault = String((source.fiscal_year ?? new Date().getFullYear()) + 1);
    const fyStr = prompt('Fiscal year for the copy:', fyDefault);
    if (!fyStr) return;
    const fy = parseInt(fyStr, 10);
    if (!Number.isFinite(fy)) { toast.warn('Invalid fiscal year'); return; }

    sbrpc<string>('fn_duplicate_sales_plan', {
      p_source_plan_id:  source.id,
      p_new_name:        newName.trim(),
      p_new_fiscal_year: fy,
      p_new_scenario:    source.scenario,
    })
      .then(() => {
        toast.success('Duplicated ' + source.name + ' → ' + newName.trim());
        load();
      })
      .catch((e: unknown) => toast.error('Duplicate failed: ' + (e as Error).message));
  }

  async function pullQboBudget() {
    const fyStr = prompt('Fiscal year to pull from QuickBooks:', String(new Date().getFullYear()));
    if (!fyStr) return;
    const fy = parseInt(fyStr, 10);
    if (!Number.isFinite(fy)) { toast.warn('Invalid fiscal year'); return; }

    setImporting(true);
    try {
      // 1. Dry-run: see what QBO has for that year.
      const dry = await callImportQboBudget({ fiscal_year: fy, dry_run: true });
      if (!dry?.ok) {
        if (dry?.all_budgets_found) {
          const list = (dry.all_budgets_found as Array<{ name: string; start: string }>)
            .map((b) => '• ' + b.name + ' (' + (b.start || '?') + ')').join('\n');
          alert('No QBO budget for FY ' + fy + '.\n\nBudgets found in QBO:\n' + list);
        } else {
          toast.error(dry?.error || 'Dry-run failed');
        }
        return;
      }
      const lineCount = dry.line_count ?? 0;
      const grandTotal = dry.grand_total ?? 0;
      const budgetName = dry?.budget?.name ?? '(unnamed)';
      const newPlanName = dry?.new_plan_name ?? ('QBO Budget FY' + fy);

      const ok = confirm(
        'Import QBO budget "' + budgetName + '" (FY' + fy + ')?\n\n'
        + lineCount + ' account line(s) · $' + Math.round(grandTotal).toLocaleString() + ' annual total\n\n'
        + 'Creates a new plan named "' + newPlanName + '" (scenario: budget).\n'
        + 'Existing plans are not modified.',
      );
      if (!ok) return;

      // 2. Commit.
      const result = await callImportQboBudget({ fiscal_year: fy, dry_run: false });
      if (!result?.ok) {
        toast.error('Import failed: ' + (result?.error || 'unknown'));
        return;
      }
      toast.success('Imported ' + (result.lines_imported ?? 0) + ' lines from QBO Budget → ' + result.plan_name);
      load();
    } catch (e) {
      toast.error('Pull failed: ' + (e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  if (!plans) return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Sales budgeting · scenarios</div>
          <h1 className="hero-title">Plans</h1>
        </div>
      </div>
      <div className="cd" style={{ padding: 0, overflowX: 'auto' }}>
        <TableSkeleton rows={5} cols={5} />
      </div>
    </div>
  );

  const active = activeId ? plans.find((p) => p.id === activeId) : null;
  if (active) {
    return <PlanEditor plan={active} onBack={() => { setActiveId(null); load(); }} />;
  }

  const latestFiscalYear = plans.reduce<number | null>((max, plan) => (
    max == null || Number(plan.fiscal_year) > max ? Number(plan.fiscal_year) : max
  ), null);
  const focusPlans = latestFiscalYear == null ? [] : plans.filter((p) => Number(p.fiscal_year) === latestFiscalYear);
  const activePlanCount = plans.filter((p) => p.status === 'active').length;
  const sortedPlans = [...plans].sort((a, b) =>
    Number(b.fiscal_year) - Number(a.fiscal_year)
    || String(a.scenario || '').localeCompare(String(b.scenario || ''))
    || String(a.name || '').localeCompare(String(b.name || '')),
  );
  const homeSummary = (() => {
    const ids = focusPlans.map((p) => p.id);
    const loaded = ids.map((id) => summaries[id]).filter((s): s is PlanHomeSummary => !!s && !s.error);
    const pending = ids.some((id) => summaries[id] == null);
    const planRevenue = loaded.reduce((s, r) => s + r.planRevenue, 0);
    const actualYtd = loaded.reduce((s, r) => s + r.actualYtd, 0);
    const projectedLoaded = loaded.filter((r) => r.projectedFy != null);
    const projectedFy = projectedLoaded.length
      ? projectedLoaded.reduce((s, r) => s + Number(r.projectedFy || 0), 0)
      : null;
    const projectedVsPlanPct = projectedFy != null && planRevenue > 0
      ? (projectedFy - planRevenue) / planRevenue
      : null;
    const atRiskCount = loaded.reduce((s, r) => s + r.atRiskCount, 0);
    return { pending, planRevenue, actualYtd, projectedFy, projectedVsPlanPct, atRiskCount };
  })();

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Sales budgeting · scenarios</div>
          <h1 className="hero-title">Plans</h1>
          <div className="hero-meta">
            {latestFiscalYear ? 'FY' + latestFiscalYear + ' focus' : 'No focus year'} · {activePlanCount} active
          </div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          {plans.length} plan{plans.length === 1 ? '' : 's'}
        </div>
      </div>

      <div
        className="cd"
        style={{
          padding: 0,
          marginBottom: 14,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          overflow: 'hidden',
        }}
      >
        <PlanHomeMetric
          label="Focus year"
          value={latestFiscalYear ? 'FY' + latestFiscalYear : '-'}
          detail={focusPlans.length + ' plan' + (focusPlans.length === 1 ? '' : 's')}
        />
        <PlanHomeMetric
          label="Plan revenue"
          value={homeSummary.pending ? 'Checking' : fm(homeSummary.planRevenue)}
        />
        <PlanHomeMetric
          label="Actual YTD"
          value={homeSummary.pending ? 'Checking' : fm(homeSummary.actualYtd)}
        />
        <PlanHomeMetric
          label="FY pace"
          value={homeSummary.pending ? 'Checking' : homeSummary.projectedFy == null ? '-' : fm(homeSummary.projectedFy)}
          detail={homeSummary.pending ? undefined : deltaLabel(homeSummary.projectedVsPlanPct)}
          tone={homeSummary.pending ? 'muted' : homeSummary.projectedVsPlanPct == null ? 'muted' : homeSummary.projectedVsPlanPct >= 0 ? 'good' : 'warn'}
        />
        <PlanHomeMetric
          label="Needs review"
          value={homeSummary.pending ? 'Checking' : String(homeSummary.atRiskCount)}
          tone={homeSummary.atRiskCount > 0 ? 'warn' : 'good'}
        />
      </div>

      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 14,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 11,
        }}
      >
        {creating ? (
          <>
            <input
              type="text"
              placeholder="plan name"
              value={newPlan.name}
              onChange={(e) => setNewPlan({ ...newPlan, name: e.target.value })}
              style={{ ...inp(), width: 220 }}
            />
            <input
              type="number"
              value={newPlan.fiscal_year}
              onChange={(e) => setNewPlan({ ...newPlan, fiscal_year: Number(e.target.value) })}
              style={{ ...inp(), width: 80 }}
            />
            <select
              value={newPlan.scenario}
              onChange={(e) => setNewPlan({ ...newPlan, scenario: e.target.value })}
              style={inp()}
            >
              <option value="plan">plan</option>
              <option value="forecast">forecast</option>
              <option value="stretch">stretch</option>
              <option value="conservative">conservative</option>
              <option value="budget">budget</option>
            </select>
            <button onClick={createPlan} style={btnPrimary()}>CREATE</button>
            <button onClick={() => setCreating(false)} style={btnSecondary()}>CANCEL</button>
          </>
        ) : (
          <>
            <button
              onClick={() => setCreating(true)}
              style={{ ...btnPrimary(), display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Plus size={12} strokeWidth={2.4} aria-hidden="true" />
              <span>New plan</span>
            </button>
            <button
              onClick={pullQboBudget}
              disabled={importing}
              className="tb-btn"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              title="Pull an existing budget from QuickBooks Online into a new plan (dry-run preview first)"
            >
              <Download size={12} strokeWidth={2.4} aria-hidden="true" />
              <span>{importing ? 'Pulling…' : 'Pull from QBO Budget'}</span>
            </button>
          </>
        )}
      </div>

      <div className="cd" style={{ padding: 0, overflowX: 'auto' }}>
        {plans.length === 0 ? (
          <div className="ld">No plans yet.</div>
        ) : (
          <PrintableTable>
            <table style={{ minWidth: 1060 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>FY</th>
                  <th>Scenario</th>
                  <th>Status</th>
                  <th>Readout</th>
                  <th style={{ textAlign: 'right' }}>Plan</th>
                  <th style={{ textAlign: 'right' }}>Actual YTD</th>
                  <th style={{ textAlign: 'right' }}>FY Pace</th>
                  <th style={{ textAlign: 'right' }}>Delta</th>
                  <th>Updated</th>
                  <th style={{ textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {sortedPlans.map((p) => {
                  const summary = summaries[p.id];
                  const color = readoutColor(summary);
                  return (
                    <tr key={p.id} onClick={() => setActiveId(p.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div style={{ fontWeight: 700 }}>{p.name}</div>
                        <div style={{ color: 'var(--mt)', fontSize: 10 }}>
                          {summary == null ? 'checking lines' : summary.error ? summary.error : summary.lineCount + ' tracked line' + (summary.lineCount === 1 ? '' : 's')}
                        </div>
                      </td>
                      <td className="mn">{p.fiscal_year}</td>
                      <td style={{ fontSize: 11, color: 'var(--mt)' }}>{p.scenario}</td>
                      <td>
                        <span
                          className="bg"
                          style={{
                            color: p.status === 'active' ? 'var(--gn)' : 'var(--mt)',
                            borderColor: p.status === 'active' ? 'var(--gn)' : 'var(--bd)',
                          }}
                        >
                          {p.status}
                        </span>
                      </td>
                      <td>
                        <span
                          className="bg"
                          style={{
                            color,
                            borderColor: color,
                          }}
                        >
                          {readoutLabel(summary)}
                        </span>
                      </td>
                      <td className="mn" style={{ textAlign: 'right' }}>
                        {summary == null ? '...' : fm(summary.planRevenue)}
                      </td>
                      <td className="mn" style={{ textAlign: 'right' }}>
                        {summary == null ? '...' : fm(summary.actualYtd)}
                      </td>
                      <td className="mn" style={{ textAlign: 'right' }}>
                        {summary == null ? '...' : summary.projectedFy == null ? '-' : fm(summary.projectedFy)}
                      </td>
                      <td className="mn" style={{ textAlign: 'right', color: deltaColor(summary?.projectedVsPlanPct) }}>
                        {summary == null ? '...' : deltaLabel(summary.projectedVsPlanPct)}
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--mt)' }}>
                        {p.updated_at ? new Date(p.updated_at).toLocaleDateString() : '-'}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); setActiveId(p.id); }}
                          className="tb-btn"
                          style={{ marginRight: 4, padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          <ArrowRight size={11} strokeWidth={2.2} aria-hidden="true" />
                          <span style={{ fontSize: 10 }}>Open</span>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); duplicatePlan(p); }}
                          className="tb-btn"
                          style={{ marginRight: 4, padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          title="Duplicate this plan into a new fiscal year (header + all lines)"
                        >
                          <Copy size={11} strokeWidth={2.2} aria-hidden="true" />
                          <span style={{ fontSize: 10 }}>Duplicate</span>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); deletePlan(p.id, p.name); }}
                          style={btnDanger()}
                        >
                          x
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </PrintableTable>
        )}
      </div>
    </div>
  );
}

function PlanHomeMetric({
  label,
  value,
  detail,
  tone = 'muted',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'muted' | 'good' | 'warn' | 'bad';
}) {
  const color = tone === 'good'
    ? 'var(--gn)'
    : tone === 'warn'
      ? 'var(--am)'
      : tone === 'bad'
        ? 'var(--rd)'
        : 'var(--tx)';
  return (
    <div style={{ padding: '10px 12px', borderRight: '1px solid var(--bd)', minWidth: 0 }}>
      <div style={{ color: 'var(--mt)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0 }}>
        {label}
      </div>
      <div className="mn" style={{ marginTop: 4, color, fontSize: 16, fontWeight: 800, whiteSpace: 'nowrap' }}>
        {value}
        {detail && <span style={{ marginLeft: 6, color: 'var(--mt)', fontSize: 10, fontWeight: 600 }}>{detail}</span>}
      </div>
    </div>
  );
}

export { fm };
