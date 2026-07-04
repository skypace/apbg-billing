import { useEffect, useMemo, useState } from 'react';
import { sbDelete, sbInsert, sbUpdate } from '../../lib/rpc';
import { SB_KEY, SB_URL, _sbToken } from '../../lib/supabase';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { downloadCsv, toCsv } from '../../lib/csv';
import { fm } from '../../lib/formatters';
import {
  MONTHS_SHORT,
  PlanLineSection,
  QboItemOption,
  SalesPlan,
  SalesPlanLine,
  fetchItemOptions,
  fetchPlanActualsByItem,
  fetchPlanLineSections,
  fetchPlanLines,
  fetchPlans,
} from '../../lib/plans';
import { Dim, fetchPivot, fetchQboSyncFreshness, type QboSyncFreshness } from '../../lib/sales';
import { PlanVsActuals } from './PlanVsActuals';
import { PlanForecast } from './PlanForecast';
import { PlanPlView } from './PlanPlView';
import { PlanBuildDialog } from './PlanBuildDialog';
import { PlanLinesGrouped } from './PlanLinesGrouped';

type Mode = 'pl' | 'lines' | 'vs_actuals' | 'forecast';
type ViewMode = 'revenue' | 'qty' | 'price' | 'cost';
type ActualsByItem = Record<string, { item_name?: string; amounts: number[]; total: number }>;
type CompareByItem = Record<string, { item_name?: string | null; total: number }>;

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: 'revenue', label: 'Revenue ($)' },
  { id: 'qty',     label: 'Qty' },
  { id: 'price',   label: 'Price ($/unit)' },
  { id: 'cost',    label: 'Cost ($/unit)' },
];

const ZEROS = (): number[] => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const round2 = (n: number) => Math.round(n * 100) / 100;

interface Props {
  plan: SalesPlan;
  onBack: () => void;
}

export function PlanEditor({ plan, onBack }: Props) {
  const [lines, setLines] = useState<SalesPlanLine[] | null>(null);
  const [linesSections, setLinesSections] = useState<PlanLineSection[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [itemOpts, setItemOpts] = useState<QboItemOption[]>([]);
  const [actualsByItem, setActualsByItem] = useState<ActualsByItem | null>(null);
  const [mode, setMode] = useState<Mode>('lines');
  const [viewMode, setViewMode] = useState<ViewMode>('revenue');
  const [buildOpen, setBuildOpen] = useState(false);
  const [comparePlans, setComparePlans] = useState<SalesPlan[]>([]);
  const [comparePlanId, setComparePlanId] = useState('');
  const [compareLines, setCompareLines] = useState<SalesPlanLine[] | null>(null);
  const [qboFreshness, setQboFreshness] = useState<QboSyncFreshness | null>(null);

  function load() {
    Promise.all([
      fetchPlanLines(plan.id),
      fetchPlanLineSections(plan.id),
    ])
      .then(([ls, ss]) => { setLines(ls); setLinesSections(ss); })
      .catch(() => { setLines([]); setLinesSections([]); });
  }
  useEffect(load, [plan.id]);

  useEffect(() => {
    fetchItemOptions().then(setItemOpts).catch(() => setItemOpts([]));
  }, []);

  useEffect(() => {
    fetchPlans()
      .then((plans) => {
        setComparePlans(plans.filter((p) => p.id !== plan.id && p.fiscal_year === plan.fiscal_year));
      })
      .catch(() => setComparePlans([]));
  }, [plan.id, plan.fiscal_year]);

  useEffect(() => {
    if (!comparePlanId) {
      setCompareLines(null);
      return;
    }
    fetchPlanLines(comparePlanId).then(setCompareLines).catch(() => setCompareLines([]));
  }, [comparePlanId]);

  useEffect(() => {
    fetchQboSyncFreshness().then(setQboFreshness).catch(() => setQboFreshness(null));
  }, []);

  // Pull actuals once for the plan year and key them by stable QBO item id.
  useEffect(() => {
    setActualsByItem(null);
    fetchPlanActualsByItem(plan.id)
      .then((rows) => {
        const byItem: ActualsByItem = {};
        for (const r of rows) {
          byItem[r.qbo_item_id] = {
            item_name: r.item_name,
            amounts: [
              Number(r.m1 || 0), Number(r.m2 || 0), Number(r.m3 || 0), Number(r.m4 || 0),
              Number(r.m5 || 0), Number(r.m6 || 0), Number(r.m7 || 0), Number(r.m8 || 0),
              Number(r.m9 || 0), Number(r.m10 || 0), Number(r.m11 || 0), Number(r.m12 || 0),
            ],
            total: Number(r.total || 0),
          };
        }
        setActualsByItem(byItem);
      })
      .catch(() => setActualsByItem({}));
  }, [plan.id]);

  function addItemLine(it: QboItemOption) {
    sbInsert<Partial<SalesPlanLine>>('sales_plan_lines', {
      plan_id: plan.id,
      line_type: 'item',
      qbo_item_id: it.qbo_item_id,
      item_name: it.name || it.fully_qualified_name,
      qbo_account_id: it.income_account_ref_id,
      account_name: it.income_account_name,
      amounts: ZEROS(),
      qty: ZEROS(),
      unit_price: ZEROS(),
      unit_cost: ZEROS(),
    } as Partial<SalesPlanLine>).then(() => {
      setPickerOpen(false);
      load();
    });
  }

  function arrayFor(line: SalesPlanLine, mode: ViewMode): number[] {
    switch (mode) {
      case 'revenue': return line.amounts    ?? ZEROS();
      case 'qty':     return line.qty        ?? ZEROS();
      case 'price':   return line.unit_price ?? ZEROS();
      case 'cost':    return line.unit_cost  ?? ZEROS();
    }
  }

  function setCell(line: SalesPlanLine, monthIdx: number, value: string) {
    const v = Number(value) || 0;
    const patch: Partial<SalesPlanLine> = { updated_at: new Date().toISOString() };
    if (viewMode === 'revenue') {
      const amounts = (line.amounts ?? ZEROS()).slice();
      amounts[monthIdx] = round2(v);
      patch.amounts = amounts;
    } else if (viewMode === 'qty') {
      const qty = (line.qty ?? ZEROS()).slice();
      qty[monthIdx] = round2(v);
      const price = line.unit_price ?? ZEROS();
      const amounts = (line.amounts ?? ZEROS()).slice();
      amounts[monthIdx] = round2(v * Number(price[monthIdx] || 0));
      patch.qty = qty;
      patch.amounts = amounts;
    } else if (viewMode === 'price') {
      const price = (line.unit_price ?? ZEROS()).slice();
      price[monthIdx] = round2(v);
      const qty = line.qty ?? ZEROS();
      const amounts = (line.amounts ?? ZEROS()).slice();
      amounts[monthIdx] = round2(Number(qty[monthIdx] || 0) * v);
      patch.unit_price = price;
      patch.amounts = amounts;
    } else {
      const cost = (line.unit_cost ?? ZEROS()).slice();
      cost[monthIdx] = round2(v);
      patch.unit_cost = cost;
    }
    sbUpdate<SalesPlanLine>('sales_plan_lines', 'id=eq.' + line.id, patch).then(load);
  }

  function totalFor(line: SalesPlanLine, mode: ViewMode): number {
    if (mode === 'revenue') return (line.amounts ?? []).reduce((s, v) => s + Number(v || 0), 0);
    if (mode === 'qty')     return (line.qty     ?? []).reduce((s, v) => s + Number(v || 0), 0);
    if (mode === 'price') {
      const qSum = (line.qty     ?? []).reduce((s, v) => s + Number(v || 0), 0);
      const aSum = (line.amounts ?? []).reduce((s, v) => s + Number(v || 0), 0);
      return qSum > 0 ? aSum / qSum : 0;
    }
    // cost: extended annual cost = sum(qty[i] * unit_cost[i])
    const q = line.qty       ?? ZEROS();
    const c = line.unit_cost ?? ZEROS();
    let t = 0;
    for (let i = 0; i < 12; i++) t += Number(q[i] || 0) * Number(c[i] || 0);
    return t;
  }

  function deleteLine(id: string) {
    sbDelete('sales_plan_lines', 'id=eq.' + id).then(load);
  }

  function fillFlat(line: SalesPlanLine, total: string | number) {
    const per = Math.round(((Number(total) || 0) / 12) * 100) / 100;
    sbUpdate<SalesPlanLine>('sales_plan_lines', 'id=eq.' + line.id, {
      amounts: Array(12).fill(per),
    } as Partial<SalesPlanLine>).then(load);
  }

  async function copyFromActuals() {
    const yr = plan.fiscal_year - 1;
    if (!confirm(`Replace this plan's line amounts with actuals from ${yr}? Existing values overwritten.`)) return;
    const rows = await fetchPivot('item' as Dim, {
      start: yr + '-01-01',
      end: yr + '-12-31',
    }, 1000);
    const byName = new Map<string, number>();
    for (const r of rows) byName.set(r.dim_label, Number(r.revenue || 0));
    if (!lines) return;
    await Promise.all(lines.map((l) => {
      const v = byName.get(l.item_name ?? '') ?? 0;
      const per = Math.round((v / 12) * 100) / 100;
      return sbUpdate<SalesPlanLine>('sales_plan_lines', 'id=eq.' + l.id, {
        amounts: Array(12).fill(per),
      } as Partial<SalesPlanLine>);
    }));
    load();
  }

  async function pushToQbo() {
    if (!confirm(`Build the QBO Budget payload for ${plan.name} (FY${plan.fiscal_year})?\n\nDownloads a CSV ready to import via QBO Web → Settings → Tools → Budgeting → Import.`)) return;
    const token = await _sbToken();
    const res = await fetch(SB_URL + '/functions/v1/push-qbo-budget', {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: plan.id, write: false }),
    });
    const j = await res.json();
    if (!j.ok) { alert('Failed: ' + (j.error || 'unknown')); return; }
    const blob = new Blob([j.csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = plan.name.replace(/\s+/g, '_') + '_FY' + plan.fiscal_year + '_qbo_budget.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    alert(`CSV downloaded — ${j.budget_detail_count} detail rows across ${j.rollup_count} accounts.\n\n${(j.upload_instructions || []).join('\n')}`);
  }

  function exportRollupCsv() {
    if (!lines || lines.length === 0) { alert('Nothing to export yet.'); return; }
    // Aggregate plan lines by account, client-side. Each line's amounts[]
    // is summed by month for its account.
    const byAcc = new Map<string, { qbo_account_id: string | null; m: number[]; total: number }>();
    for (const l of lines) {
      const key = l.account_name ?? '(unmapped)';
      if (!byAcc.has(key)) byAcc.set(key, { qbo_account_id: l.qbo_account_id, m: Array(12).fill(0), total: 0 });
      const e = byAcc.get(key)!;
      const amt = l.amounts ?? [];
      for (let i = 0; i < 12; i++) e.m[i] += Number(amt[i] ?? 0);
      e.total += amt.reduce((s, v) => s + Number(v || 0), 0);
    }
    const sorted = Array.from(byAcc.entries()).sort((a, b) => b[1].total - a[1].total);
    const head = ['Account', 'QBO Account ID', ...MONTHS_SHORT, 'Total'];
    const rows = sorted.map(([name, e]) => [
      name,
      e.qbo_account_id ?? '',
      ...e.m.map((v) => v.toFixed(2)),
      e.total.toFixed(2),
    ]);
    downloadCsv(plan.name.replace(/\s+/g, '_') + `_FY${plan.fiscal_year}_budget.csv`, toCsv([head, ...rows]));
  }

  const totalAnnual = useMemo(
    () => (lines ?? []).reduce((s, l) => s + (l.amounts ?? []).reduce((a, v) => a + Number(v || 0), 0), 0),
    [lines],
  );
  const compareByItem = useMemo<CompareByItem | null>(() => {
    if (!compareLines) return null;
    const byItem: CompareByItem = {};
    for (const line of compareLines) {
      const key = line.qbo_item_id ?? line.item_name ?? line.id;
      if (!byItem[key]) byItem[key] = { item_name: line.item_name, total: 0 };
      byItem[key].total += (line.amounts ?? []).reduce((s, v) => s + Number(v || 0), 0);
    }
    return byItem;
  }, [compareLines]);
  const comparePlan = comparePlans.find((p) => p.id === comparePlanId) ?? null;
  const qboWarnings = qboFreshness?.warnings?.filter(Boolean) ?? [];
  const showQboWarning = qboFreshness != null && (qboFreshness.status !== 'ok' || qboWarnings.length > 0);

  if (!lines) return <div className="ld">Loading plan…</div>;

  const modeBtns: { id: Mode; label: string }[] = [
    { id: 'lines',      label: 'Studio' },
    { id: 'pl',         label: 'P&L' },
    { id: 'vs_actuals', label: 'Variance' },
    { id: 'forecast',   label: 'Scorecard' },
  ];

  return (
    <div>
      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 10,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <button onClick={onBack} style={btnSecondary()}>← Plans</button>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            {plan.name} — FY{plan.fiscal_year}
          </div>
          <div style={{ fontSize: 10, color: 'var(--mt)' }}>
            {plan.scenario} · {lines.length} lines · {fm(totalAnnual)} annual
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {modeBtns.map((m) => {
            const on = mode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                style={{
                  background: on ? 'var(--ac)' : 'var(--sf2)',
                  color: on ? 'var(--bg)' : 'var(--tx)',
                  border: '1px solid var(--bd)',
                  padding: '5px 11px',
                  borderRadius: 4,
                  fontSize: 11,
                  cursor: 'pointer',
                  fontWeight: on ? 700 : 400,
                  letterSpacing: 0.5,
                }}
              >
                {m.label.toUpperCase()}
              </button>
            );
          })}
          <button onClick={() => setBuildOpen(true)} style={btnPrimary()}>
            BUILD…
          </button>
          <button onClick={copyFromActuals} style={btnSecondary()}>
            COPY FROM {plan.fiscal_year - 1}
          </button>
          <button onClick={pushToQbo} style={btnSecondary()}>PUSH TO QBO</button>
          <button onClick={exportRollupCsv} style={btnSecondary()}>EXPORT CSV</button>
        </div>
      </div>

      {showQboWarning && (
        <div
          className="cd"
          style={{
            marginBottom: 10,
            padding: '8px 12px',
            borderColor: 'rgba(242,184,75,0.55)',
            color: 'var(--am)',
            fontSize: 11,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <strong>QBO DATA WARNING</strong>
          <span>{qboWarnings[0] ?? qboFreshness?.status ?? 'Freshness check needs attention'}</span>
          {qboWarnings.length > 1 && <span style={{ color: 'var(--mt)' }}>+{qboWarnings.length - 1} more</span>}
        </div>
      )}

      {mode === 'pl' && <PlanPlView planId={plan.id} />}

      {buildOpen && (
        <PlanBuildDialog
          planId={plan.id}
          planFiscalYear={plan.fiscal_year}
          onClose={() => setBuildOpen(false)}
          onApplied={() => { load(); setMode('lines'); }}
        />
      )}

      {mode === 'lines' && (
        <div className="cd" style={{ padding: 0, marginBottom: 10 }}>
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--bd)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              <div className="ct" style={{ margin: 0 }}>PLANNING STUDIO</div>
              <div style={{ fontSize: 10, color: 'var(--mt)' }}>
                FY{plan.fiscal_year} · {lines.length} plan lines · {actualsByItem == null ? 'actuals loading' : 'actuals loaded'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>View</span>
              <div style={{ display: 'flex', border: '1px solid var(--bd)', borderRadius: 4, overflow: 'hidden' }}>
                {VIEW_MODES.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setViewMode(v.id)}
                    style={{
                      padding: '4px 10px', fontSize: 10, fontWeight: 600,
                      background: viewMode === v.id ? 'rgba(91,181,240,0.18)' : 'transparent',
                      color:      viewMode === v.id ? 'var(--ac)' : 'var(--tx2)',
                      border: 'none', borderRight: '1px solid var(--bd)', cursor: 'pointer',
                    }}
                  >{v.label}</button>
                ))}
              </div>
              <select
                value={comparePlanId}
                onChange={(e) => setComparePlanId(e.target.value)}
                style={{ ...inp(), width: 190, fontSize: 10, padding: '4px 8px' }}
              >
                <option value="">Compare plan</option>
                {comparePlans.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button onClick={() => setPickerOpen(!pickerOpen)} style={btnSecondary()}>+ ADD ITEM</button>
            </div>
          </div>
          {pickerOpen && (
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
              <select
                style={{ ...inp(), width: '100%', maxWidth: 600 }}
                defaultValue=""
                onChange={(e) => {
                  const it = itemOpts.find((x) => x.qbo_item_id === e.target.value);
                  if (it) addItemLine(it);
                }}
              >
                <option value="">-- pick an item to add --</option>
                {itemOpts
                  .filter((it) => !lines.some((l) => l.qbo_item_id === it.qbo_item_id))
                  .map((it) => (
                    <option key={it.qbo_item_id} value={it.qbo_item_id}>
                      {(it.name || it.fully_qualified_name) +
                        (it.income_account_name ? ' → ' + it.income_account_name : '')}
                    </option>
                  ))}
              </select>
            </div>
          )}
          <div style={{ maxHeight: '78vh', overflow: 'auto' }}>
            <PlanLinesGrouped
              lines={lines}
              linesSections={linesSections}
              viewMode={viewMode}
              actualsByItem={actualsByItem}
              compareByItem={compareByItem}
              compareLabel={comparePlan?.name ?? null}
              planFiscalYear={plan.fiscal_year}
              onSetCell={(line, monthIdx, value) => setCell(line, monthIdx, value)}
              onFillFlat={(line, total) => fillFlat(line, total)}
              onDelete={(id) => deleteLine(id)}
            />
          </div>
        </div>
      )}

      {mode === 'vs_actuals' && (
        <PlanVsActuals plan={plan} lines={lines} actualsByItem={actualsByItem} />
      )}

      {mode === 'forecast' && <PlanForecast plan={plan} />}
    </div>
  );
}
