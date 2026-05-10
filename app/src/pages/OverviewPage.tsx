import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs, { Dayjs } from 'dayjs';
import { ChevronDown, Printer } from 'lucide-react';
import { DateRangePicker } from '@mui/x-date-pickers-pro/DateRangePicker';
import { KPICard } from '../components/KPICard';
import { CustomerLink } from '../components/CustomerLink';
import { AreaChart } from '../components/charts/AreaChart';
import { DonutChart } from '../components/charts/DonutChart';
import { CHART_COLORS } from '../components/charts/util';
import { MultiPicker } from '../components/MultiPicker';
import { ModifierPicker } from '../components/ModifierPicker';
import { KpiRowSkeleton, ChartSkeleton } from '../components/Skeletons';
import { useToast } from '../lib/toast';
import { fm, fp, fmtNum } from '../lib/formatters';
import { applyEntityDefaults, applyModifiers } from '../lib/chainModifiers';
import {
  Dim, DimValue, SalesFilters, SalesPivotRow, SalesTotals,
  computePriorBounds, fetchDimValues, fetchPivot, fetchSparkline, fetchTotals, trailing12MonthKeys,
} from '../lib/sales';
import { fetchAnomalies, fetchHealthMovers, fetchInactiveCustomers } from '../lib/reports';
import { fetchInventoryHealth } from '../lib/inventory';

interface MonthRow extends SalesPivotRow { dim_label: string }

type CompareMode = 'off' | 'prior_period' | 'prior_year';
type Preset = 'mtd' | 'qtd' | 'ytd' | 'last30' | 'last90' | 'last365' | 'custom';
type Scope = 'year' | 'month' | 'week' | 'day' | 'custom';

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'mtd', label: 'MTD' }, { id: 'qtd', label: 'QTD' }, { id: 'ytd', label: 'YTD' },
  { id: 'last30', label: '30d' }, { id: 'last90', label: '90d' }, { id: 'last365', label: '12mo' },
];
const ENTITIES = ['brix', 'AS', 'freeflow', 'FF', 'shared'];

const FILTER_DIMS: { dim: Dim; key: keyof SalesFilters; label: string }[] = [
  { dim: 'category', key: 'categories', label: 'Category' },
  { dim: 'customer', key: 'customers',  label: 'Customer' },
  { dim: 'item',     key: 'items',      label: 'Item' },
  { dim: 'channel',  key: 'channels',   label: 'Channel' },
  { dim: 'segment',  key: 'segments',   label: 'Segment' },
];

function pad2(n: number) { return String(n).padStart(2, '0'); }
function applyPreset(preset: Exclude<Preset, 'custom'>, today: string): { start: string; end: string } {
  const d = new Date(today + 'T00:00:00');
  const Y = d.getFullYear(); const M = d.getMonth();
  switch (preset) {
    case 'mtd': return { start: `${Y}-${pad2(M + 1)}-01`, end: today };
    case 'qtd': { const qm = Math.floor(M / 3) * 3; return { start: `${Y}-${pad2(qm + 1)}-01`, end: today }; }
    case 'ytd': return { start: `${Y}-01-01`, end: today };
    case 'last30':  { const dd = new Date(d); dd.setDate(dd.getDate() - 30);  return { start: dd.toISOString().slice(0, 10), end: today }; }
    case 'last90':  { const dd = new Date(d); dd.setDate(dd.getDate() - 90);  return { start: dd.toISOString().slice(0, 10), end: today }; }
    case 'last365': { const dd = new Date(d); dd.setDate(dd.getDate() - 365); return { start: dd.toISOString().slice(0, 10), end: today }; }
  }
}
function detectActivePreset(start: string, end: string, today: string): Preset {
  if (end !== today) return 'custom';
  for (const p of PRESETS) {
    const r = applyPreset(p.id as Exclude<Preset, 'custom'>, today);
    if (r.start === start && r.end === end) return p.id;
  }
  return 'custom';
}
function scopeBounds(s: Exclude<Scope, 'custom'>, today: Date): { start: string; end: string } {
  const todayStr = today.toISOString().slice(0, 10);
  const Y = today.getFullYear();
  if (s === 'year')  return { start: `${Y}-01-01`, end: todayStr };
  if (s === 'month') return { start: `${Y}-${pad2(today.getMonth() + 1)}-01`, end: todayStr };
  if (s === 'week') {
    const day = today.getDay();
    const ws = new Date(today.getTime() - day * 86400000);
    return { start: ws.toISOString().slice(0, 10), end: todayStr };
  }
  return { start: todayStr, end: todayStr };
}
function detectScope(start: string, end: string, today: Date): Scope {
  const todayStr = today.toISOString().slice(0, 10);
  if (end !== todayStr) return 'custom';
  for (const s of ['year', 'month', 'week', 'day'] as const) {
    const b = scopeBounds(s, today);
    if (b.start === start) return s;
  }
  return 'custom';
}

export function OverviewPage() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const ytdStart = today.getFullYear() + '-01-01';
  const toast = useToast();

  // Manual filter state (what the user picks via dropdowns/MultiPicker)
  const [filters, setFilters] = useState<SalesFilters>({
    start: ytdStart, end: todayStr,
    entities: null, categories: null, customers: null, items: null, channels: null, segments: null,
  });
  const [compareMode, setCompareMode] = useState<CompareMode>('prior_year');
  const [activeModifiers, setActiveModifiers] = useState<string[]>([]);
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLSpanElement>(null);

  // Effective filters = manual filters ∪ active modifier filters.
  const effectiveFilters = useMemo(
    () => applyModifiers(filters, activeModifiers),
    [filters, activeModifiers],
  );

  useEffect(() => {
    if (!scopeOpen) return;
    function onDoc(e: MouseEvent) {
      if (!scopeRef.current) return;
      if (!scopeRef.current.contains(e.target as Node)) setScopeOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [scopeOpen]);

  const priorFilters = useMemo<SalesFilters | null>(() => {
    if (compareMode === 'off') return null;
    const { prior_start, prior_end } = computePriorBounds(effectiveFilters.start, effectiveFilters.end, compareMode);
    return { ...effectiveFilters, start: prior_start, end: prior_end };
  }, [compareMode, effectiveFilters]);

  const [dimOpts, setDimOpts] = useState<Partial<Record<Dim, DimValue[]>>>({});
  const [dimOptsLoading, setDimOptsLoading] = useState<Partial<Record<Dim, boolean>>>({});

  useEffect(() => {
    setDimOpts({});
    const loading: Partial<Record<Dim, boolean>> = {};
    for (const fd of FILTER_DIMS) loading[fd.dim] = true;
    setDimOptsLoading(loading);
    for (const fd of FILTER_DIMS) {
      fetchDimValues(fd.dim, filters.start, filters.end)
        .then((rs) => {
          setDimOpts((cur) => ({ ...cur, [fd.dim]: rs }));
          setDimOptsLoading((cur) => ({ ...cur, [fd.dim]: false }));
        })
        .catch(() => setDimOptsLoading((cur) => ({ ...cur, [fd.dim]: false })));
    }
  }, [filters.start, filters.end]);

  const [totals, setTotals] = useState<SalesTotals | null>(null);
  const [priorTotals, setPriorTotals] = useState<SalesTotals | null>(null);
  const [monthlyCurrent, setMonthlyCurrent] = useState<MonthRow[] | null>(null);
  const [monthlyPrior, setMonthlyPrior] = useState<MonthRow[] | null>(null);
  const [topCategories, setTopCategories] = useState<SalesPivotRow[] | null>(null);
  const [topCustomers, setTopCustomers] = useState<SalesPivotRow[] | null>(null);
  const [customerSparks, setCustomerSparks] = useState<Record<string, number[]>>({});
  const [revenueSpark, setRevenueSpark] = useState<number[] | null>(null);
  const [actions, setActions] = useState<{ reorderNow: number; inactive: number; anomalies: number; healthMovers: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTotals(null); setPriorTotals(null);
    fetchTotals(effectiveFilters).then((cur) => { if (!cancelled) setTotals(cur); }).catch(() => {});
    if (priorFilters) {
      fetchTotals(priorFilters).then((p) => { if (!cancelled) setPriorTotals(p); }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [JSON.stringify(effectiveFilters), JSON.stringify(priorFilters)]);

  useEffect(() => {
    let cancelled = false;
    setMonthlyCurrent(null); setMonthlyPrior(null);
    fetchPivot('month' as Dim, effectiveFilters, 24).then((rs) => { if (!cancelled) setMonthlyCurrent((rs ?? []) as MonthRow[]); }).catch(() => setMonthlyCurrent([]));
    if (priorFilters) {
      fetchPivot('month' as Dim, priorFilters, 24).then((rs) => { if (!cancelled) setMonthlyPrior((rs ?? []) as MonthRow[]); }).catch(() => setMonthlyPrior([]));
    } else { setMonthlyPrior([]); }
    return () => { cancelled = true; };
  }, [JSON.stringify(effectiveFilters), JSON.stringify(priorFilters)]);

  useEffect(() => {
    fetchPivot('category' as Dim, effectiveFilters, 12)
      .then((rs) => setTopCategories((rs ?? []).slice(0, 8)))
      .catch(() => setTopCategories([]));
  }, [JSON.stringify(effectiveFilters)]);

  useEffect(() => {
    fetchPivot('customer' as Dim, effectiveFilters, 10)
      .then(async (rs) => {
        const top = rs ?? [];
        setTopCustomers(top);
        if (top.length === 0) { setCustomerSparks({}); return; }
        const labels = top.map((r) => r.dim_label);
        const sparkRows = await fetchSparkline('customer' as Dim, labels, effectiveFilters.end, effectiveFilters);
        const keys = trailing12MonthKeys(effectiveFilters.end);
        const byLabel: Record<string, number[]> = {};
        for (const lb of labels) byLabel[lb] = Array(12).fill(0);
        for (const s of sparkRows) {
          const idx = keys.indexOf(s.ym);
          if (idx >= 0 && byLabel[s.dim_label]) byLabel[s.dim_label][idx] = Number(s.revenue || 0);
        }
        setCustomerSparks(byLabel);
      })
      .catch(() => setTopCustomers([]));
  }, [JSON.stringify(effectiveFilters)]);

  useEffect(() => {
    Promise.allSettled([
      fetchInventoryHealth({ lookback: 90, managed_only: true }),
      fetchInactiveCustomers({
        current_start: effectiveFilters.start, current_end: effectiveFilters.end,
        prior_start: (today.getFullYear() - 1) + '-01-01',
        prior_end: (today.getFullYear() - 1) + '-12-31',
        min_prior_rev: 1000, max_current_rev: 0, limit: 500,
      }),
      fetchAnomalies({ baseline_months: 6, recent_months: 1, min_baseline: 500, sigma_threshold: 2 }),
      fetchHealthMovers(14),
    ]).then(([inv, inact, anom, hm]) => {
      const reorderNow = inv.status === 'fulfilled' ? inv.value.filter((r) => r.status === 'reorder_now').length : 0;
      const inactive = inact.status === 'fulfilled' ? inact.value.length : 0;
      const anomalies = anom.status === 'fulfilled' ? anom.value.length : 0;
      const healthMovers = hm.status === 'fulfilled' ? hm.value.length : 0;
      setActions({ reorderNow, inactive, anomalies, healthMovers });
    });
  }, [effectiveFilters.start, effectiveFilters.end]);

  useEffect(() => {
    if (!monthlyCurrent || !monthlyPrior) return;
    const keys = trailing12MonthKeys(effectiveFilters.end);
    const byMonth = new Map<string, number>();
    for (const r of monthlyCurrent) byMonth.set(toYm(r.dim_label), Number(r.revenue || 0));
    for (const r of monthlyPrior) {
      const k = toYm(r.dim_label);
      if (!byMonth.has(k)) byMonth.set(k, Number(r.revenue || 0));
    }
    setRevenueSpark(keys.map((k) => byMonth.get(k) ?? 0));
  }, [monthlyCurrent, monthlyPrior, effectiveFilters.end]);

  const kpiDeltas = useMemo(() => {
    function pct(cur: number | null | undefined, prev: number | null | undefined): number | null {
      if (!cur || !prev || Number(prev) === 0) return null;
      return (Number(cur) - Number(prev)) / Number(prev);
    }
    return {
      revenue: pct(totals?.revenue, priorTotals?.revenue),
      margin: pct(
        totals?.margin_pct != null ? Number(totals.margin_pct) : null,
        priorTotals?.margin_pct != null ? Number(priorTotals.margin_pct) : null,
      ),
      customers: pct(totals?.customer_count, priorTotals?.customer_count),
      aov: pct(
        totals?.invoice_count ? Number(totals.revenue) / Number(totals.invoice_count) : null,
        priorTotals?.invoice_count ? Number(priorTotals.revenue) / Number(priorTotals.invoice_count) : null,
      ),
    };
  }, [totals, priorTotals]);

  const aov = totals && totals.invoice_count > 0 ? Number(totals.revenue) / Number(totals.invoice_count) : 0;
  const compareLabel =
    compareMode === 'prior_period' ? 'vs prior period' :
    compareMode === 'prior_year'   ? 'vs same period last year' : '';
  const activePreset = detectActivePreset(filters.start, filters.end, todayStr);
  const scope = detectScope(filters.start, filters.end, today);
  const scopeDisplay =
    scope === 'year'  ? String(today.getFullYear()) :
    scope === 'month' ? 'This Month' :
    scope === 'week'  ? 'This Week' :
    scope === 'day'   ? 'Today' :
                        String(today.getFullYear());

  function applyScope(s: Exclude<Scope, 'custom'>) {
    const b = scopeBounds(s, today);
    setFilters((cur) => ({ ...cur, start: b.start, end: b.end }));
    setScopeOpen(false);
  }
  function applyPresetClick(p: Exclude<Preset, 'custom'>) {
    const r = applyPreset(p, todayStr);
    setFilters((cur) => ({ ...cur, start: r.start, end: r.end }));
  }
  function onRangeChange(value: [Dayjs | null, Dayjs | null]) {
    const [s, e] = value;
    if (s && e) setFilters((cur) => ({ ...cur, start: s.format('YYYY-MM-DD'), end: e.format('YYYY-MM-DD') }));
  }
  function onEntityChange(entity: string | null) {
    // Apply entity smart-defaults — auto-fills categories/customers based on
    // ENTITY_AUTO_FILTERS so the dashboard scopes correctly. User can still
    // override via the MultiPicker filters after.
    setFilters((cur) => applyEntityDefaults({ ...cur, entities: entity ? [entity] : null }, entity));
  }
  function printDashboard() {
    toast.info('Opening print preview…');
    setTimeout(() => window.print(), 250);
  }
  function clearFilter(key: keyof SalesFilters, value?: string) {
    setFilters((cur) => {
      const list = (cur[key] as string[] | null | undefined) ?? [];
      const next = value ? list.filter((v) => v !== value) : [];
      return { ...cur, [key]: next.length ? next : null };
    });
  }

  const chips: { key: keyof SalesFilters; label: string; values: string[] }[] = [];
  if (filters.entities?.length)   chips.push({ key: 'entities',   label: 'entity',   values: filters.entities });
  if (filters.categories?.length) chips.push({ key: 'categories', label: 'category', values: filters.categories });
  if (filters.customers?.length)  chips.push({ key: 'customers',  label: 'customer', values: filters.customers });
  if (filters.items?.length)      chips.push({ key: 'items',      label: 'item',     values: filters.items });
  if (filters.channels?.length)   chips.push({ key: 'channels',   label: 'channel',  values: filters.channels });
  if (filters.segments?.length)   chips.push({ key: 'segments',   label: 'segment',  values: filters.segments });

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">{effectiveFilters.start} → {effectiveFilters.end}{compareLabel ? ` · ${compareLabel}` : ''}{activeModifiers.length > 0 ? ` · ${activeModifiers.join(' + ')}` : ''}</div>
          <h1 className="hero-title">
            Overview
            <span className="hero-scope-wrap" ref={scopeRef}>
              <button type="button" className="hero-accent hero-accent-btn" onClick={() => setScopeOpen(!scopeOpen)} aria-expanded={scopeOpen} aria-haspopup="menu" title="Change time scope">
                {scopeDisplay}
                <ChevronDown size={18} strokeWidth={2.4} aria-hidden="true" />
              </button>
              {scopeOpen && (
                <div className="hero-scope-menu" role="menu">
                  <button type="button" className={scope === 'year' ? 'active' : ''} onClick={() => applyScope('year')}>{today.getFullYear()} <span>year to date</span></button>
                  <button type="button" className={scope === 'month' ? 'active' : ''} onClick={() => applyScope('month')}>This Month <span>month to date</span></button>
                  <button type="button" className={scope === 'week' ? 'active' : ''} onClick={() => applyScope('week')}>This Week <span>week to date</span></button>
                  <button type="button" className={scope === 'day' ? 'active' : ''} onClick={() => applyScope('day')}>Today <span>{todayStr}</span></button>
                </div>
              )}
            </span>
          </h1>
          <div className="hero-meta">Brix Beverage · Alameda Soda Co · combined entities</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className="hero-stamp" title="Connected to live data">
            <span className="status-dot" aria-hidden="true" />
            Live · {today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </div>
          <button type="button" onClick={printDashboard} className="tb-btn tb-btn--primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Print or save the dashboard as PDF">
            <Printer size={13} strokeWidth={2.4} aria-hidden="true" />
            <span>Print</span>
          </button>
        </div>
      </div>

      {/* Large chain rollup modifier bar */}
      <ModifierPicker active={activeModifiers} onChange={setActiveModifiers} />

      <div className="toolbar">
        <div className="toolbar-row">
          <div className="toolbar-section">
            <span className="toolbar-label">Range</span>
            <div className="preset-bar" role="group" aria-label="Quick date range">
              {PRESETS.map((p) => (
                <button key={p.id} type="button" className={'preset-btn' + (activePreset === p.id ? ' preset-btn--active' : '')} onClick={() => applyPresetClick(p.id as Exclude<Preset, 'custom'>)}>{p.label}</button>
              ))}
              {activePreset === 'custom' && (<button type="button" className="preset-btn preset-btn--active" disabled>Custom</button>)}
            </div>
          </div>

          <div className="toolbar-section">
            <DateRangePicker
              value={[dayjs(filters.start), dayjs(filters.end)]}
              onChange={onRangeChange}
              format="YYYY-MM-DD"
              localeText={{ start: 'From', end: 'To' }}
              slotProps={{
                textField: { size: 'small', sx: { width: 130, '& .MuiInputBase-root': { height: 30, fontFamily: 'var(--ff-mono)', fontSize: 12, background: 'var(--bg)', color: 'var(--tx)' }, '& .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--bd)' }, '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--bd2)' } } },
                fieldSeparator: { sx: { color: 'var(--mt)', mx: 0.5 } },
              }}
            />
          </div>

          <div className="toolbar-divider" />

          <div className="toolbar-section">
            <span className="toolbar-label">Compare</span>
            <div className="seg" role="group" aria-label="Compare mode">
              <button type="button" className={'seg-btn' + (compareMode === 'off' ? ' seg-btn--active' : '')} onClick={() => setCompareMode('off')}>Off</button>
              <button type="button" className={'seg-btn' + (compareMode === 'prior_period' ? ' seg-btn--active' : '')} onClick={() => setCompareMode('prior_period')}>Prior period</button>
              <button type="button" className={'seg-btn' + (compareMode === 'prior_year' ? ' seg-btn--active' : '')} onClick={() => setCompareMode('prior_year')}>Prior year</button>
            </div>
          </div>

          <div className="toolbar-divider" />

          <div className="toolbar-section">
            <span className="toolbar-label">Entity</span>
            <select value={filters.entities?.[0] ?? ''} onChange={(e) => onEntityChange(e.target.value || null)} className="tb-select" title="Picking an entity auto-applies its default categories / customers">
              <option value="">All</option>
              {ENTITIES.map((en) => <option key={en} value={en}>{en}</option>)}
            </select>
          </div>

          <div className="toolbar-spacer" />

          <button type="button" className="tb-btn" onClick={() => {
            const ytd = applyPreset('ytd', todayStr);
            setFilters({ start: ytd.start, end: ytd.end, entities: null, categories: null, customers: null, items: null, channels: null, segments: null });
            setCompareMode('prior_year');
            setActiveModifiers([]);
          }}>Reset</button>

          <a href="#margin" className="tb-btn">Open Margin →</a>
        </div>

        <div className="toolbar-row" style={{ alignItems: 'center' }}>
          {FILTER_DIMS.map((fd) => {
            const values = (filters[fd.key] as string[] | null | undefined) ?? [];
            return (
              <MultiPicker key={fd.dim} label={fd.label} values={values}
                options={dimOpts[fd.dim] ?? null} loading={dimOptsLoading[fd.dim] === true}
                onChange={(next) => setFilters((cur) => ({ ...cur, [fd.key]: next.length ? next : null }))} />
            );
          })}
        </div>
      </div>

      {chips.length > 0 && (
        <div className="chip-row">
          <span className="toolbar-label" style={{ marginRight: 6 }}>Filtered to</span>
          {chips.map((c) => c.values.map((v) => (
            <span key={c.key + ':' + v} onClick={() => clearFilter(c.key, v)} title="click to remove" className="chip">{c.label}: {v} ×</span>
          )))}
        </div>
      )}

      {totals == null ? (<KpiRowSkeleton count={4} />) : (
        <div className="gr g4" style={{ marginBottom: 18 }}>
          <KPICard title="Revenue" value={fm(totals.revenue)} deltaPct={kpiDeltas.revenue}
            sparkline={revenueSpark ?? undefined}
            sub={fmtNum(totals.invoice_count) + ' invoices' + (priorTotals ? ' · vs ' + fm(priorTotals.revenue) : '')} />
          <KPICard title="Margin %" value={fp(totals.margin_pct)} deltaPct={kpiDeltas.margin} sub={'on ' + fm(totals.est_margin) + ' margin'} />
          <KPICard title="Customers" value={fmtNum(totals.customer_count)} deltaPct={kpiDeltas.customers} sub={fmtNum(totals.item_count) + ' items sold'} />
          <KPICard title="Avg Order Value" value={fm(aov)} deltaPct={kpiDeltas.aov} sub={totals.cost_coverage_pct != null ? fp(totals.cost_coverage_pct) + ' cost coverage' : undefined} />
        </div>
      )}

      <ActionPanel actions={actions} />

      <div className="gr g2" style={{ marginBottom: 18, gap: 14 }}>
        <div className="cd" style={{ padding: 0 }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <div className="ct" style={{ margin: 0 }}>Monthly revenue</div>
              <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>{compareLabel || 'current period only'}</div>
            </div>
          </div>
          <div style={{ padding: '14px' }}>
            {monthlyCurrent && monthlyPrior ? (
              <AreaChart ariaLabel="Monthly revenue, current vs prior" labels={monthLabels()}
                series={[
                  { name: 'Current', color: '#5BB5F0', values: alignToMonths(monthlyCurrent) },
                  ...(compareMode !== 'off' ? [{ name: compareMode === 'prior_year' ? 'Prior year' : 'Prior period', color: '#6B8190', values: alignToMonths(monthlyPrior) }] : []),
                ]} />
            ) : (<ChartSkeleton height={220} />)}
          </div>
        </div>

        <div className="cd" style={{ padding: 0 }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <div className="ct" style={{ margin: 0 }}>Revenue by category</div>
              <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>top 8 categories</div>
            </div>
            <a href="#margin" style={{ fontSize: 10, color: 'var(--mt)' }}>drill →</a>
          </div>
          <div style={{ padding: '14px' }}>
            {topCategories ? (
              <DonutChart data={topCategories.map((r, i) => ({ label: r.dim_label, value: Number(r.revenue || 0), color: CHART_COLORS[i % CHART_COLORS.length] }))}
                centerLabel="Total" centerValue={fm(totals?.revenue ?? 0)} ariaLabel="Revenue by category" />
            ) : (<ChartSkeleton height={220} />)}
          </div>
        </div>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div>
            <div className="ct" style={{ margin: 0 }}>Top customers</div>
            <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>by revenue, with 12-mo trend</div>
          </div>
          <a href="#customers" style={{ fontSize: 10, color: 'var(--mt)' }}>all customers →</a>
        </div>
        {!topCustomers ? (<div className="ld">Loading</div>) : (
          <table>
            <thead><tr><th>Customer</th><th style={{ textAlign: 'right' }}>Revenue</th><th style={{ textAlign: 'right' }}>Margin %</th><th>Trend (12mo)</th></tr></thead>
            <tbody>
              {topCustomers.map((r) => {
                const mp = r.margin_pct != null ? Number(r.margin_pct) : null;
                const mpColor = mp == null ? 'var(--mt)' : mp >= 0.4 ? 'var(--success)' : mp >= 0 ? 'var(--warning)' : 'var(--danger)';
                const spark = customerSparks[r.dim_label];
                return (
                  <tr key={r.dim_label}>
                    <td style={{ fontWeight: 600, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.dim_label}>
                      <CustomerLink qboCustomerId={null} name={r.dim_label} />
                    </td>
                    <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fm(r.revenue)}</td>
                    <td className="mn" style={{ textAlign: 'right', color: mpColor }}>{fp(r.margin_pct)}</td>
                    <td style={{ width: 140 }}>{spark && spark.length > 0 ? <RowSpark values={spark} /> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ActionPanel({ actions }: { actions: { reorderNow: number; inactive: number; anomalies: number; healthMovers: number } | null }) {
  const items = [
    { id: 'reorder',   label: 'Reorder Now',     count: actions?.reorderNow,   tone: 'var(--danger)',  href: '#inventory' },
    { id: 'inactive',  label: 'Inactive Cust.',  count: actions?.inactive,     tone: 'var(--warning)', href: '#reports' },
    { id: 'anomalies', label: 'Anomalies',       count: actions?.anomalies,    tone: 'var(--info)',    href: '#reports' },
    { id: 'movers',    label: 'Health Movers',   count: actions?.healthMovers, tone: 'var(--ac)',      href: '#reports' },
  ];
  return (
    <div className="gr g4" style={{ marginBottom: 18, gap: 12 }}>
      {items.map((it) => (
        <a key={it.id} href={it.href} className="cd" style={{ display: 'block', padding: '14px 16px', borderLeft: '3px solid ' + it.tone, textDecoration: 'none', color: 'var(--tx)' }}>
          <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 1.4, textTransform: 'uppercase', fontWeight: 600 }}>{it.label}</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: it.count != null ? it.tone : 'var(--mt)', marginTop: 4, fontFamily: 'var(--ff-display)', fontVariantNumeric: 'tabular-nums', lineHeight: 1, letterSpacing: '-0.5px' }}>{it.count ?? '…'}</div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 4 }}>action needed →</div>
        </a>
      ))}
    </div>
  );
}

function RowSpark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const w = 120; const h = 24;
  const stepX = w / Math.max(values.length - 1, 1);
  const points = values.map((v, i) => `${i * stepX},${h - (Math.max(0, v) / max) * (h - 2)}`).join(' ');
  const lastIdx = values.length - 1;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={points} fill="none" stroke="var(--ac)" strokeWidth={1.4} opacity={0.85} />
      <circle cx={lastIdx * stepX} cy={h - (Math.max(0, values[lastIdx]) / max) * (h - 2)} r={1.8} fill="var(--ac)" />
    </svg>
  );
}

function toYm(label: string): string { return label.length >= 7 ? label.slice(0, 7) : label; }
function monthLabels(): string[] { return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; }
function alignToMonths(rows: MonthRow[] | null | undefined): number[] {
  if (!rows) return Array(12).fill(0);
  const map = new Map<number, number>();
  for (const r of rows) {
    const m = parseInt(toYm(r.dim_label).slice(5, 7), 10);
    if (m >= 1 && m <= 12) map.set(m, Number(r.revenue || 0));
  }
  return Array.from({ length: 12 }, (_, i) => map.get(i + 1) ?? 0);
}
