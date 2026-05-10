import { useEffect, useMemo, useRef, useState } from 'react';
import { KPICard } from '../components/KPICard';
import { MultiPicker } from '../components/MultiPicker';
import { PivotTable } from '../components/PivotTable';
import { BarChart } from '../components/charts/BarChart';
import { DonutChart } from '../components/charts/DonutChart';
import { AreaChart } from '../components/charts/AreaChart';
import { CHART_COLORS } from '../components/charts/util';

type ChartKind = 'none' | 'bar' | 'pie' | 'line';
import { fm, fp, fmtNum } from '../lib/formatters';
import { downloadCsv, toCsv } from '../lib/csv';
import { sbq } from '../lib/rpc';
import { SB_KEY, SB_URL, _sbToken } from '../lib/supabase';
import {
  ComparisonRow,
  Dim,
  DimValue,
  SalesFilters,
  SalesPivotRow,
  SalesTotals,
  computePriorBounds,
  fetchDimValues,
  fetchPivot,
  fetchSparkline,
  fetchTotals,
  mergeWithPrior,
  trailing12MonthKeys,
} from '../lib/sales';

const DIMS: { id: Dim; label: string }[] = [
  { id: 'category', label: 'Category' },
  { id: 'item',     label: 'Item' },
  { id: 'customer', label: 'Customer' },
  { id: 'month',    label: 'Month' },
  { id: 'entity',   label: 'Entity' },
  { id: 'account',  label: 'Account' },
  { id: 'segment',  label: 'Segment' },
  { id: 'channel',  label: 'Channel' },
];

const ENTITIES = ['brix', 'AS', 'freeflow', 'FF', 'shared'];

const FILTER_DIMS: { dim: Dim; key: keyof SalesFilters; label: string }[] = [
  { dim: 'category', key: 'categories', label: 'Category' },
  { dim: 'customer', key: 'customers',  label: 'Customer' },
  { dim: 'item',     key: 'items',      label: 'Item' },
  { dim: 'channel',  key: 'channels',   label: 'Channel' },
  { dim: 'segment',  key: 'segments',   label: 'Segment' },
];

const DRILL_FILTER: Partial<Record<Dim, keyof SalesFilters>> = {
  category: 'categories',
  customer: 'customers',
  item:     'items',
  channel:  'channels',
  segment:  'segments',
  entity:   'entities',
};

const DRILL_NEXT: Partial<Record<Dim, Dim>> = {
  category: 'item',
  segment:  'item',
  channel:  'customer',
  customer: 'item',
  entity:   'category',
};

type CompareMode = 'off' | 'prior_period' | 'prior_year';

type Preset = 'mtd' | 'qtd' | 'ytd' | 'last30' | 'last90' | 'last365' | 'custom';

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'mtd',     label: 'MTD'    },
  { id: 'qtd',     label: 'QTD'    },
  { id: 'ytd',     label: 'YTD'    },
  { id: 'last30',  label: '30d'    },
  { id: 'last90',  label: '90d'    },
  { id: 'last365', label: '12mo'   },
];

function pad2(n: number) { return String(n).padStart(2, '0'); }

function applyPreset(preset: Exclude<Preset, 'custom'>, today: string): { start: string; end: string } {
  const d = new Date(today + 'T00:00:00');
  const Y = d.getFullYear();
  const M = d.getMonth();
  switch (preset) {
    case 'mtd': return { start: `${Y}-${pad2(M + 1)}-01`, end: today };
    case 'qtd': {
      const qm = Math.floor(M / 3) * 3;
      return { start: `${Y}-${pad2(qm + 1)}-01`, end: today };
    }
    case 'ytd': return { start: `${Y}-01-01`, end: today };
    case 'last30': {
      const dd = new Date(d); dd.setDate(dd.getDate() - 30);
      return { start: dd.toISOString().slice(0, 10), end: today };
    }
    case 'last90': {
      const dd = new Date(d); dd.setDate(dd.getDate() - 90);
      return { start: dd.toISOString().slice(0, 10), end: today };
    }
    case 'last365': {
      const dd = new Date(d); dd.setDate(dd.getDate() - 365);
      return { start: dd.toISOString().slice(0, 10), end: today };
    }
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

export function MarginPage() {
  const today = new Date().toISOString().slice(0, 10);
  const ytdStart = new Date().getFullYear() + '-01-01';

  const [dim, setDim] = useState<Dim>('category');
  const [filters, setFilters] = useState<SalesFilters>({
    start: ytdStart,
    end: today,
    entities: null,
  });
  const [showSparklines, setShowSparklines] = useState(false);
  const [compareMode, setCompareMode] = useState<CompareMode>('prior_year');
  const [chartKind, setChartKind] = useState<ChartKind>('none');

  const [rows, setRows] = useState<SalesPivotRow[] | null>(null);
  const [comparison, setComparison] = useState<ComparisonRow[] | null>(null);
  const [totals, setTotals] = useState<SalesTotals | null>(null);
  const [priorTotals, setPriorTotals] = useState<SalesTotals | null>(null);
  const [sparklines, setSparklines] = useState<Record<string, number[]>>({});
  const [err, setErr] = useState<string>('');

  const [dimOpts, setDimOpts] = useState<Partial<Record<Dim, DimValue[]>>>({});
  const dimOptsLoading = useRef<Set<Dim>>(new Set());

  const [syncedAt, setSyncedAt] = useState<string | null | undefined>(undefined);
  const [syncing, setSyncing] = useState(false);

  function loadSyncedAt() {
    sbq<{ synced_at: string | null }>('qbo_items', 'select=synced_at&order=synced_at.desc&limit=1')
      .then((rs) => setSyncedAt(rs?.[0]?.synced_at ?? null))
      .catch(() => setSyncedAt(null));
  }

  useEffect(() => { loadSyncedAt(); }, []);

  async function syncItemCosts() {
    if (!confirm('Pull Item master + PurchaseCost from QuickBooks now? This may take ~30s.')) return;
    setSyncing(true);
    try {
      const token = await _sbToken();
      const res = await fetch(SB_URL + '/functions/v1/sync-qbo-items', {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token },
      });
      const j = await res.json();
      if (j.ok) {
        alert(`Synced ${j.synced} items (${j.with_purchase_cost} with purchase cost). Refreshing…`);
        loadSyncedAt();
        setFilters((cur) => ({ ...cur }));
      } else {
        alert('Sync failed: ' + (j.error || 'unknown'));
      }
    } catch (e) {
      alert('Sync error: ' + (e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  const syncFresh = useMemo(() => {
    if (syncedAt === undefined) return '';
    if (!syncedAt) return 'never';
    const ageMin = Math.round((Date.now() - new Date(syncedAt).getTime()) / 60000);
    if (ageMin < 60) return ageMin + 'm ago';
    if (ageMin < 1440) return Math.round(ageMin / 60) + 'h ago';
    return Math.round(ageMin / 1440) + 'd ago';
  }, [syncedAt]);

  function ensureDimOptions(d: Dim) {
    if (dimOpts[d]) return;
    if (dimOptsLoading.current.has(d)) return;
    dimOptsLoading.current.add(d);
    fetchDimValues(d, filters.start, filters.end)
      .then((rows) => {
        setDimOpts((cur) => ({ ...cur, [d]: rows }));
        dimOptsLoading.current.delete(d);
      })
      .catch(() => dimOptsLoading.current.delete(d));
  }

  useEffect(() => {
    setDimOpts({});
    dimOptsLoading.current.clear();
  }, [filters.start, filters.end]);

  // Pivot + totals (current period).
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr('');
    Promise.all([fetchPivot(dim, filters), fetchTotals(filters)])
      .then(([p, t]) => {
        if (cancelled) return;
        setRows(p ?? []);
        setTotals(t);
      })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [dim, JSON.stringify(filters)]);

  // Prior totals — drives the % delta on each KPI card.
  useEffect(() => {
    if (compareMode === 'off') {
      setPriorTotals(null);
      return;
    }
    let cancelled = false;
    const { prior_start, prior_end } = computePriorBounds(filters.start, filters.end, compareMode);
    fetchTotals({ ...filters, start: prior_start, end: prior_end })
      .then((t) => { if (!cancelled) setPriorTotals(t); })
      .catch(() => { if (!cancelled) setPriorTotals(null); });
    return () => { cancelled = true; };
  }, [compareMode, filters.start, filters.end, JSON.stringify(filters)]);

  // Compare: prior-period pivot for the table + chart deltas.
  useEffect(() => {
    if (compareMode === 'off' || !rows) {
      setComparison(null);
      return;
    }
    const { prior_start, prior_end } = computePriorBounds(filters.start, filters.end, compareMode);
    fetchPivot(dim, { ...filters, start: prior_start, end: prior_end })
      .then((prior) => setComparison(mergeWithPrior(rows, prior ?? [])))
      .catch(() => setComparison(null));
  }, [compareMode, rows, dim, filters.start, filters.end, JSON.stringify(filters)]);

  // Sparkline trend column.
  useEffect(() => {
    if (!showSparklines || !rows || rows.length === 0 || dim === 'month') {
      setSparklines({});
      return;
    }
    const keys = trailing12MonthKeys(filters.end);
    const labels = rows.slice(0, 100).map((r) => r.dim_label);
    fetchSparkline(dim, labels, filters.end, filters)
      .then((spark) => {
        const byLabel: Record<string, number[]> = {};
        for (const lbl of labels) byLabel[lbl] = Array(12).fill(0);
        for (const s of spark) {
          const idx = keys.indexOf(s.ym);
          if (idx >= 0 && byLabel[s.dim_label]) byLabel[s.dim_label][idx] = Number(s.revenue || 0);
        }
        setSparklines(byLabel);
      })
      .catch(() => setSparklines({}));
  }, [showSparklines, dim, rows, filters.end, JSON.stringify(filters)]);

  function exportCsv() {
    if (!rows || rows.length === 0) return;
    const display = comparison ?? rows;
    const baseHeader = ['Dimension', 'Line count', 'Qty', 'Revenue', 'Est cost', 'Est margin', 'Margin %'];
    const cmpHeader = comparison ? ['Prior revenue', 'Δ revenue', 'Δ %'] : [];
    const header = [...baseHeader, ...cmpHeader];
    const data: (string | number | null)[][] = display.map((r) => {
      const cmp = (r as ComparisonRow).prior_revenue !== undefined ? (r as ComparisonRow) : null;
      return [
        r.dim_label,
        r.line_count,
        r.qty,
        Number(r.revenue ?? 0).toFixed(2),
        r.est_cost != null ? Number(r.est_cost).toFixed(2) : '',
        r.est_margin != null ? Number(r.est_margin).toFixed(2) : '',
        r.margin_pct != null ? Number(r.margin_pct).toFixed(4) : '',
        ...(comparison && cmp
          ? [
              cmp.prior_revenue != null ? Number(cmp.prior_revenue).toFixed(2) : '',
              cmp.delta_revenue != null ? Number(cmp.delta_revenue).toFixed(2) : '',
              cmp.delta_pct != null ? Number(cmp.delta_pct).toFixed(4) : '',
            ]
          : []),
      ];
    });
    downloadCsv(
      `margin_${dim}_${filters.start}_${filters.end}${comparison ? '_vs_' + compareMode : ''}.csv`,
      toCsv([header, ...data]),
    );
  }

  function drillInto(row: SalesPivotRow) {
    const filterKey = DRILL_FILTER[dim];
    const next = DRILL_NEXT[dim];
    if (!filterKey || !next || dim === next) return;
    setFilters((cur) => {
      const existing = (cur[filterKey] as string[] | null | undefined) ?? [];
      const already = existing.includes(row.dim_label);
      const updated = already ? existing : [...existing, row.dim_label];
      return { ...cur, [filterKey]: updated };
    });
    setDim(next);
  }

  function clearFilter(key: keyof SalesFilters, value?: string) {
    setFilters((cur) => {
      const list = (cur[key] as string[] | null | undefined) ?? [];
      const next = value ? list.filter((v) => v !== value) : [];
      return { ...cur, [key]: next.length ? next : null };
    });
  }

  function applyPresetClick(p: Exclude<Preset, 'custom'>) {
    const r = applyPreset(p, today);
    setFilters((cur) => ({ ...cur, start: r.start, end: r.end }));
  }

  // KPI deltas vs prior period (drives the ▲/▼ % pill on each card)
  const kpiDeltas = useMemo(() => {
    if (!totals || !priorTotals) return null;
    function pct(cur: number | null | undefined, prev: number | null | undefined): number | null {
      if (cur == null || prev == null || Number(prev) === 0) return null;
      return (Number(cur) - Number(prev)) / Number(prev);
    }
    return {
      revenue:       pct(totals.revenue,         priorTotals.revenue),
      margin:        pct(totals.est_margin,      priorTotals.est_margin),
      customers:     pct(totals.customer_count,  priorTotals.customer_count),
      cost_coverage: pct(totals.cost_coverage_pct, priorTotals.cost_coverage_pct),
    };
  }, [totals, priorTotals]);

  const accent = useMemo(() => {
    if (totals?.cost_coverage_pct == null) return undefined;
    const v = Number(totals.cost_coverage_pct);
    return v >= 0.8 ? 'var(--gn)' : v >= 0.5 ? 'var(--am)' : 'var(--rd)';
  }, [totals]);

  const chips: { key: keyof SalesFilters; label: string; values: string[] }[] = [];
  if (filters.entities?.length) chips.push({ key: 'entities', label: 'entity', values: filters.entities });
  if (filters.categories?.length) chips.push({ key: 'categories', label: 'category', values: filters.categories });
  if (filters.customers?.length) chips.push({ key: 'customers', label: 'customer', values: filters.customers });
  if (filters.items?.length) chips.push({ key: 'items', label: 'item', values: filters.items });
  if (filters.channels?.length) chips.push({ key: 'channels', label: 'channel', values: filters.channels });
  if (filters.segments?.length) chips.push({ key: 'segments', label: 'segment', values: filters.segments });

  const tableRows: SalesPivotRow[] | ComparisonRow[] =
    comparison ?? (rows ?? []);

  const activePreset = detectActivePreset(filters.start, filters.end, today);

  const compareLabel =
    compareMode === 'prior_period' ? 'vs prior period' :
    compareMode === 'prior_year'   ? 'vs same period last year' :
                                     '';

  return (
    <div>
      {/* Hero header */}
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Margin · Sales · Cost · Customer pivots</div>
          <h1 className="hero-title">Margin Control</h1>
          <div className="hero-meta">
            {filters.start} → {filters.end}{compareLabel ? ` · ${compareLabel}` : ''}
          </div>
        </div>
        <div className="hero-stamp" title={syncedAt ? 'Item costs last synced ' + new Date(syncedAt).toLocaleString() : 'never synced'}>
          <span className="status-dot" aria-hidden="true" />
          Costs · {syncFresh || '—'}
        </div>
      </div>

      {/* KPI row — with prior-period delta */}
      <div className="gr g4" style={{ marginBottom: 18 }}>
        <KPICard
          title="Revenue"
          value={totals ? fm(totals.revenue) : '…'}
          deltaPct={kpiDeltas?.revenue ?? null}
          sub={totals ? fmtNum(totals.invoice_count) + ' invoices' : undefined}
        />
        <KPICard
          title="Est Margin"
          value={totals ? fm(totals.est_margin) : '…'}
          deltaPct={kpiDeltas?.margin ?? null}
          sub={totals ? fp(totals.margin_pct) + ' margin %' : undefined}
        />
        <KPICard
          title="Customers"
          value={totals ? fmtNum(totals.customer_count) : '…'}
          deltaPct={kpiDeltas?.customers ?? null}
          sub={totals ? fmtNum(totals.item_count) + ' items' : undefined}
        />
        <KPICard
          title="Cost Coverage"
          value={totals ? fp(totals.cost_coverage_pct) : '…'}
          deltaPct={kpiDeltas?.cost_coverage ?? null}
          sub="% of revenue with item-cost data"
          accent={accent}
        />
      </div>

      {/* Toolbar — quick presets + dates + compare on row 1, dimension + entity + chart + buttons on row 2 */}
      <div className="toolbar">
        <div className="toolbar-row">
          <div className="toolbar-section">
            <span className="toolbar-label">Range</span>
            <div className="preset-bar" role="group" aria-label="Quick date range">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={'preset-btn' + (activePreset === p.id ? ' preset-btn--active' : '')}
                  onClick={() => applyPresetClick(p.id as Exclude<Preset, 'custom'>)}
                >
                  {p.label}
                </button>
              ))}
              {activePreset === 'custom' && (
                <button type="button" className="preset-btn preset-btn--active" disabled>Custom</button>
              )}
            </div>
          </div>

          <div className="toolbar-section">
            <input
              type="date"
              value={filters.start}
              onChange={(e) => setFilters({ ...filters, start: e.target.value })}
              className="date-input"
              aria-label="Start date"
            />
            <span style={{ color: 'var(--mt)', fontSize: 11 }}>→</span>
            <input
              type="date"
              value={filters.end}
              onChange={(e) => setFilters({ ...filters, end: e.target.value })}
              className="date-input"
              aria-label="End date"
            />
          </div>

          <div className="toolbar-divider" />

          <div className="toolbar-section">
            <span className="toolbar-label">Compare</span>
            <div className="seg" role="group" aria-label="Compare mode">
              <button
                type="button"
                className={'seg-btn' + (compareMode === 'off' ? ' seg-btn--active' : '')}
                onClick={() => setCompareMode('off')}
              >
                Off
              </button>
              <button
                type="button"
                className={'seg-btn' + (compareMode === 'prior_period' ? ' seg-btn--active' : '')}
                onClick={() => setCompareMode('prior_period')}
              >
                Prior period
              </button>
              <button
                type="button"
                className={'seg-btn' + (compareMode === 'prior_year' ? ' seg-btn--active' : '')}
                onClick={() => setCompareMode('prior_year')}
              >
                Prior year
              </button>
            </div>
          </div>

          <div className="toolbar-spacer" />

          <button
            type="button"
            className="tb-btn"
            onClick={() => {
              const ytd = applyPreset('ytd', today);
              setFilters({ start: ytd.start, end: ytd.end, entities: null });
              setCompareMode('prior_year');
              setChartKind('none');
            }}
          >
            Reset
          </button>
        </div>

        <div className="toolbar-row">
          <div className="toolbar-section">
            <span className="toolbar-label">Group by</span>
            <select value={dim} onChange={(e) => setDim(e.target.value as Dim)} className="tb-select">
              {DIMS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </div>

          <div className="toolbar-section">
            <span className="toolbar-label">Entity</span>
            <select
              value={filters.entities?.[0] ?? ''}
              onChange={(e) =>
                setFilters({ ...filters, entities: e.target.value ? [e.target.value] : null })
              }
              className="tb-select"
            >
              <option value="">All</option>
              {ENTITIES.map((en) => <option key={en} value={en}>{en}</option>)}
            </select>
          </div>

          <div className="toolbar-section">
            <span className="toolbar-label">Chart</span>
            <select
              value={chartKind}
              onChange={(e) => setChartKind(e.target.value as ChartKind)}
              className="tb-select"
            >
              <option value="none">none</option>
              <option value="bar">bar</option>
              <option value="pie">pie</option>
              <option value="line">line</option>
            </select>
          </div>

          <label className="toolbar-section" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showSparklines}
              onChange={(e) => setShowSparklines(e.target.checked)}
              style={{ accentColor: 'var(--ac)' }}
            />
            <span className="toolbar-label" style={{ cursor: 'pointer' }}>Trend col</span>
          </label>

          <div className="toolbar-spacer" />

          <button onClick={syncItemCosts} disabled={syncing} className="tb-btn">
            {syncing ? 'Syncing…' : 'Sync item costs'}
          </button>
          <button onClick={exportCsv} disabled={!rows?.length} className="tb-btn tb-btn--primary">
            Export CSV
          </button>
        </div>
      </div>

      {/* Filter pickers */}
      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 14,
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 11,
        }}
      >
        {FILTER_DIMS.map((fd) => {
          const values = (filters[fd.key] as string[] | null | undefined) ?? [];
          return (
            <div
              key={fd.dim}
              onMouseDown={() => ensureDimOptions(fd.dim)}
              onTouchStart={() => ensureDimOptions(fd.dim)}
              onFocus={() => ensureDimOptions(fd.dim)}
            >
              <MultiPicker
                label={fd.label}
                values={values}
                options={dimOpts[fd.dim] ?? null}
                loading={dimOptsLoading.current.has(fd.dim)}
                onChange={(next) =>
                  setFilters((cur) => ({ ...cur, [fd.key]: next.length ? next : null }))
                }
              />
            </div>
          );
        })}
      </div>

      {chips.length > 0 && (
        <div className="chip-row">
          <span className="toolbar-label" style={{ marginRight: 6 }}>
            Filtered to
          </span>
          {chips.map((c) =>
            c.values.map((v) => (
              <span
                key={c.key + ':' + v}
                onClick={() => clearFilter(c.key, v)}
                title="click to remove"
                className="chip"
              >
                {c.label}: {v} ×
              </span>
            )),
          )}
          <button
            onClick={() => {
              setFilters({ start: filters.start, end: filters.end, entities: null });
            }}
            className="tb-btn"
            style={{ marginLeft: 'auto', color: 'var(--rd)', borderColor: 'var(--rd)' }}
          >
            Clear all
          </button>
        </div>
      )}

      {chartKind !== 'none' && rows && rows.length > 0 && (
        <div className="cd" style={{ padding: 14, marginBottom: 14 }}>
          {chartKind === 'bar' && (
            <BarChart
              ariaLabel="Revenue by selected dimension"
              data={rows.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 12).map((r, i) => ({
                label: r.dim_label,
                value: Number(r.revenue || 0),
                compareValue: comparison?.find((c) => c.dim_label === r.dim_label)?.prior_revenue ?? null,
                color: CHART_COLORS[i % CHART_COLORS.length],
              }))}
              showCompare={!!comparison}
            />
          )}
          {chartKind === 'pie' && (
            <DonutChart
              ariaLabel="Revenue share by selected dimension"
              data={rows.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 8).map((r, i) => ({
                label: r.dim_label,
                value: Number(r.revenue || 0),
                color: CHART_COLORS[i % CHART_COLORS.length],
              }))}
              centerLabel="Revenue"
              centerValue={totals ? fm(totals.revenue) : undefined}
            />
          )}
          {chartKind === 'line' && (
            <AreaChart
              ariaLabel="Revenue by selected dimension"
              labels={rows.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 12).map((r) => r.dim_label.length > 12 ? r.dim_label.slice(0, 10) + '…' : r.dim_label)}
              series={[
                {
                  name: 'Current',
                  color: '#2DCAD6',
                  values: rows.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 12).map((r) => Number(r.revenue || 0)),
                },
                ...(comparison ? [{
                  name: 'Prior',
                  color: '#6B8190',
                  values: rows.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 12).map((r) => {
                    const c = comparison.find((cc) => cc.dim_label === r.dim_label);
                    return c?.prior_revenue ?? 0;
                  }),
                }] : []),
              ]}
            />
          )}
        </div>
      )}

      {err ? (
        <div className="cd" style={{ padding: 14, color: 'var(--rd)' }}>Error: {err}</div>
      ) : rows == null ? (
        <div className="ld">Loading</div>
      ) : (
        <div className="cd" style={{ padding: 0 }}>
          <PivotTable
            dim={dim}
            rows={tableRows}
            showCompare={compareMode !== 'off' && !!comparison}
            sparklines={showSparklines && dim !== 'month' ? sparklines : undefined}
            onRowClick={DRILL_NEXT[dim] ? drillInto : undefined}
          />
        </div>
      )}
    </div>
  );
}
