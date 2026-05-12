import { useEffect, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { sbDelete, sbInsert, sbrpc } from '../lib/rpc';
import { SB_KEY, SB_URL, _sbToken } from '../lib/supabase';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../lib/styles';
import { fm } from '../lib/formatters';
import { SalesPlan, fetchPlans } from '../lib/plans';
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

export function PlansPage() {
  const toast = useToast();
  const [plans, setPlans] = useState<SalesPlan[] | null>(null);
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
      <div className="cd" style={{ padding: 0 }}>
        <TableSkeleton rows={5} cols={5} />
      </div>
    </div>
  );

  const active = activeId ? plans.find((p) => p.id === activeId) : null;
  if (active) {
    return <PlanEditor plan={active} onBack={() => { setActiveId(null); load(); }} />;
  }

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Sales budgeting · scenarios</div>
          <h1 className="hero-title">Plans</h1>
          <div className="hero-meta">Plan vs actual · forecast · stretch · conservative · QBO budget</div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          {plans.length} plan{plans.length === 1 ? '' : 's'}
        </div>
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
            <button onClick={() => setCreating(true)} style={btnPrimary()}>+ NEW PLAN</button>
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

      <div className="cd" style={{ padding: 0 }}>
        {plans.length === 0 ? (
          <div className="ld">No plans yet. Click + NEW PLAN to start, or Pull from QBO Budget to import.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>FY</th>
                <th>Scenario</th>
                <th>Status</th>
                <th>Updated</th>
                <th style={{ textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} onClick={() => setActiveId(p.id)} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
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
                  <td style={{ fontSize: 11, color: 'var(--mt)' }}>
                    {p.updated_at ? new Date(p.updated_at).toLocaleDateString() : '—'}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
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
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export { fm };
