import { useEffect, useState } from 'react';
import { sbDelete, sbInsert } from '../lib/rpc';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../lib/styles';
import { fm } from '../lib/formatters';
import { SalesPlan, fetchPlans } from '../lib/plans';
import { PlanEditor } from './plans/PlanEditor';

export function PlansPage() {
  const [plans, setPlans] = useState<SalesPlan[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
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
    if (!newPlan.name.trim()) return alert('Name required');
    sbInsert<Partial<SalesPlan>>('sales_plans', {
      name: newPlan.name.trim(),
      fiscal_year: Number(newPlan.fiscal_year),
      scenario: newPlan.scenario,
      status: 'active',
    })
      .then(() => {
        setCreating(false);
        setNewPlan({ name: '', fiscal_year: new Date().getFullYear() + 1, scenario: 'plan' });
        load();
      })
      .catch((e) => alert('Failed: ' + e.message));
  }

  function deletePlan(id: string, name: string) {
    if (!confirm(`Delete plan "${name}"? Lines will be deleted too.`)) return;
    sbDelete('sales_plan_lines', 'plan_id=eq.' + id).then(() =>
      sbDelete('sales_plans', 'id=eq.' + id).then(load),
    );
  }

  if (!plans) return <div className="ld">Loading plans…</div>;

  const active = activeId ? plans.find((p) => p.id === activeId) : null;
  if (active) {
    return <PlanEditor plan={active} onBack={() => { setActiveId(null); load(); }} />;
  }

  return (
    <div>
      <div className="pt">Plans <span className="bg bg-l">SALES BUDGETING</span></div>

      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 10,
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
            </select>
            <button onClick={createPlan} style={btnPrimary()}>CREATE</button>
            <button onClick={() => setCreating(false)} style={btnSecondary()}>CANCEL</button>
          </>
        ) : (
          <button onClick={() => setCreating(true)} style={btnPrimary()}>+ NEW PLAN</button>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--mt)' }}>{plans.length} plans</span>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        {plans.length === 0 ? (
          <div className="ld">No plans yet. Click + NEW PLAN to start.</div>
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
                  <td style={{ textAlign: 'right' }}>
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

// Re-export for convenient consumer imports without a dedicated index file.
export { fm };
