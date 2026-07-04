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
import { TopMoversStrip } from '../components/TopMoversStrip';
import { RowDetailModal } from '../components/RowDetailModal';
import { BarChart } from '../components/charts/BarChart';
import { DonutChart } from '../components/charts/DonutChart';
import { AreaChart } from '../components/charts/AreaChart';
import { CHART_COLORS } from '../components/charts/util';
import { KpiRowSkeleton, TableSkeleton } from '../components/Skeletons';
import { EntityMark } from '../components/BrixMark';
import { useToast } from '../lib/toast';
import { applyEntityDefaults, expandModifierFilters, getEntityDefaults, type ExpandedRollupFilters } from '../lib/chainModifiers';
import { fetchEntityOptions, type EntityOption } from '../lib/settings';
import { fetchSavedViews, insertSavedView, deleteSavedView, type SavedView, type SavedViewConfig } from '../lib/savedViews';
import { Bookmark, BookmarkPlus } from 'lucide-react';
import { classifyItem, classifyCustomer, ITEM_GROUP_ORDER, CUSTOMER_GROUP_ORDER } from '../lib/taxonomy';
import {
  type MarginColumnDef,
  getColumnsForDim,
  columnsNeedFetch,
  columnsNeedSparklines,
  GROUP_LABEL,
  GROUP_ORDER,
} from '../lib/marginColumns';
import { KEYS, loadSetting, saveSetting } from '../lib/settingsStore';
import {
  fetchOverheadPools,
  buildOverheadBasisTotals,
  computeOverheadFields,
  totalPoolAmount,
  type OverheadPoolTotal,
} from '../lib/overhead';

type ChartKind = 'none' | 'bar' | 'pie' | 'line';
const CHART_KINDS: ChartKind[] = ['none', 'bar', 'pie', 'line'];
import { fm, fp, fmtNum } from '../lib/formatters';
import { downloadCsv, toCsv } from '../lib/csv';
import { sbrpc } from '../lib/rpc';
import { SB_KEY, SB_URL, _sbToken } from '../lib/supabase';
import {
  ComparisonRow, Dim, DimValue, SalesFilters, SalesPivotRow, SalesTotals,
  computePriorBounds, fetchDimValues, fetchMarginDataHealth, fetchPivot, fetchPlMarginSummary, fetchQboSyncFreshness, fetchSparkline, fetchTotals,
  mergeWithPrior, type MarginHealthIssue, type PlMarginSummary, type QboSyncFreshness, trailing12MonthKeys,
} from '../lib/sales';

const DIMS: { id: Dim; label: string }[] = [
  { id: 'category', label: 'Category' }, { id: 'item', label: 'Item' },
  { id: 'customer', label: 'Customer' }, { id: 'month', label: 'Month' },
  { id: 'entity', label: 'Entity' }, { id: 'account', label: 'Account' },
  { id: 'segment', label: 'Segment' }, { id: 'channel', label: 'Channel' },
  { id: 'product_family', label: 'Family' }, { id: 'product_type', label: 'Type' },
];

// Fallback list when the live RPC returns empty. Real entities now come from
// fn_list_entities() — see useEffect below.
const FALLBACK_ENTITIES = ['brix', 'AS', 'freeflow', 'shared'];

const FILTER_DIMS: { dim: Dim; key: keyof SalesFilters; label: string }[] = [
  { dim: 'category',       key: 'categories',       label: 'Category' },
  { dim: 'customer',       key: 'customers',        label: 'Customer' },
  { dim: 'item',           key: 'items',            label: 'Item' },
  { dim: 'channel',        key: 'channels',         label: 'Channel' },
  { dim: 'segment',        key: 'segments',         label: 'Segment' },
  { dim: 'product_family', key: 'product_families', label: 'Family' },
  { dim: 'product_type',   key: 'product_types',    label: 'Type' },
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
  product_family: 'product_families', product_type: 'product_types',
};
const DRILL_NEXT: Partial<Record<Dim, Dim>> = {
  category: 'item', segment: 'item', channel: 'customer',
  customer: 'item', entity: 'category',
  product_family: 'product_type', product_type: 'item',
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
    height: 22, fontSize: 11, background: 'rgba(91,181,240,0.14)', color: 'var(--ac)',
    border: '1px solid rgba(91,181,240,0.32)', fontFamily: 'inherit',
    '& .MuiChip-deleteIcon': { color: 'var(--ac)', '&:hover': { color: 'var(--rd)' } },
  },
};
const ACX_PAPER = {
  paper: {
    sx: {
      background: 'var(--sf)', color: 'var(--tx)', border: '1px solid var(--bd)',
      fontFamily: 'var(--ff-mono)', fontSize: 12,
      '& .MuiAutocomplete-option': { fontSize: 12, color: 'var(--tx)' },
      '& .MuiAutocomplete-option[aria-selected="true"]': { background: 'rgba(91,181,240,0.10)' },
      '& .MuiAutocomplete-option.Mui-focused': { background: 'rgba(91,181,240,0.18)' },
      '& .MuiAutocomplete-groupLabel': {
        background: 'var(--sf)', color: 'var(--mt)', fontSize: 10,
        textTransform: 'uppercase', letterSpacing: 0, fontWeight: 600,
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
function ageLabel(ts: string | null | undefined): string {
  if (!ts) return 'never';
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return 'unknown';
  const ageMin = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (ageMin < 60) return ageMin + 'm ago';
  if (ageMin < 1440) return Math.round(ageMin / 60) + 'h ago';
  return Math.round(ageMin / 1440) + 'd ago';
}
function dateTimeLabel(ts: string | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : 'never';
}
function healthToneColor(severity: string | null | undefined): string {
  if (severity === 'critical') return 'var(--rd)';
  if (severity === 'warn') return 'var(--am)';
  return 'var(--gn)';
}
function healthSummary(issues: MarginHealthIssue[] | null): { label: string; color: string } {
  if (issues == null) return { label: 'CHECKING', color: 'var(--mt)' };
  if (issues.some((i) => i.severity === 'critical')) return { label: 'NEEDS REVIEW', color: 'var(--rd)' };
  if (issues.some((i) => i.severity === 'warn')) return { label: 'WATCH', color: 'var(--am)' };
  return { label: 'GOOD', color: 'var(--gn)' };
}

function MarginHealthPanel({
  issues,
  expanded,
  onToggle,
  onSyncCosts,
  syncing,
}: {
  issues: MarginHealthIssue[] | null;
  expanded: boolean;
  onToggle: () => void;
  onSyncCosts: () => void;
  syncing: boolean;
}) {
  const summary = healthSummary(issues);
  const visible = issues == null ? [] : (expanded ? issues : issues.slice(0, 4));
  const issueCount = issues?.length ?? 0;

  return (
    <div className="cd" style={{ padding: '10px 12px', marginBottom: 14, borderColor: summary.color }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, color: summary.color,
            fontSize: 10, fontWeight: 800, letterSpacing: 0, textTransform: 'uppercase',
          }}
        >
          <span className="status-dot" aria-hidden="true" style={{ background: summary.color }} />
          Margin Data Health: {summary.label}
        </span>
        <span style={{ color: 'var(--mt)', fontSize: 11 }}>
          {issues == null ? 'checking margin data' : issueCount === 0 ? 'no stale syncs, unmapped buckets, or missing-cost warnings in this view' : `${issueCount} item${issueCount === 1 ? '' : 's'} to review`}
        </span>
        <button type="button" onClick={onToggle} className="tb-btn" disabled={issueCount === 0} style={{ marginLeft: 'auto' }}>
          {expanded ? 'Hide details' : 'Show details'}
        </button>
        <button type="button" onClick={onSyncCosts} className="tb-btn" disabled={syncing}>
          {syncing ? 'Syncing...' : 'Sync item costs'}
        </button>
      </div>
      {visible.length > 0 && (
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
          {visible.map((issue) => {
            const color = healthToneColor(issue.severity);
            const samples = (issue.sample_labels ?? []).filter(Boolean);
            return (
              <div
                key={issue.issue_key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 10,
                  alignItems: 'center',
                  padding: '7px 8px',
                  borderTop: '1px solid var(--bd)',
                  fontSize: 11,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ color, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0, fontSize: 9 }}>
                    {issue.severity}
                  </div>
                  <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {issue.title}
                  </div>
                </div>
                <div style={{ color: 'var(--tx2)', minWidth: 0 }}>
                  <span>{issue.detail}</span>
                  {issue.revenue != null && <span style={{ color: 'var(--mt)' }}> · {fm(issue.revenue)}</span>}
                  {issue.line_count > 0 && <span style={{ color: 'var(--mt)' }}> · {fmtNum(issue.line_count)} lines</span>}
                </div>
                <div style={{ color: 'var(--mt)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={[samples.join(', '), issue.action ?? ''].filter(Boolean).join(' — ')}
                >
                  {samples.length > 0 ? samples.join(', ') : issue.action}
                </div>
              </div>
            );
          })}
          {!expanded && issueCount > visible.length && (
            <div style={{ color: 'var(--mt)', fontSize: 10, padding: '2px 8px' }}>
              +{issueCount - visible.length} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface DimMetaRow {
  dim_label: string;
  meta: Record<string, unknown> | null;
}

export function MarginPage() {
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const today = new Date().toISOString().slice(0, 10);
  const ytdStart = new Date().getFullYear() + '-01-01';
  const toast = useToast();

  const [entityList, setEntityList] = useState<EntityOption[]>([]);
  useEffect(() => {
    fetchEntityOptions().then(setEntityList).catch(() => setEntityList([]));
  }, []);
  const entityOptions = useMemo(() => {
    const fromSettings = Object.keys(getEntityDefaults());
    const fromData = entityList.map((e) => e.entity);
    const set = new Set<string>([...fromData, ...fromSettings]);
    if (set.size === 0) for (const e of FALLBACK_ENTITIES) set.add(e);
    return Array.from(set);
  }, [entityList]);

  const [dim, setDim] = useState<Dim>('category');
  const [filters, setFilters] = useState<SalesFilters>({ start: ytdStart, end: today, entities: null });
  const [activeModifiers, setActiveModifiers] = useState<string[]>([]);
  const [showSparklines, setShowSparklines] = useState(false);
  const [compareMode, setCompareMode] = useState<CompareMode>('prior_year');
  const [chartKind, setChartKind] = useState<ChartKind>('none');
  const [detailRow, setDetailRow] = useState<(SalesPivotRow & Record<string, unknown>) | null>(null);

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

  // Resolve rollup pattern strings to real customer/category/item names via
  // fn_preview_rollup_match (ILIKE). Re-run whenever activeModifiers changes.
  const [expandedRollup, setExpandedRollup] = useState<ExpandedRollupFilters>({ filters: {}, perRollup: [] });
  useEffect(() => {
    if (activeModifiers.length === 0) {
      setExpandedRollup({ filters: {}, perRollup: [] });
      return;
    }
    let cancelled = false;
    expandModifierFilters(activeModifiers)
      .then((res) => { if (!cancelled) setExpandedRollup(res); })
      .catch(() => { if (!cancelled) setExpandedRollup({ filters: {}, perRollup: [] }); });
    return () => { cancelled = true; };
  }, [activeModifiers]);

  // Clicking a rollup chip EXCLUDES that bucket from totals. Chips are
  // FLAT: each one targets a single dimension (chain rollups carry only
  // customers; category rollups carry only categories). Stacking chips
  // unions their exclusions. See chainModifiers.ts for the chip catalog.
  const effectiveFilters = useMemo(() => {
    const next: SalesFilters = { ...filters };
    const map = {
      customers:  'exclude_customers' as const,
      categories: 'exclude_categories' as const,
      items:      'exclude_items' as const,
    };
    for (const src of Object.keys(map) as Array<keyof typeof map>) {
      const exp = expandedRollup.filters[src];
      if (!exp || exp.length === 0) continue;
      const dst = map[src];
      const cur = (next[dst] as string[] | null | undefined) ?? [];
      next[dst] = Array.from(new Set([...cur, ...exp]));
    }
    return next;
  }, [filters, expandedRollup]);

  const [rows, setRows] = useState<SalesPivotRow[] | null>(null);
  const [comparison, setComparison] = useState<ComparisonRow[] | null>(null);
  const [totals, setTotals] = useState<SalesTotals | null>(null);
  const [priorTotals, setPriorTotals] = useState<SalesTotals | null>(null);
  const [plSummary, setPlSummary] = useState<PlMarginSummary | null>(null);
  const [sparklines, setSparklines] = useState<Record<string, number[]>>({});
  const [enrichment, setEnrichment] = useState<Record<string, Record<string, unknown>>>({});
  const [enrichmentLoading, setEnrichmentLoading] = useState(false);
  const [overheadPools, setOverheadPools] = useState<OverheadPoolTotal[]>([]);
  const [err, setErr] = useState<string>('');

  const [dimOpts, setDimOpts] = useState<Partial<Record<Dim, DimValue[]>>>({});
  const [dimOptsLoading, setDimOptsLoading] = useState<Partial<Record<Dim, boolean>>>({});

  const [qboFreshness, setQboFreshness] = useState<QboSyncFreshness | null | undefined>(undefined);
  const [marginHealth, setMarginHealth] = useState<MarginHealthIssue[] | null>(null);
  const [healthExpanded, setHealthExpanded] = useState(false);
  const [syncing, setSyncing] = useState(false);

  function loadQboFreshness() {
    fetchQboSyncFreshness()
      .then(setQboFreshness)
      .catch(() => setQboFreshness(null));
  }
  function loadSavedViews() {
    fetchSavedViews().then(setSavedViews).catch(() => setSavedViews([]));
  }
  useEffect(() => { loadQboFreshness(); loadSavedViews(); }, []);

  async function saveCurrentView() {
    const name = prompt('Save current Margin view as:', '');
    if (!name || !name.trim()) return;
    const config: SavedViewConfig = {
      dim,
      start: filters.start,
      end:   filters.end,
      entities:   filters.entities,
      categories: filters.categories,
      customers:  filters.customers,
      items:      filters.items,
      channels:   filters.channels,
      segments:   filters.segments,
      columnsByDim,
      showSparklines,
      chartKind,
      compareMode,
    };
    try {
      await insertSavedView({ name: name.trim(), config, is_shared: false });
      toast.success('Saved view: ' + name.trim());
      loadSavedViews();
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
    }
  }

  function applySavedView(id: string) {
    const v = savedViews.find((x) => x.id === id);
    if (!v) return;
    const c = v.config;
    setFilters({
      start: c.start ?? filters.start,
      end:   c.end ?? filters.end,
      entities:   c.entities ?? null,
      categories: c.categories ?? null,
      customers:  c.customers ?? null,
      items:      c.items ?? null,
      channels:   c.channels ?? null,
      segments:   c.segments ?? null,
    });
    if (c.dim) setDim(c.dim);
    if (c.compareMode) setCompareMode(c.compareMode);
    if (c.chartKind) setChartKind(c.chartKind);
    if (typeof c.showSparklines === 'boolean') setShowSparklines(c.showSparklines);
    if (c.columnsByDim) {
      setColumnsByDim(c.columnsByDim);
      saveSetting(KEYS.marginColumns, c.columnsByDim);
    }
    toast.info('Loaded view: ' + v.name);
  }

  async function removeSavedView(id: string, name: string) {
    if (!confirm('Delete saved view "' + name + '"?')) return;
    try {
      await deleteSavedView(id);
      toast.success('Deleted ' + name);
      loadSavedViews();
    } catch (e) {
      toast.error('Delete failed: ' + (e as Error).message);
    }
  }

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
        loadQboFreshness();
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

  const qboPrimaryAt = qboFreshness?.last_mv_refresh_at
    ?? qboFreshness?.last_invoice_sync_at
    ?? qboFreshness?.invoice_cache_at
    ?? qboFreshness?.item_cache_at
    ?? null;
  const qboWarnings = qboFreshness?.warnings?.filter(Boolean) ?? [];
  const qboStatusLabel = qboFreshness === undefined ? 'CHECKING'
    : qboFreshness == null ? 'UNKNOWN'
    : qboFreshness.status === 'warn' ? 'STALE' : 'LIVE';
  const qboStatusColor = qboFreshness === undefined || qboFreshness == null ? 'var(--mt)'
    : qboFreshness.status === 'warn' ? 'var(--am)' : 'var(--gn)';
  const qboFreshLabel = qboFreshness === undefined ? ''
    : qboFreshness == null ? 'unknown' : ageLabel(qboPrimaryAt);
  const qboFreshTitle = useMemo(() => {
    if (qboFreshness === undefined) return 'Checking QBO freshness';
    if (!qboFreshness) return 'QBO freshness check unavailable';
    const lines = [
      'QBO status: ' + qboStatusLabel,
      'Margin view refresh: ' + dateTimeLabel(qboFreshness.last_mv_refresh_at),
      'Invoice sync: ' + dateTimeLabel(qboFreshness.last_invoice_sync_at),
      'Line backfill: ' + dateTimeLabel(qboFreshness.last_line_backfill_at),
      'Invoice cache: ' + dateTimeLabel(qboFreshness.invoice_cache_at),
      'Item-cost cache: ' + dateTimeLabel(qboFreshness.item_cache_at),
      'Expense-cost cache: ' + dateTimeLabel(qboFreshness.expense_line_cache_at),
      'Recent QBO errors: ' + Number(qboFreshness.recent_qbo_errors || 0),
    ];
    if (qboWarnings.length > 0) lines.push('Warnings: ' + qboWarnings.join(' | '));
    return lines.join('\n');
  }, [qboFreshness, qboStatusLabel, qboWarnings]);

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
    let cancelled = false;
    fetchPlMarginSummary(effectiveFilters.start, effectiveFilters.end)
      .then((s) => { if (!cancelled) setPlSummary(s); })
      .catch(() => { if (!cancelled) setPlSummary(null); });
    return () => { cancelled = true; };
  }, [effectiveFilters.start, effectiveFilters.end]);

  useEffect(() => {
    let cancelled = false;
    setMarginHealth(null);
    fetchMarginDataHealth(effectiveFilters)
      .then((issues) => { if (!cancelled) setMarginHealth(issues ?? []); })
      .catch((err) => {
        if (!cancelled) {
          setMarginHealth([{
            issue_key: 'health_check_unavailable',
            severity: 'warn',
            title: 'Health check unavailable',
            detail: err instanceof Error ? err.message : 'Margin health could not be checked.',
            line_count: 0,
            revenue: null,
            sample_labels: ['Margin diagnostics'],
            action: 'Make sure the latest database migration has run.',
          }]);
        }
      });
    return () => { cancelled = true; };
  }, [JSON.stringify(effectiveFilters)]);

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
    const need = showSparklines || columnsNeedSparklines(extraColumns);
    if (!need || !rows || rows.length === 0 || dim === 'month') { setSparklines({}); return; }
    const keys = trailing12MonthKeys(effectiveFilters.end);
    const labels = rows.slice(0, 200).map((r) => r.dim_label);
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
  }, [showSparklines, dim, rows, JSON.stringify(effectiveFilters), extraColumns]);

  useEffect(() => {
    let cancelled = false;
    const ent = effectiveFilters.entities?.[0] ?? null;
    fetchOverheadPools(effectiveFilters.start, effectiveFilters.end, ent)
      .then((p) => { if (!cancelled) setOverheadPools(p ?? []); })
      .catch(() => { if (!cancelled) setOverheadPools([]); });
    return () => { cancelled = true; };
  }, [effectiveFilters.start, effectiveFilters.end, JSON.stringify(effectiveFilters.entities)]);

  useEffect(() => {
    const autoFetchDim = dim === 'customer' || dim === 'item';
    if (!rows || rows.length === 0 || (!autoFetchDim && !columnsNeedFetch(extraColumns))) {
      setEnrichment({}); setEnrichmentLoading(false); return;
    }
    let cancelled = false;
    setEnrichmentLoading(true);
    const labels = rows.slice(0, 500).map((r) => r.dim_label);
    sbrpc<DimMetaRow[]>('fn_dim_meta', { p_dim: dim, p_labels: labels })
      .then((rs) => {
        if (cancelled) return;
        const out: Record<string, Record<string, unknown>> = {};
        for (const r of rs) { if (r.dim_label) out[r.dim_label] = r.meta ?? {}; }
        setEnrichment(out); setEnrichmentLoading(false);
      })
      .catch(() => { if (cancelled) return; setEnrichment({}); setEnrichmentLoading(false); });
    return () => { cancelled = true; };
  }, [dim, rows, extraColumns]);

  function exportCsv() {
    if (!rows || rows.length === 0) return;
    const display = comparison ?? rows;
    const baseHeader = ['Dimension', 'Line count', 'Qty', 'Revenue', 'Est cost', 'Est margin', 'Margin %', 'Cost coverage %'];
    const cmpHeader = comparison ? ['Prior revenue', 'Δ revenue', 'Δ %'] : [];
    const extraHeader = extraColumns.map((c) => c.label);
    const header = [...baseHeader, ...cmpHeader, ...extraHeader];
    const rowCount = display.length;
    const overheadBasisTotals = effectiveOverheadPools.length > 0 && totals
      ? buildOverheadBasisTotals(display)
      : null;
    const data: (string | number | null)[][] = display.map((r) => {
      const cmp = (r as ComparisonRow).prior_revenue !== undefined ? (r as ComparisonRow) : null;
      const meta = enrichment[r.dim_label] ?? {};
      const oh = effectiveOverheadPools.length > 0 && totals
        ? computeOverheadFields(r, totals, rowCount, effectiveOverheadPools, overheadBasisTotals) : {};
      const spark = sparklines[r.dim_label];
      // Spread the typed row first so SalesPivotRow fields are preserved; meta/oh layer
      // in dynamic enrichment keys; double-cast through unknown to satisfy the strict
      // SalesPivotRow & Record<string, unknown> intersection type below.
      const row = {
        ...r, ...meta, ...oh, _spark12: spark,
      } as unknown as SalesPivotRow & Record<string, unknown>;
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
        r.cost_coverage_pct != null ? Number(r.cost_coverage_pct).toFixed(4) : '',
        ...(comparison && cmp ? [
          cmp.prior_revenue != null ? Number(cmp.prior_revenue).toFixed(2) : '',
          cmp.delta_revenue != null ? Number(cmp.delta_revenue).toFixed(2) : '',
          cmp.delta_pct != null ? Number(cmp.delta_pct).toFixed(4) : '',
        ] : []),
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

  function printDashboard() { toast.info('Opening print preview…'); setTimeout(() => window.print(), 250); }

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

  function filterToLabel(label: string) {
    const key = DRILL_FILTER[dim];
    if (!key) return;
    setFilters((cur) => {
      const existing = (cur[key] as string[] | null | undefined) ?? [];
      if (existing.includes(label)) return cur;
      return { ...cur, [key]: [...existing, label] };
    });
    toast.info(`Filtered ${dim} to "${label}"`);
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
      revenue: pct(totals.revenue, priorTotals.revenue),
      margin: pct(totals.est_margin, priorTotals.est_margin),
      customers: pct(totals.customer_count, priorTotals.customer_count),
      cost_coverage: pct(totals.cost_coverage_pct, priorTotals.cost_coverage_pct),
    };
  }, [totals, priorTotals]);

  const accent = useMemo(() => {
    if (totals?.cost_coverage_pct == null) return undefined;
    const v = Number(totals.cost_coverage_pct);
    return v >= 0.8 ? 'var(--gn)' : v >= 0.5 ? 'var(--am)' : 'var(--rd)';
  }, [totals]);

  const plCompatibleFilters = useMemo(() => {
    const keys: Array<keyof SalesFilters> = [
      'entities', 'categories', 'customers', 'items', 'channels', 'segments',
      'product_families', 'product_types',
      'exclude_customers', 'exclude_categories', 'exclude_items',
    ];
    return activeModifiers.length === 0 && keys.every((key) => {
      const value = effectiveFilters[key] as string[] | null | undefined;
      return !value || value.length === 0;
    });
  }, [activeModifiers.length, JSON.stringify(effectiveFilters)]);

  const usePlNetMargin = plCompatibleFilters && plSummary != null;
  const effectiveOverheadPools = useMemo<OverheadPoolTotal[]>(() => {
    if (!usePlNetMargin || !plSummary || !totals) return overheadPools;
    const lineGrossMargin = Number(totals.est_margin ?? 0);
    const targetNetMargin = Number(plSummary.net_margin ?? 0);
    const targetAdjustment = lineGrossMargin - targetNetMargin;
    const existingAdjustment = totalPoolAmount(overheadPools);
    const trueUp = targetAdjustment - existingAdjustment;
    if (!Number.isFinite(trueUp) || Math.abs(trueUp) < 0.5) return overheadPools;
    const months = Math.max(Number(plSummary.months || 1), 1);
    return [
      ...overheadPools,
      {
        pool_id: -900001,
        pool_name: 'P&L gross margin true-up',
        basis: 'revenue',
        entity: null,
        monthly_amount: trueUp / months,
        pool_total: trueUp,
        months,
      },
    ];
  }, [overheadPools, plSummary, totals, usePlNetMargin]);

  const totalOverhead = useMemo(() => totalPoolAmount(effectiveOverheadPools), [effectiveOverheadPools]);
  const showNetKpi = totals != null && (totalOverhead !== 0 || usePlNetMargin);
  const netMargin = usePlNetMargin && plSummary
    ? Number(plSummary.net_margin ?? 0)
    : totals ? Number(totals.est_margin ?? 0) - totalOverhead : null;
  const netMarginPct = usePlNetMargin && plSummary
    ? (plSummary.net_margin_pct != null ? Number(plSummary.net_margin_pct) : null)
    : totals && Number(totals.revenue ?? 0) > 0 && netMargin != null
      ? netMargin / Number(totals.revenue) : null;
  const netMarginSub = usePlNetMargin && plSummary
    ? (netMarginPct != null ? fp(netMarginPct) + ' QBO P&L net' : 'QBO P&L net') + ' · ' + fm(plSummary.operating_expenses) + ' expenses'
    : netMarginPct != null ? fp(netMarginPct) + ' net margin %' : undefined;
  const netMarginAccent = netMarginPct == null ? undefined
    : netMarginPct >= 0.2 ? 'var(--gn)'
    : netMarginPct >= 0   ? 'var(--am)' : 'var(--rd)';

  const pareto = useMemo(() => {
    if (!rows || rows.length < 5) return null;
    const sorted = [...rows].sort((a, b) => Number(b.revenue ?? 0) - Number(a.revenue ?? 0));
    const total = sorted.reduce((s, r) => s + Number(r.revenue ?? 0), 0);
    if (total <= 0) return null;
    let cum = 0; let count80 = sorted.length;
    for (let i = 0; i < sorted.length; i++) {
      cum += Number(sorted[i].revenue ?? 0);
      if (cum / total >= 0.8) { count80 = i + 1; break; }
    }
    return { countAt80: count80, totalRows: sorted.length, pctOfRows: count80 / sorted.length };
  }, [rows]);

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
    const hasOverhead   = effectiveOverheadPools.length > 0 && totals != null;
    const hasSparks     = Object.keys(sparklines).length > 0;
    if (!hasEnrichment && !hasOverhead && !hasSparks) return tableRows;
    const rowCount = tableRows.length;
    const overheadBasisTotals = hasOverhead
      ? buildOverheadBasisTotals(tableRows as SalesPivotRow[])
      : null;
    return (tableRows as Array<SalesPivotRow | ComparisonRow>).map((r) => {
      const meta = hasEnrichment ? (enrichment[r.dim_label] ?? {}) : {};
      const oh = hasOverhead ? computeOverheadFields(r, totals, rowCount, effectiveOverheadPools, overheadBasisTotals) : {};
      const spark = hasSparks ? sparklines[r.dim_label] : undefined;
      return { ...r, ...meta, ...oh, _spark12: spark };
    }) as typeof tableRows;
  }, [tableRows, enrichment, effectiveOverheadPools, totals, sparklines]);

  const activePreset = detectActivePreset(filters.start, filters.end, today);
  const compareLabel =
    compareMode === 'prior_period' ? 'vs prior period' :
    compareMode === 'prior_year'   ? 'vs same period last year' : '';

  const heroEntity = filters.entities?.[0] ?? null;
  const heroBrandLabel =
    heroEntity === 'AS' ? 'Alameda Soda Co.' :
    heroEntity === 'freeflow' || heroEntity === 'FF' ? 'FreeFlow' :
    heroEntity === 'brix' ? 'Brix Beverage' :
    'Brix Beverage · Alameda Soda Co.';

  return (
    <div>
      <div className="hero">
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flex: 1, minWidth: 0 }}>
          <EntityMark entity={heroEntity} size={88} className="hero-mark" />
          <div style={{ minWidth: 0 }}>
            <div className="hero-eyebrow">
              {heroBrandLabel}{activeModifiers.length > 0 ? ' · ' + activeModifiers.join(' + ') : ''}
            </div>
            <h1 className="hero-title">Margin</h1>
            <div className="hero-meta">
              {effectiveFilters.start} → {effectiveFilters.end}{compareLabel ? ` · ${compareLabel}` : ''}
              {enrichmentLoading ? ' · loading column data…' : ''}
              {showNetKpi ? (usePlNetMargin ? ` · QBO P&L net ${netMargin != null ? fm(netMargin) : '—'}` : ` · ${effectiveOverheadPools.length} OH pool${effectiveOverheadPools.length === 1 ? '' : 's'} (${fm(totalOverhead)})`) : ''}
              {qboWarnings.length > 0 ? ' · QBO warning: ' + qboWarnings[0] + (qboWarnings.length > 1 ? ` (+${qboWarnings.length - 1})` : '') : ''}
              {expandedRollup.perRollup.length > 0 && (
                ' · excluding: ' + expandedRollup.perRollup.map((r) =>
                  r.code + ' (' + r.matched_customers + 'c · ' + r.matched_items + 'i)'
                ).join(' + ')
              )}
              {pareto && ` · top ${pareto.countAt80} of ${pareto.totalRows} (${(pareto.pctOfRows * 100).toFixed(0)}%) drive 80% of revenue`}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flex: 'none' }}>
          <div className="hero-stamp" title={qboFreshTitle}>
            <span
              className="status-dot"
              aria-hidden="true"
              style={{ background: qboStatusColor, boxShadow: '0 0 0 0 ' + qboStatusColor }}
            />
            <span className="hero-stamp-label" style={{ color: qboStatusColor }}>{qboStatusLabel}</span>
            <span className="hero-stamp-divider">·</span>
            <span>QBO {qboFreshLabel || '—'}</span>
            {qboPrimaryAt && (
              <>
                <span className="hero-stamp-divider">·</span>
                <span className="hero-stamp-time">{dayjs(qboPrimaryAt).format('MMM D, h:mm A')}</span>
              </>
            )}
          </div>
          <button type="button" onClick={printDashboard} className="tb-btn tb-btn--primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Printer size={13} strokeWidth={2.4} aria-hidden="true" />
            <span>Print</span>
          </button>
        </div>
      </div>

      {totals == null && rows == null ? (<KpiRowSkeleton count={showNetKpi ? 5 : 4} />) : (
        <div className="gr" style={{
          gridTemplateColumns: showNetKpi ? 'repeat(5, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))',
          marginBottom: 18,
        }}>
          <KPICard title="Revenue" value={totals ? fm(totals.revenue) : '…'} deltaPct={kpiDeltas?.revenue ?? null}
            sub={totals ? fmtNum(totals.invoice_count) + ' invoices' : undefined} />
          <KPICard title="Est Margin" value={totals ? fm(totals.est_margin) : '…'} deltaPct={kpiDeltas?.margin ?? null}
            sub={totals ? fp(totals.margin_pct) + ' margin %' : undefined} />
          {showNetKpi && (
            <KPICard title="Net Margin" value={netMargin != null ? fm(netMargin) : '…'}
              sub={netMarginSub} accent={netMarginAccent} />
          )}
          <KPICard title="Customers" value={totals ? fmtNum(totals.customer_count) : '…'} deltaPct={kpiDeltas?.customers ?? null}
            sub={totals ? fmtNum(totals.item_count) + ' items' : undefined} />
          <KPICard title="Cost Coverage" value={totals ? fp(totals.cost_coverage_pct) : '…'} deltaPct={kpiDeltas?.cost_coverage ?? null}
            sub="% of revenue with item-cost data" accent={accent} />
        </div>
      )}

      <MarginHealthPanel
        issues={marginHealth}
        expanded={healthExpanded}
        onToggle={() => setHealthExpanded((v) => !v)}
        onSyncCosts={syncItemCosts}
        syncing={syncing}
      />

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
              onChange={onRangeChange} format="YYYY-MM-DD"
              localeText={{ start: 'From', end: 'To' }}
              slotProps={{
                textField: { size: 'small', sx: { width: 130, '& .MuiInputBase-root': { height: 30, fontFamily: 'var(--ff-mono)', fontSize: 12, background: 'var(--ctl-bg)', color: 'var(--tx)' }, '& .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--ctl-bd)' }, '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--ac)' } } },
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

          {savedViews.length > 0 && (
            <select
              onChange={(e) => { if (e.target.value) { applySavedView(e.target.value); e.target.value = ''; } }}
              className="tb-select"
              style={{ minWidth: 140, color: 'var(--ac)', fontWeight: 600 }}
              defaultValue=""
              title="Load a saved view"
            >
              <option value="" disabled>↓ Load saved view</option>
              {savedViews.map((v) => (
                <option key={v.id} value={v.id}>{v.name}{v.is_shared ? ' ★' : ''}</option>
              ))}
            </select>
          )}
          <button type="button" onClick={saveCurrentView} className="tb-btn"
            title="Save the current filters + dim + columns + compare mode as a named view"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <BookmarkPlus size={13} strokeWidth={2.4} aria-hidden="true" />
            <span>Save view</span>
          </button>
          {savedViews.length > 0 && (
            <button type="button" onClick={() => {
              if (savedViews.length === 0) return;
              const name = prompt('Delete which saved view? (paste the exact name)\n\nCurrent views:\n' + savedViews.map((v) => '• ' + v.name).join('\n'));
              if (!name) return;
              const match = savedViews.find((v) => v.name.toLowerCase() === name.toLowerCase().trim());
              if (!match) { toast.warn('No view named "' + name + '"'); return; }
              removeSavedView(match.id, match.name);
            }} className="tb-btn"
              title="Delete a saved view"
              style={{ color: 'var(--mt)' }}>
              <Bookmark size={13} strokeWidth={2.4} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="tb-btn" onClick={() => {
            const ytd = applyPreset('ytd', today);
            setFilters({ start: ytd.start, end: ytd.end, entities: null });
            setCompareMode('prior_year'); setChartKind('none'); setActiveModifiers([]);
          }}>Reset</button>
        </div>

        <div className="toolbar-row">
          <div className="toolbar-section">
            <span className="toolbar-label">Group by</span>
            <Autocomplete size="small" options={DIMS} getOptionLabel={(o) => o.label}
              isOptionEqualToValue={(o, v) => o.id === v.id}
              value={DIMS.find((d) => d.id === dim) ?? DIMS[0]}
              onChange={(_, v) => v && setDim(v.id)} disableClearable sx={ACX} slotProps={ACX_PAPER}
              renderInput={(params) => <TextField {...params} placeholder="Group by" />} />
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">Entity</span>
            <Autocomplete size="small" options={[null, ...entityOptions] as (string | null)[]}
              getOptionLabel={(o) => (o == null ? 'All entities' : o)}
              value={filters.entities?.[0] ?? null}
              onChange={(_, v) => onEntityChange(v)} sx={ACX} slotProps={ACX_PAPER}
              renderInput={(params) => <TextField {...params} placeholder="Entity" />} />
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">Chart</span>
            <Autocomplete size="small" options={CHART_KINDS}
              getOptionLabel={(o) => (o === 'none' ? 'None' : o[0].toUpperCase() + o.slice(1))}
              value={chartKind}
              onChange={(_, v) => v && setChartKind(v)} disableClearable
              sx={{ ...ACX, width: 120 }} slotProps={ACX_PAPER}
              renderInput={(params) => <TextField {...params} placeholder="Chart" />} />
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">Columns</span>
            <Autocomplete size="small" multiple limitTags={1} options={availableColumns}
              getOptionLabel={(o) => o.label}
              isOptionEqualToValue={(o, v) => o.id === v.id}
              groupBy={(o) => GROUP_LABEL[o.group]}
              value={extraColumns}
              onChange={(_, vs) => updateColumns(vs.map((v) => v.id))}
              disableCloseOnSelect sx={{ ...ACX, width: 240 }} slotProps={ACX_PAPER}
              renderInput={(params) => <TextField {...params} placeholder={extraColumns.length === 0 ? 'Add columns…' : ''} />} />
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

      {comparison && comparison.length > 0 && (
        <TopMoversStrip rows={comparison} dim={dim} onSelect={filterToLabel} />
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
            onRowClick={DRILL_NEXT[dim] ? drillInto : undefined}
            onDetailClick={(r) => setDetailRow(r)} />
        </div>
      )}

      <RowDetailModal
        open={detailRow !== null}
        onClose={() => setDetailRow(null)}
        row={detailRow}
        dim={dim}
        start={effectiveFilters.start}
        end={effectiveFilters.end}
      />
    </div>
  );
}
