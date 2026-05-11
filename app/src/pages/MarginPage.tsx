import { useEffect, useMemo, useState } from 'react';
import dayjs, { Dayjs } from 'dayjs';
import { Printer } from 'lucide-react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { DateRangePicker } from '@mui/x-date-pickers-pro/DateRangePicker';
import { KPICard } from '../components/KPICard';
import { MultiPicker } from '../components/MultiPicker';
import { MarginGrid } from '../components/MarginGrid';
import { ModifierPicker } from '../components/ModifierPicker';
import { BarChart } from '../components/charts/BarChart';
import { DonutChart } from '../components/charts/DonutChart';
import { AreaChart } from '../components/charts/AreaChart';
import { CHART_COLORS } from '../components/charts/util';
import { KpiRowSkeleton, TableSkeleton } from '../components/Skeletons';
import { EntityMark } from '../components/BrixMark';
import { useToast } from '../lib/toast';
import { applyEntityDefaults, applyModifiers, getEntityDefaults } from '../lib/chainModifiers';
import { classifyItem, classifyCustomer, ITEM_GROUP_ORDER, CUSTOMER_GROUP_ORDER } from '../lib/taxonomy';
import {
  type MarginColumnDef,
  getColumnsForDim,
  columnsNeedFetch,
  GROUP_LABEL,
  GROUP_ORDER,
} from '../lib/marginColumns';
import { KEYS, loadSetting, saveSetting } from '../lib/settingsStore';

type ChartKind = 'none' | 'bar' | 'pie' | 'line';
const CHART_KINDS: ChartKind[] = ['none', 'bar', 'pie', 'line'];
import { fm, fp, fmtNum } from '../lib/formatters';
import { downloadCsv, toCsv } from '../lib/csv';
import { sbq, sbrpc } from '../lib/rpc';
import { SB_KEY, SB_URL, _sbToken } from '../lib/supabase';
import {
  ComparisonRow, Dim, DimValue, SalesFilters, SalesPivotRow, SalesTotals,
  computePriorBounds, fetchDimValues, fetchPivot, fetchSparkline, fetchTotals,
  mergeWithPrior, trailing12MonthKeys,
} from '../lib/sales';

const DIMS: { id: Dim; label: string }[] = [
  { id: 'category', label: 'Category' }, { id: 'item', label: 'Item' },
  { id: 'customer', label: 'Customer' }, { id: 'month', label: 'Month' },
  { id: 'entity', label: 'Entity' }, { id: 'account', label: 'Account' },
  { id: 'segment', label: 'Segment' }, { id: 'channel', label: 'Channel' },
];

const BASE_ENTITIES = ['brix', 'AS', 'freeflow', 'FF', 'shared'];

const FILTER_DIMS: { dim: Dim; key: keyof SalesFilters; label: string }[] = [
  { dim: 'category', key: 'categories', label: 'Category' },
  { dim: 'customer', key: 'customers',  label: 'Customer' },
  { dim: 'item',     key: 'items',      label: 'Item' },
  { dim: 'channel',  key: 'channels',   label: 'Channel' },
  { dim: 'segment',  key: 'segments',   label: 'Segment' },
];

const GROUPING_BY_DIM: Partial<Record<Dim, {
  groupBy: (l: string) => string;
  groupOrder: Record<string, number>;
}>> = {
  item:     { groupBy: classifyItem,     groupOrder: ITEM_GROUP_ORDER     },
  customer: { groupBy: classifyCustomer, groupOrder: CUSTOMER_GROUP_ORDER },
};

const DRILL_FILTER: Partial<Record<Dim, keyof SalesFilters>> = {
  category: 'categories', customer: 'customers', item: 'items',
  channel: 'channels', segment: 'segments', entity: 'entities',
};
const DRILL_NEXT: Partial<Record<Dim, Dim>> = {
  category: 'item', segment: 'item', channel: 'customer',
  customer: 'item', entity: 'category',
};

type CompareMode = 'off' | 'prior_period' | 'prior_year';
type Preset = 'mtd' | 'qtd' | 'ytd' | 'last30' | 'last90' | 'last365' | 'custom';

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'mtd', label: 'MTD' }, { id: 'qtd', label: 'QTD' }, { id: 'ytd', label: 'YTD' },
  { id: 'last30', label: '30d' }, { id: 'last90', label: '90d' }, { id: 'last365', label: '12mo' },
];

const ACX = {
  width: 160,
  '& .MuiOutlinedInput-root': {
    height: 30, minHeight: 30, fontFamily: 'var(--ff-mono)', fontSize: 12,
    background: 'var(--bg)', color: 'var(--tx)', padding: '0 6px',
    '& fieldset': { borderColor: 'var(--bd)' },
    '&:hover fieldset': { borderColor: 'var(--bd2)' },
    '&.Mui-focused fieldset': { borderColor: 'var(--ac)' },
  },
  '& .MuiAutocomplete-input': { padding: '4px 0 !important', fontFamily: 'var(--ff-mono)', fontSize: 12, color: 'var(--tx)' },
  '& .MuiSvgIcon-root': { color: 'var(--mt)' },
  '& .MuiChip-root': {
    height: 22, fontSize: 11,
    background: 'rgba(91,181,240,0.14)', color: 'var(--ac)',
    border: '1px solid rgba(91,181,240,0.32)', fontFamily: 'inherit',
    '& .MuiChip-deleteIcon': { color: 'var(--ac)', '&:hover': { color: 'var(--rd)' } },
  },
};
const ACX_PAPER = {
  paper: {
    sx: {
      background: 'var(--sf)', color: 'var(--tx)',
      border: '1px solid var(--bd)', fontFamily: 'var(--ff-mono)', fontSize: 12,
      '& .MuiAutocomplete-option': { fontSize: 12, color: 'var(--tx)' },
      '& .MuiAutocomplete-option[aria-selected="true"]': { background: 'rgba(91,181,240,0.10)' },
      '& .MuiAutocomplete-option.Mui-focused': { background: 'rgba(91,181,240,0.18)' },
      '& .MuiAutocomplete-groupLabel': {
        background: 'var(--sf)', color: 'var(--mt)', fontSize: 10,
        textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600,
      },
    },
  },
};

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

interface DimMetaRow {
  dim_label: string;
  meta: Record<string, unknown> | null;
}

export function MarginPage() {
  const today = new Date().toISOString().slice(0, 10);
  const ytdStart = new Date().getFullYear() + '-01-01';
  const toast = useToast();

  const entityOptions = useMemo(() => {
    const fromSettings = Object.keys(getEntityDefaults());
    return Array.from(new Set([...BASE_ENTITIES, ...fromSettings]));
  }, []);

  const [dim, setDim] = useState<Dim>('category');
  const [filters, setFilters] = useState<SalesFilters>({ start: ytdStart, end: today, entities: null });
  const [activeModifiers, setActiveModifiers] = useState<string[]>([]);
  const [showSparklines, setShowSparklines] = useState(false);
  const [compareMode, setCompareMode] = useState<CompareMode>('prior_year');
  const [chartKind, setChartKind] = useState<ChartKind>('none');

  const [columnsByDim, setColumnsByDim] = useState<Record<string, string[]>>(
    () => loadSetting<Record<string, string[]>>(KEYS.marginColumns, {}),
  );
  const selectedColumnIds = columnsByDim[dim] ?? [];
  const availableColumns: MarginColumnDef[] = useMemo(() => {
    const cols = getColumnsForDim(dim);
    return [...cols].sort((a, b) => {
      const ga = GROUP_ORDER[a.group] ?? 99;
      const gb = GROUP_ORDER[b.group] ?? 99;
      if (ga !== gb) return ga - gb;
      return a.label.localeCompare(b.label);
    });
  }, [dim]);
  const extraColumns: MarginColumnDef[] = useMemo(
    () => availableColumns.filter((c) => selectedColumnIds.includes(c.id)),
    [availableColumns, selectedColumnIds],
  );
  function updateColumns(nextIds: string[]) {
    const next = { ...columnsByDim, [dim]: nextIds };
    setColumnsByDim(next);
    saveSetting(KEYS.marginColumns, next);
  }

  const effectiveFilters = useMemo(
    () => applyModifiers(filters, activeModifiers),
    [filters, activeModifiers],
  );

  const [rows, setRows] = useState<SalesPivotRow[] | null>(null);
  const [comparison, setComparison] = useState<ComparisonRow[] | null>(null);
  const [totals, setTotals] = useState<SalesTotals | null>(null);
  const [priorTotals, setPriorTotals] = useState<SalesTotals | null>(null);
  const [sparklines, setSparklines] = useState<Record<string, number[]>>({});
  const [enrichment, setEnrichment] = useState<Record<string, Record<string, unknown>>>({});
  const [enrichmentLoading, setEnrichmentLoading] = useState(false);
  const [err, setErr] = useState<string>('');

  const [dimOpts, setDimOpts] = useState<Partial<Record<Dim, DimValue[]>>>({});
  const [dimOptsLoading, setDimOptsLoading] = useState<Partial<Record<Dim, boolean>>>({});

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
    toast.info('Syncing item costs from QuickBooks…');
    try {
      const token = await _sbToken();
      const res = await fetch(SB_URL + '/functions/v1/sync-qbo-items', {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token },
      });
      const j = await res.json();
      if (j.ok) {
        toast.success(`Synced ${j.synced} items (${j.with_purchase_cost} with purchase cost). Refreshing…`);
        loadSyncedAt();
        setFilters((cur) => ({ ...cur }));
      } else {
        toast.error('Sync failed: ' + (j.error || 'unknown'));
      }
    } catch (e) {
      toast.error('Sync error: ' + (e as Error).message);
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

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr('');
    Promise.all([fetchPivot(dim, effectiveFilters), fetchTotals(effectiveFilters)])
      .then(([p, t]) => { if (cancelled) return; setRows(p ?? []); setTotals(t); })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [dim, JSON.stringify(effectiveFilters)]);

  useEffect(() => {
    if (compareMode === 'off') { setPriorTotals(null); return; }
    let cancelled = false;
    const { prior_start, prior_end } = computePriorBounds(effectiveFilters.start, effectiveFilters.end, compareMode);
    fetchTotals({ ...effectiveFilters, start: prior_start, end: prior_end })
      .then((t) => { if (!cancelled) setPriorTotals(t); })
      .catch(() => { if (!cancelled) setPriorTotals(null); });
    return () => { cancelled = true; };
  }, [compareMode, JSON.stringify(effectiveFilters)]);

  useEffect(() => {
    if (compareMode === 'off' || !rows) { setComparison(null); return; }
    const { prior_start, prior_end } = computePriorBounds(effectiveFilters.start, effectiveFilters.end, compareMode);
    fetchPivot(dim, { ...effectiveFilters, start: prior_start, end: prior_end })
      .then((prior) => setComparison(mergeWithPrior(rows, prior ?? [])))
      .catch(() => setComparison(null));
  }, [compareMode, rows, dim, JSON.stringify(effectiveFilters)]);

  useEffect(() => {
    if (!showSparklines || !rows || rows.length === 0 || dim === 'month') { setSparklines({}); return; }
    const keys = trailing12MonthKeys(effectiveFilters.end);
    const labels = rows.slice(0, 100).map((r) => r.dim_label);
    fetchSparkline(dim, labels, effectiveFilters.end, effectiveFilters)
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
  }, [showSparklines, dim, rows, JSON.stringify(effectiveFilters)]);

  // Smart Columns enrichment side-fetch. When any selected extra column has
  // requiresFetch=true, call fn_dim_meta(p_dim, labels[]) and merge the
  // jsonb meta into grid rows by dim_label.
  useEffect(() => {
    if (!rows || rows.length === 0 || !columnsNeedFetch(extraColumns)) {
      setEnrichment({});
      setEnrichmentLoading(false);
      return;
    }
    let cancelled = false;
    setEnrichmentLoading(true);
    const labels = rows.slice(0, 500).map((r) => r.dim_label);
    sbrpc<DimMetaRow[]>('fn_dim_meta', { p_dim: dim, p_labels: labels })
      .then((rs) => {
        if (cancelled) return;
        const out: Record<string, Record<string, unknown>> = {};
        for (const r of rs) {
          if (r.dim_label) out[r.dim_label] = r.meta ?? {};
        }
        setEnrichment(out);
        setEnrichmentLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setEnrichment({});
        setEnrichmentLoading(false);
      });
    return () => { cancelled = true; };
  }, [dim, rows, extraColumns]);

  function exportCsv() {
    if (!rows || rows.length === 0) return;
    const display = comparison ?? rows;
    const baseHeader = ['Dimension', 'Line count', 'Qty', 'Revenue', 'Est cost', 'Est margin', 'Margin %'];
    const cmpHeader = comparison ? ['Prior revenue', 'Δ revenue', 'Δ %'] : [];
    const extraHeader = extraColumns.map((c) => c.label);
    const header = [...baseHeader, ...cmpHeader, ...extraHeader];
    const data: (string | number | null)[][] = display.map((r) => {
      const cmp = (r as ComparisonRow).prior_revenue !== undefined ? (r as ComparisonRow) : null;
      const meta = enrichment[r.dim_label] ?? {};
      const row = { ...(r as object), ...meta } as SalesPivotRow & Record<string, unknown>;
      const extraVals = extraColumns.map((c) => {
        const v = c.compute ? c.compute(row) : (c.enrichmentKey ? (row[c.enrichmentKey] as string | number | null) : null);
        if (v == null) return '';
        if (typeof v === 'number') return v.toFixed(4);
        return String(v);
      });
      return [
        r.dim_label, r.line_count, r.qty,
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
        ...extraVals,
      ];
    });
    const modSuffix = activeModifiers.length > 0 ? '_' + activeModifiers.join('-') : '';
    downloadCsv(
      `margin_${dim}_${effectiveFilters.start}_${effectiveFilters.end}${comparison ? '_vs_' + compareMode : ''}${modSuffix}.csv`,
      toCsv([header, ...data]),
    );
    toast.success(`Exported ${data.length} rows to CSV`);
  }

  function printDashboard() {
    toast.info('Opening print preview…');
    setTimeout(() => window.print(), 250);
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

  function onRangeChange(value: [Dayjs | null, Dayjs | null]) {
    const [s, e] = value;
    if (s && e) setFilters((cur) => ({ ...cur, start: s.format('YYYY-MM-DD'), end: e.format('YYYY-MM-DD') }));
  }

  function onEntityChange(entity: string | null) {
    setFilters((cur) => applyEntityDefaults({ ...cur, entities: entity ? [entity] : null }, entity));
  }

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

  const tableRows: SalesPivotRow[] | ComparisonRow[] = comparison ?? (rows ?? []);

  const enrichedRows = useMemo(() => {
    const hasEnrichment = Object.keys(enrichment).length > 0;
    if (!hasEnrichment) return tableRows;
    return (tableRows as Array<SalesPivotRow | ComparisonRow>).map((r) => ({
      ...r,
      ...(enrichment[r.dim_label] ?? {}),
    })) as typeof tableRows;
  }, [tableRows, enrichment]);

  const activePreset = detectActivePreset(filters.start, filters.end, today);
  const compareLabel =
    compareMode === 'prior_period' ? 'vs prior period' :
    compareMode === 'prior_year'   ? 'vs same period last year' : '';

  const heroEntity = filters.entities?.[0] ?? null;
  const heroBrandLabel =
    heroEntity === 'AS'       ? 'Alameda Soda Co.' :
    heroEntity === 'freeflow' || heroEntity === 'FF' ? 'FreeFlow' :
    heroEntity === 'brix'     ? 'Brix Beverage' :
                                'Brix Beverage · Alameda Soda Co.';

  return (
    <div>
      <div className="hero">
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flex: 1, minWidth: 0 }}>
          <EntityMark entity={heroEntity} size={88} className="hero-mark" />
          <div style={{ minWidth: 0 }}>
            <div className="hero-eyebrow">
              {heroBrandLabel}
              {activeModifiers.length > 0 ? ' · ' + activeModifiers.join(' + ') : ''}
            </div>
            <h1 className="hero-title">Margin Control</h1>
            <div className="hero-meta">
              {effectiveFilters.start} → {effectiveFilters.end}{compareLabel ? ` · ${compareLabel}` : ''}
              {enrichmentLoading ? ' · loading column data…' : ''}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flex: 'none' }}>
          <div className="hero-stamp" title={syncedAt ? 'Item costs last synced ' + new Date(syncedAt).toLocaleString() : 'never synced'}>
            <span className="status-dot" aria-hidden="true" />
            Costs · {syncFresh || '—'}
          </div>
          <button type="button" onClick={printDashboard} className="tb-btn tb-btn--primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Print or save the dashboard as PDF">
            <Printer size={13} strokeWidth={2.4} aria-hidden="true" />
            <span>Print</span>
          </button>
        </div>
      </div>

      {totals == null && rows == null ? (<KpiRowSkeleton count={4} />) : (
        <div className="gr g4" style={{ marginBottom: 18 }}>
          <KPICard title="Revenue" value={totals ? fm(totals.revenue) : '…'} deltaPct={kpiDeltas?.revenue ?? null}
            sub={totals ? fmtNum(totals.invoice_count) + ' invoices' : undefined} />
          <KPICard title="Est Margin" value={totals ? fm(totals.est_margin) : '…'} deltaPct={kpiDeltas?.margin ?? null}
            sub={totals ? fp(totals.margin_pct) + ' margin %' : undefined} />
          <KPICard title="Customers" value={totals ? fmtNum(totals.customer_count) : '…'} deltaPct={kpiDeltas?.customers ?? null}
            sub={totals ? fmtNum(totals.item_count) + ' items' : undefined} />
          <KPICard title="Cost Coverage" value={totals ? fp(totals.cost_coverage_pct) : '…'} deltaPct={kpiDeltas?.cost_coverage ?? null}
            sub="% of revenue with item-cost data" accent={accent} />
        </div>
      )}

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

          <div className="toolbar-spacer" />

          <button type="button" className="tb-btn" onClick={() => {
            const ytd = applyPreset('ytd', today);
            setFilters({ start: ytd.start, end: ytd.end, entities: null });
            setCompareMode('prior_year');
            setChartKind('none');
            setActiveModifiers([]);
          }}>Reset</button>
        </div>

        <div className="toolbar-row">
          <div className="toolbar-section">
            <span className="toolbar-label">Group by</span>
            <Autocomplete size="small" options={DIMS}
              getOptionLabel={(o) => o.label}
              isOptionEqualToValue={(o, v) => o.id === v.id}
              value={DIMS.find((d) => d.id === dim) ?? DIMS[0]}
              onChange={(_, v) => v && setDim(v.id)}
              disableClearable sx={ACX} slotProps={ACX_PAPER}
              renderInput={(params) => <TextField {...params} placeholder="Group by" />}
            />
          </div>

          <div className="toolbar-section">
            <span className="toolbar-label">Entity</span>
            <Autocomplete size="small"
              options={[null, ...entityOptions] as (string | null)[]}
              getOptionLabel={(o) => (o == null ? 'All entities' : o)}
              value={filters.entities?.[0] ?? null}
              onChange={(_, v) => onEntityChange(v)}
              sx={ACX} slotProps={ACX_PAPER}
              renderInput={(params) => <TextField {...params} placeholder="Entity" />}
            />
          </div>

          <div className="toolbar-section">
            <span className="toolbar-label">Chart</span>
            <Autocomplete size="small" options={CHART_KINDS}
              getOptionLabel={(o) => (o === 'none' ? 'None' : o[0].toUpperCase() + o.slice(1))}
              value={chartKind}
              onChange={(_, v) => v && setChartKind(v)}
              disableClearable sx={{ ...ACX, width: 120 }} slotProps={ACX_PAPER}
              renderInput={(params) => <TextField {...params} placeholder="Chart" />}
            />
          </div>

          <div className="toolbar-section">
            <span className="toolbar-label">Columns</span>
            <Autocomplete size="small" multiple limitTags={1}
              options={availableColumns}
              getOptionLabel={(o) => o.label}
              isOptionEqualToValue={(o, v) => o.id === v.id}
              groupBy={(o) => GROUP_LABEL[o.group]}
              value={extraColumns}
              onChange={(_, vs) => updateColumns(vs.map((v) => v.id))}
              disableCloseOnSelect
              sx={{ ...ACX, width: 240 }} slotProps={ACX_PAPER}
              renderInput={(params) => (
                <TextField {...params} placeholder={extraColumns.length === 0 ? 'Add columns…' : ''} />
              )}
            />
          </div>

          <label className="toolbar-section" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={showSparklines} onChange={(e) => setShowSparklines(e.target.checked)} style={{ accentColor: 'var(--ac)' }} />
            <span className="toolbar-label" style={{ cursor: 'pointer' }}>Trend col</span>
          </label>

          <div className="toolbar-spacer" />

          <button onClick={syncItemCosts} disabled={syncing} className="tb-btn">{syncing ? 'Syncing…' : 'Sync item costs'}</button>
          <button onClick={exportCsv} disabled={!rows?.length} className="tb-btn tb-btn--primary">Export CSV</button>
        </div>
      </div>

      <div className="cd" style={{ padding: '10px 12px', marginBottom: 14, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 11 }}>
        {FILTER_DIMS.map((fd) => {
          const values = (filters[fd.key] as string[] | null | undefined) ?? [];
          const gx = GROUPING_BY_DIM[fd.dim];
          return (
            <MultiPicker key={fd.dim} label={fd.label} values={values}
              options={dimOpts[fd.dim] ?? null} loading={dimOptsLoading[fd.dim] === true}
              groupBy={gx?.groupBy} groupOrder={gx?.groupOrder}
              onChange={(next) => setFilters((cur) => ({ ...cur, [fd.key]: next.length ? next : null }))} />
          );
        })}
        <ModifierPicker active={activeModifiers} onChange={setActiveModifiers} />
      </div>

      {chips.length > 0 && (
        <div className="chip-row">
          <span className="toolbar-label" style={{ marginRight: 6 }}>Filtered to</span>
          {chips.map((c) => c.values.map((v) => (
            <span key={c.key + ':' + v} onClick={() => clearFilter(c.key, v)} title="click to remove" className="chip">{c.label}: {v} ×</span>
          )))}
          <button onClick={() => setFilters({ start: filters.start, end: filters.end, entities: null })} className="tb-btn" style={{ marginLeft: 'auto', color: 'var(--rd)', borderColor: 'var(--rd)' }}>Clear all</button>
        </div>
      )}

      {chartKind !== 'none' && rows && rows.length > 0 && (
        <div className="cd" style={{ padding: 14, marginBottom: 14 }}>
          {chartKind === 'bar' && (
            <BarChart ariaLabel="Revenue by selected dimension"
              data={rows.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 12).map((r, i) => ({
                label: r.dim_label, value: Number(r.revenue || 0),
                compareValue: comparison?.find((c) => c.dim_label === r.dim_label)?.prior_revenue ?? null,
                color: CHART_COLORS[i % CHART_COLORS.length],
              }))}
              showCompare={!!comparison} />
          )}
          {chartKind === 'pie' && (
            <DonutChart ariaLabel="Revenue share by selected dimension"
              data={rows.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 8).map((r, i) => ({
                label: r.dim_label, value: Number(r.revenue || 0),
                color: CHART_COLORS[i % CHART_COLORS.length],
              }))}
              centerLabel="Revenue" centerValue={totals ? fm(totals.revenue) : undefined} />
          )}
          {chartKind === 'line' && (
            <AreaChart ariaLabel="Revenue by selected dimension"
              labels={rows.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 12).map((r) => r.dim_label.length > 12 ? r.dim_label.slice(0, 10) + '…' : r.dim_label)}
              series={[
                { name: 'Current', color: '#5BB5F0', values: rows.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 12).map((r) => Number(r.revenue || 0)) },
                ...(comparison ? [{ name: 'Prior', color: '#F4B400',
                  values: rows.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 12).map((r) => {
                    const c = comparison.find((cc) => cc.dim_label === r.dim_label);
                    return c?.prior_revenue ?? 0;
                  }),
                }] : []),
              ]} />
          )}
        </div>
      )}

      {err ? (
        <div className="cd" style={{ padding: 14, color: 'var(--rd)' }}>Error: {err}</div>
      ) : rows == null ? (
        <div className="cd" style={{ padding: 0 }}>
          <TableSkeleton rows={8} cols={7} />
        </div>
      ) : (
        <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
          <MarginGrid dim={dim} rows={enrichedRows}
            showCompare={compareMode !== 'off' && !!comparison}
            sparklines={showSparklines && dim !== 'month' ? sparklines : undefined}
            extraColumns={extraColumns}
            onRowClick={DRILL_NEXT[dim] ? drillInto : undefined} />
        </div>
      )}
    </div>
  );
}
