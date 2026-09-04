import { useEffect, useMemo, useState } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { DataGridPro, type GridColDef, type GridGroupNode } from '@mui/x-data-grid-pro';
import { Search, X, ShoppingCart, Factory, PackageOpen, RefreshCw } from 'lucide-react';
import { KPICard } from '../components/KPICard';
import { InventoryLaneSelector } from '../components/InventoryLaneSelector';
import { fm, fmtNum } from '../lib/formatters';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../lib/styles';
import { downloadCsv, toCsv } from '../lib/csv';
import { KpiRowSkeleton, TableSkeleton } from '../components/Skeletons';
import {
  FillPlanRow, InventoryHealthRow, PlanningException, PlanningWeekRow, QboCustomerOption, VelocityExcludeRow,
  addVelocityExclude, fetchCustomerOptions, fetchFillPlan, fetchInventoryHealth, fetchPlanningExceptions,
  fetchPlanningWeekly, fetchVelocityExcludes, refreshPlanningExceptions, removeVelocityExclude, setPlanningException,
} from '../lib/inventory';
import { INVENTORY_LANE_LABEL, filterItemsByLane, useInventoryLane, type InventoryLane } from '../lib/inventoryLane';
import { useToast } from '../lib/toast';
import { GRID_SX as BASE_GRID_SX, GRID_DEFAULTS } from '../lib/gridStyles';

// "Inventory Planning" — analytics + buying companion to the operational
// "Inventory" page (formerly Stock). Operator mental model:
//   - Inventory          = where is it? what's coming? — operational
//   - Inventory Planning = what should we buy? how fast does it move? — analytics
// Purchase Orders tab lives on the operational page now.

type TabId = 'reorder' | 'forecast' | 'fill' | 'anomalies' | 'velocity' | 'excludes';

const TABS: { id: TabId; label: string }[] = [
  { id: 'reorder',   label: 'Reorder' },
  { id: 'forecast',  label: 'Forecast' },
  { id: 'fill',      label: 'Fill Plan' },
  { id: 'anomalies', label: 'Anomalies' },
  { id: 'velocity',  label: 'Velocity' },
  { id: 'excludes',  label: 'Velocity Excludes' },
];

const STATUS_COLOR: Record<string, string> = {
  reorder_now:  'var(--rd)', reorder_soon: 'var(--am)',
  healthy:      'var(--gn)', overstock:    '#a78bfa',
  no_velocity:  'var(--mt)', unmanaged:    'var(--mt)',
  reorder:      'var(--rd)', critical:     'var(--rd)',
  idle:         'var(--mt)', ok:           'var(--gn)',
  inactive:     '#64748b',
};

const REORDER_STATUSES = new Set(['reorder_now', 'reorder', 'reorder_soon', 'critical']);

const TABS_SX = {
  minHeight: 36, mb: 1.5, borderBottom: '1px solid var(--bd)',
  '& .MuiTabs-indicator': { background: 'var(--ac)', height: 2 },
  '& .MuiTab-root': {
    minHeight: 36, padding: '6px 18px', textTransform: 'uppercase',
    color: 'var(--mt)', fontSize: 11, fontWeight: 600, letterSpacing: 0.6, fontFamily: 'inherit',
  },
  '& .Mui-selected': { color: 'var(--ac) !important' },
};

// Shared grid skin + the tree-data grouping-toggle accent this page needs.
const GRID_SX = {
  ...BASE_GRID_SX,
  '& .MuiDataGrid-groupingCriteriaCellToggle': { color: 'var(--ac)' },
};

const INACTIVE_GROUP = 'INACTIVE';

function groupLabelFor(r: InventoryHealthRow): string {
  if (!r.active) return INACTIVE_GROUP;
  return r.category_resolved && r.category_resolved.trim() !== '' ? r.category_resolved : 'Uncategorized';
}
function getTreeDataPath(row: Record<string, unknown>): string[] {
  return [String(row.__group ?? INACTIVE_GROUP), String(row.qbo_item_id ?? '')];
}
const groupingColDef = {
  headerName: 'Category / Item', width: 360, hideDescendantCount: false,
  renderCell: (params: {
    rowNode: { type: string; groupingKey?: string | number | null };
    row: { item_name?: string };
  }) => {
    if (params.rowNode.type === 'group') {
      const key = params.rowNode.groupingKey;
      return <strong style={{ color: 'var(--ac)' }}>{key == null ? '—' : String(key)}</strong>;
    }
    return <span style={{ fontWeight: 600 }}>{String(params.row.item_name ?? '')}</span>;
  },
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function filterBySearch<T extends { item_name: string }>(rows: T[], q: string): T[] {
  if (!q.trim()) return rows;
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => r.item_name.toLowerCase().includes(needle));
}

function SearchInput({ value, onChange, placeholder = 'Search items…' }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', height: 30, borderRadius: 4,
      background: 'var(--ctl-bg)', border: '1px solid var(--ctl-bd)', minWidth: 240,
    }}>
      <Search size={13} strokeWidth={2.2} color="var(--mt)" aria-hidden="true" />
      <input type="text" value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: 'transparent', border: 'none', outline: 'none',
          color: 'var(--tx)', fontFamily: 'var(--ff-mono)', fontSize: 12,
          flex: 1, padding: 0,
        }} />
      {value && (
        <button onClick={() => onChange('')} aria-label="Clear search"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, display: 'inline-flex' }}>
          <X size={12} strokeWidth={2.4} color="var(--mt)" />
        </button>
      )}
    </div>
  );
}

export function InventoryPage() {
  const [tab, setTab] = useState<TabId>('reorder');
  const [lane, setLane] = useInventoryLane();
  const [lookback, setLookback] = useState(90);
  // Sky, 2026-09-04: only the BIB, 24-pack and 8-pack items need planning.
  // is_planner is exactly that set (migration 20260904g); the toggle is the
  // escape hatch for looking at anything else in the lane.
  const [plannerOnly, setPlannerOnly] = useState(true);
  const [rows, setRows] = useState<InventoryHealthRow[] | null>(null);

  function load() {
    setRows(null);
    fetchInventoryHealth({ lookback: Number(lookback) || 90, managed_only: false })
      .then(setRows).catch(() => setRows([]));
  }
  useEffect(load, [lookback]);

  const laneRows = useMemo(
    () => rows ? filterItemsByLane(rows, lane).filter((r) => !plannerOnly || r.is_planner) : null,
    [rows, lane, plannerOnly],
  );

  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? 'Inventory Planning';

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Reorder · Velocity · Health · Buying Signals</div>
          <h1 className="hero-title">Inventory Planning</h1>
          <div className="hero-meta">
            {tabLabel}
            {tab !== 'excludes' && tab !== 'fill' && tab !== 'anomalies' && ` · ${INVENTORY_LANE_LABEL[lane]} · ${lookback}-day lookback${plannerOnly ? ' · planner items' : ''}`}
          </div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          {rows ? fmtNum(rows.length) + ' items' : 'loading…'}
        </div>
      </div>

      <Tabs value={tab} onChange={(_, v) => setTab(v as TabId)} sx={TABS_SX}>
        {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
      </Tabs>

      {(tab === 'reorder' || tab === 'velocity' || tab === 'forecast') && (
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <div className="toolbar-row">
            <InventoryLaneSelector value={lane} onChange={setLane} />
            <div className="toolbar-section">
              <span className="toolbar-label">Velocity lookback</span>
              <input type="number" min={7} max={365} value={lookback}
                onChange={(e) => setLookback(Number(e.target.value) || 90)}
                className="date-input" style={{ width: 70 }} />
              <span style={{ color: 'var(--mt)', fontSize: 11 }}>days</span>
            </div>
            <label className="toolbar-section" style={{ cursor: 'pointer' }} title="The BIB, 24-pack and 8-pack finished goods — the items that get a lead time, a forecast and a reorder date">
              <input type="checkbox" checked={plannerOnly}
                onChange={(e) => setPlannerOnly(e.target.checked)}
                style={{ accentColor: 'var(--ac)' }} />
              <span className="toolbar-label">Planner items only</span>
            </label>
            <div className="toolbar-spacer" />
            <span style={{ fontSize: 10, color: 'var(--mt)', marginRight: 8 }}>
              Edit per-item settings in <strong style={{ color: 'var(--ac)' }}>Settings → Items</strong>
            </span>
            <button onClick={load} className="tb-btn">Refresh</button>
          </div>
        </div>
      )}

      {tab === 'reorder' && <ReorderTable rows={laneRows} lane={lane} />}
      {tab === 'forecast' && <ForecastTab rows={laneRows} />}
      {tab === 'fill' && <FillPlanTab />}
      {tab === 'anomalies' && <AnomaliesTab />}
      {tab === 'velocity' && <VelocityTable rows={laneRows} />}
      {tab === 'excludes' && <ExcludesTab />}
    </div>
  );
}

const DAY_MS = 86_400_000;
function daysFromToday(iso: string): number {
  const d = new Date(iso + 'T00:00:00');
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - t.getTime()) / DAY_MS);
}
function fmtDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A planning date: red once it is behind us, amber inside a week, plain otherwise. */
function DateCell({ value, kind }: { value: string | null | undefined; kind: 'order' | 'stockout' }) {
  if (!value) return <span style={{ color: 'var(--mt)' }}>—</span>;
  const days = daysFromToday(value);
  const late = days < 0;
  const soon = !late && days <= 7;
  const color = late ? 'var(--rd)' : soon ? 'var(--am)' : 'var(--tx)';
  const hint = late
    ? (kind === 'order' ? `${-days}d overdue` : 'out')
    : days === 0 ? 'today' : `${days}d`;
  return (
    <span style={{ color, fontWeight: late || soon ? 700 : 500 }} title={value}>
      {fmtDate(value)} <span style={{ fontSize: 9, color: late ? 'var(--rd)' : 'var(--mt)' }}>{hint}</span>
    </span>
  );
}

/** Year-over-year growth of the trailing 13 weeks against the aligned 13 weeks last year. */
function YoyCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span style={{ color: 'var(--mt)' }} title="No usable last-year window (fewer than 10 units)">—</span>;
  const v = Number(value);
  const color = Math.abs(v) < 5 ? 'var(--mt)' : v > 0 ? 'var(--gn)' : 'var(--am)';
  return <span style={{ color, fontWeight: Math.abs(v) >= 20 ? 700 : 500 }}>{v > 0 ? '+' : ''}{v.toFixed(0)}%</span>;
}

/** The trailing-28-day rate against the lookback average: +12% = selling faster lately. */
function TrendCell({ value }: { value: number | null | undefined }) {
  if (value == null) return <span style={{ color: 'var(--mt)' }}>—</span>;
  const v = Number(value);
  const color = Math.abs(v) < 10 ? 'var(--mt)' : v > 0 ? 'var(--gn)' : 'var(--am)';
  return <span style={{ color, fontWeight: Math.abs(v) >= 25 ? 700 : 500 }}>{v > 0 ? '+' : ''}{v.toFixed(0)}%</span>;
}

function ReorderTable({ rows, lane }: { rows: InventoryHealthRow[] | null; lane: InventoryLane }) {
  const [search, setSearch] = useState('');
  const toast = useToast();

  const reorder = useMemo(() => {
    if (!rows) return [];
    return rows
      .filter((r) => REORDER_STATUSES.has(r.status) || !r.active)
      .sort((a, b) => (a.order_by_date ?? '9999').localeCompare(b.order_by_date ?? '9999')
        || Number(a.days_of_cover ?? 999) - Number(b.days_of_cover ?? 999));
  }, [rows]);
  const filtered = useMemo(() => filterBySearch(reorder, search), [reorder, search]);

  const gridRows = useMemo(
    () => filtered.map((r) => ({ ...r, id: r.qbo_item_id, __group: groupLabelFor(r) })),
    [filtered],
  );

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'status', headerName: 'Status', width: 130,
      renderCell: (p) => {
        if (!p.value) return null;
        const c = STATUS_COLOR[p.value as string] ?? 'var(--mt)';
        return (
          <span style={{
            background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
            padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
          }}>{String(p.value).toUpperCase().replace('_', ' ')}</span>
        );
      },
    },
    { field: 'planning_on_hand', headerName: 'Planning On Hand', type: 'number', width: 140, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : fmtNum(Number(v))) },
    { field: 'brix_on_hand', headerName: 'BRIX On Hand', type: 'number', width: 120, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : fmtNum(Number(v))) },
    { field: 'qbo_on_hand', headerName: 'QBO On Hand', type: 'number', width: 115, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : fmtNum(Number(v))) },
    { field: 'on_hand_drift', headerName: 'Drift', type: 'number', width: 90, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return <span style={{ color: v === 0 ? 'var(--mt)' : (v > 0 ? 'var(--gn)' : 'var(--rd)'), fontWeight: v === 0 ? 500 : 700 }}>
          {v === 0 ? '—' : fmtNum(v)}
        </span>;
      } },
    { field: 'daily_velocity', headerName: 'Recent/day', type: 'number', width: 100, cellClassName: 'mn',
      description: 'What we are actually selling: 60% trailing 28 days, 40% the lookback',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
    { field: 'velocity_trend_pct', headerName: '28d trend', type: 'number', width: 90, cellClassName: 'mn',
      renderCell: (p) => <TrendCell value={p.value as number | null | undefined} /> },
    { field: 'forecast_daily', headerName: 'LY forecast/day', type: 'number', width: 120, cellClassName: 'mn',
      description: "Last year's units over the coming lead + target window (same weekday, holidays matched), grown by the YoY factor",
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
    { field: 'yoy_growth_pct', headerName: 'YoY', type: 'number', width: 80, cellClassName: 'mn',
      renderCell: (p) => <YoyCell value={p.value as number | null | undefined} /> },
    { field: 'planning_velocity', headerName: 'Plan rate/day', type: 'number', width: 110, cellClassName: 'mn',
      description: 'The rate the plan runs on: half recent, half last-year forecast',
      renderCell: (p) => <span style={{ fontWeight: 700 }}>{p.value == null ? '—' : Number(p.value).toFixed(2)}</span> },
    { field: 'days_of_cover', headerName: 'Cover (days)', type: 'number', width: 105, cellClassName: 'mn',
      description: '(sellable + inbound) ÷ plan rate',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(0)) },
    {
      field: 'qty_on_order', headerName: 'Inbound', type: 'number', width: 90, cellClassName: 'mn',
      description: 'Open PO lines + stock at the co-packer or in transit',
      renderCell: (p) => {
        const v = Number((p.row as InventoryHealthRow).qty_inbound ?? p.value ?? 0);
        return v > 0
          ? <span style={{ color: 'var(--gn)', fontWeight: 600 }}>{fmtNum(v)}</span>
          : <span style={{ color: 'var(--mt)' }}>—</span>;
      },
    },
    { field: 'safety_stock', headerName: 'Buffer', type: 'number', width: 80, cellClassName: 'mn',
      description: 'The cushion under the par: 95% service on the demand seen during one lead time, capped at one lead time of demand',
      valueFormatter: (v) => (v == null ? '—' : fmtNum(Math.round(Number(v)))) },
    { field: 'par_min', headerName: 'Par (min)', type: 'number', width: 95, cellClassName: 'mn',
      description: 'Order when sellable + inbound reaches this: buffer + lead time × plan rate (a reorder point typed in Settings → Items overrides it)',
      renderCell: (p) => <span style={{ fontWeight: 700 }}>{p.value == null ? '—' : fmtNum(Math.round(Number(p.value)))}</span> },
    { field: 'par_max', headerName: 'Par (max)', type: 'number', width: 95, cellClassName: 'mn',
      description: 'The level an order brings you back to: (target + lead) days × plan rate + buffer',
      renderCell: (p) => <span style={{ fontWeight: 700 }}>{p.value == null ? '—' : fmtNum(Math.round(Number(p.value)))}</span> },
    { field: 'order_by_date', headerName: 'Order by', width: 120,
      description: 'Stockout date − lead time − the days the safety stock covers',
      renderCell: (p) => <DateCell value={p.value as string | null} kind="order" /> },
    { field: 'stockout_date', headerName: 'Stockout', width: 120,
      description: 'When sellable + inbound runs out at the plan rate',
      renderCell: (p) => <DateCell value={p.value as string | null} kind="stockout" /> },
    { field: 'min_order_qty', headerName: 'Min order', type: 'number', width: 90, cellClassName: 'mn',
      description: 'Minimum order (Settings → Items). Seeded for BIB from the smallest quantity we have actually bought in 24 months',
      renderCell: (p) => {
        const r = p.row as InventoryHealthRow;
        const moq = Number(r.min_order_qty ?? 0);
        return <span style={{ color: moq > 0 ? undefined : 'var(--mt)' }} title={r.smallest_order_qty != null ? `Smallest order in 24 months: ${fmtNum(Number(r.smallest_order_qty))}` : 'No purchase history'}>
          {moq > 0 ? fmtNum(moq) : '—'}
        </span>;
      } },
    {
      field: 'suggested_order_qty', headerName: 'Suggested Qty', type: 'number', width: 120, cellClassName: 'mn',
      description: 'Par (max) − sellable − inbound when that is positive, floored at the minimum order; 0 when there is cover to spare',
      renderCell: (p) => (
        <span style={{ color: 'var(--ac)', fontWeight: 600 }}>{p.value != null ? fmtNum(Number(p.value)) : '—'}</span>
      ),
    },
  ], []);

  function exportCsv() {
    if (reorder.length === 0) return;
    const head = ['Item', 'Category', 'Lane', 'Active', 'Planning On Hand', 'BRIX On Hand', 'QBO On Hand', 'Drift', 'Inbound', 'Recent/day', 'LY forecast/day', 'YoY %', 'Plan rate/day', 'Days of Cover', 'Buffer', 'Par Min', 'Par Max', 'Min Order', 'Smallest Order 24m', 'Order By', 'Stockout', 'Suggested Order Qty', 'Status'];
    const data = reorder.map((r) => [
      r.item_name, r.category_resolved ?? '', r.inventory_lane ?? '', r.active ? 'yes' : 'no',
      r.planning_on_hand ?? r.on_hand ?? '', r.brix_on_hand ?? '', r.qbo_on_hand ?? '', r.on_hand_drift ?? '', r.qty_inbound ?? r.qty_on_order ?? '',
      r.daily_velocity != null ? Number(r.daily_velocity).toFixed(2) : '',
      r.forecast_daily != null ? Number(r.forecast_daily).toFixed(2) : '',
      r.yoy_growth_pct ?? '',
      r.planning_velocity != null ? Number(r.planning_velocity).toFixed(2) : '',
      r.days_of_cover != null ? Number(r.days_of_cover).toFixed(0) : '',
      r.safety_stock ?? '', r.par_min ?? r.reorder_point_calc ?? '', r.par_max ?? '', r.min_order_qty ?? '', r.smallest_order_qty ?? '', r.order_by_date ?? '', r.stockout_date ?? '',
      r.suggested_order_qty ?? '', r.status,
    ]);
    downloadCsv(`reorder_${new Date().toISOString().slice(0,10)}.csv`, toCsv([head, ...data]));
  }

  // The prediction becomes an order through the door that lane actually uses:
  //   BIB      → a purchase order (Production → Purchase Orders, prefilled)
  //   24-pack  → a work order per flavour (Production → Work Orders, a run queue)
  //   8-pack   → the repack sheet, cases prefilled (Stock → Repacks)
  // One button, three destinations — a BIB is bought, a case is made, an
  // 8-pack is repacked, and sending all three to a PO form would create a PO
  // for something Calderoni does not sell.
  function orderCandidates() {
    return (filtered.length > 0 ? filtered : reorder).filter(
      (r) => r.active && r.suggested_order_qty != null && Number(r.suggested_order_qty) > 0,
    );
  }
  function createOrderFromReorder() {
    if (lane === 'cans_24pk') return createWorkOrdersFromReorder();
    if (lane === 'cans_8pk') return createRepackFromReorder();
    return createPoFromReorder();
  }
  function createWorkOrdersFromReorder() {
    const candidates = orderCandidates();
    if (candidates.length === 0) return;
    sessionStorage.setItem('brix.wo.prefill', JSON.stringify({
      source: 'inventory-reorder',
      generated_at: new Date().toISOString(),
      runs: candidates.map((r) => ({ qbo_item_id: r.qbo_item_id, item_name: r.item_name, qty: Number(r.suggested_order_qty) })),
    }));
    window.location.hash = '#production?tab=work_orders';
  }
  function createRepackFromReorder() {
    const candidates = orderCandidates();
    if (candidates.length === 0) return;
    sessionStorage.setItem('brix.repack.prefill', JSON.stringify({
      source: 'inventory-reorder',
      generated_at: new Date().toISOString(),
      packs: candidates.map((r) => ({ qbo_item_id: r.qbo_item_id, item_name: r.item_name, qty: Number(r.suggested_order_qty) })),
    }));
    toast.info(`${candidates.length} flavour${candidates.length === 1 ? '' : 's'} sent to the repack sheet as cases to repack`);
    window.location.hash = '#stock';
  }
  function createPoFromReorder() {
    const candidates = orderCandidates();
    if (candidates.length === 0) return;
    const prefill = candidates.map((r) => ({
      qbo_item_id: r.qbo_item_id,
      item_name: r.item_name,
      qty_ordered: Number(r.suggested_order_qty),
      unit_cost: r.purchase_cost ?? 0,
      default_receiving_location_id: r.default_receiving_location_id ?? null,
    }));
    sessionStorage.setItem('brix.po.prefill', JSON.stringify({
      source: 'inventory-reorder',
      generated_at: new Date().toISOString(),
      inventory_lane: lane,
      lines: prefill,
    }));
    window.location.hash = '#production?tab=purchase_orders';
  }

  function printOrderSheet() {
    const printable = reorder.filter((r) => r.active);
    if (printable.length === 0) return;
    const w = window.open('', '_blank');
    if (!w) return;
    const tableRows = printable.map((r) => `<tr><td>${escapeHtml(r.item_name)}</td><td style="text-align:right">${r.planning_on_hand ?? r.on_hand ?? '—'}</td><td style="text-align:right">${r.daily_velocity != null ? Number(r.daily_velocity).toFixed(2) : '—'}</td><td style="text-align:right">${r.days_of_supply != null ? Number(r.days_of_supply).toFixed(0) : '—'}</td><td style="text-align:right;font-weight:600">${r.suggested_order_qty ?? '—'}</td><td>${r.status}</td><td>      </td></tr>`).join('');
    w.document.write(`<html><head><title>Reorder Sheet</title><style>body{font-family:system-ui,-apple-system,sans-serif;color:#0a0e17;max-width:980px;margin:24px auto;padding:0 24px}h1{font-size:18px;border-bottom:2px solid #0ea5b8;padding-bottom:6px}table{width:100%;border-collapse:collapse;font-size:11px;margin-top:12px}td,th{padding:5px 8px;border-bottom:1px solid #e2e8f0;text-align:left}th{background:#f1f5f9;font-size:9px;text-transform:uppercase;letter-spacing:1px}@media print{body{margin:0}}</style></head><body><h1>Reorder Sheet — ${new Date().toISOString().slice(0,10)}</h1><div style="font-size:10px;color:#64748b">${printable.length} items below threshold (active only)</div><table><thead><tr><th>Item</th><th style="text-align:right">Planning On Hand</th><th style="text-align:right">Velocity/day</th><th style="text-align:right">Days Supply</th><th style="text-align:right">Suggested Qty</th><th>Status</th><th>Order Qty</th></tr></thead><tbody>${tableRows}</tbody></table><script>setTimeout(function(){window.print()},350);</script></body></html>`);
    w.document.close();
  }

  if (!rows) return (
    <>
      <KpiRowSkeleton count={4} />
      <div className="cd" style={{ padding: 0 }}><TableSkeleton rows={8} cols={7} /></div>
    </>
  );

  const reorderNow  = rows.filter((r) => r.active && (r.status === 'reorder_now' || r.status === 'reorder' || r.status === 'critical'));
  const reorderSoon = rows.filter((r) => r.active && r.status === 'reorder_soon');
  const healthy     = rows.filter((r) => r.active && (r.status === 'healthy' || r.status === 'ok'));
  const overstock   = rows.filter((r) => r.active && r.status === 'overstock');
  const inactiveCount = rows.filter((r) => !r.active).length;
  const onOrderTotal = rows.reduce((s, r) => s + Number(r.qty_on_order ?? 0), 0);

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 14 }}>
        <KPICard title="REORDER NOW" value={reorderNow.length} accent="var(--rd)" sub="at or past the reorder point — the order is already late" />
        <KPICard title="REORDER SOON" value={reorderSoon.length} accent="var(--am)" sub="crosses the reorder point within 7 days" />
        <KPICard title="ON ORDER" value={fmtNum(onOrderTotal)} accent="var(--gn)" sub="open PO units pending" />
        <KPICard title="OVERSTOCK" value={overstock.length} accent="#a78bfa" sub={`${healthy.length} healthy · ${inactiveCount} inactive`} />
      </div>

      <div className="cd" style={{
        padding: '10px 12px', marginBottom: 14, display: 'flex',
        gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11,
      }}>
        <SearchInput value={search} onChange={setSearch} />
        <span style={{ color: 'var(--mt)', marginLeft: 6 }}>
          {filtered.length} of {reorder.length} items
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            onClick={createOrderFromReorder}
            disabled={reorder.length === 0}
            style={btnPrimary()}
            title={lane === 'cans_24pk'
              ? 'Open Production → Work Orders with a run queued per flavour at the suggested quantity'
              : lane === 'cans_8pk'
                ? 'Open the repack sheet with the cases to repack prefilled (3 packs a case)'
                : 'Open Production → Purchase Orders pre-filled with these items'}
          >
            {lane === 'cans_24pk' ? <Factory size={11} style={{ marginRight: 4, verticalAlign: -1 }} />
              : lane === 'cans_8pk' ? <PackageOpen size={11} style={{ marginRight: 4, verticalAlign: -1 }} />
              : <ShoppingCart size={11} style={{ marginRight: 4, verticalAlign: -1 }} />}
            {lane === 'cans_24pk' ? 'CREATE WORK ORDERS' : lane === 'cans_8pk' ? 'OPEN REPACK SHEET' : 'CREATE PO'}
          </button>
          <button onClick={printOrderSheet} disabled={reorder.length === 0} style={btnSecondary()}>PRINT ORDER SHEET</button>
          <button onClick={exportCsv} disabled={reorder.length === 0} style={btnSecondary()}>EXPORT CSV</button>
        </span>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        {filtered.length === 0 ? (
          <div className="ld">No items match.</div>
        ) : (
          <DataGridPro
            rows={gridRows} columns={columns}
            treeData getTreeDataPath={getTreeDataPath}
            groupingColDef={groupingColDef}
            density="compact" pagination disableRowSelectionOnClick
            pageSizeOptions={[10, 20, 40, 60, 100, { value: -1, label: 'All' }]}
            defaultGroupingExpansionDepth={1}
            initialState={{
              pagination: { paginationModel: { pageSize: 60, page: 0 } },
              sorting: { sortModel: [{ field: 'order_by_date', sort: 'asc' }] },
            }}
            isGroupExpandedByDefault={(node: GridGroupNode) => node.groupingKey !== INACTIVE_GROUP}
            {...GRID_DEFAULTS}
            sx={GRID_SX}
          />
        )}
      </div>
    </div>
  );
}

function VelocityTable({ rows }: { rows: InventoryHealthRow[] | null }) {
  const [search, setSearch] = useState('');

  const sorted = useMemo(
    () => rows ? [...rows].sort((a, b) => Number(b.sold_revenue ?? 0) - Number(a.sold_revenue ?? 0)) : null,
    [rows],
  );
  const filtered = useMemo(() => sorted ? filterBySearch(sorted, search) : [], [sorted, search]);

  const gridRows = useMemo(
    () => filtered.map((r) => ({ ...r, id: r.qbo_item_id, __group: groupLabelFor(r) })),
    [filtered],
  );

  const columns: GridColDef[] = useMemo(() => [
    { field: 'sold_qty', headerName: 'Sold Qty', type: 'number', width: 100, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)) },
    {
      field: 'sold_revenue', headerName: 'Sold Rev', type: 'number', width: 130, cellClassName: 'mn',
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{fm(Number(p.value ?? 0))}</span>,
    },
    { field: 'customers_count', headerName: 'Customers', type: 'number', width: 100, cellClassName: 'mn' },
    { field: 'planning_on_hand', headerName: 'Planning On Hand', type: 'number', width: 140, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : fmtNum(Number(v))) },
    { field: 'on_hand_drift', headerName: 'Drift', type: 'number', width: 90, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return <span style={{ color: v === 0 ? 'var(--mt)' : (v > 0 ? 'var(--gn)' : 'var(--rd)') }}>
          {v === 0 ? '—' : fmtNum(v)}
        </span>;
      } },
    { field: 'purchased_qty', headerName: 'Purchased', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)) },
    {
      field: 'qty_on_order', headerName: 'On Order', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return v > 0
          ? <span style={{ color: 'var(--gn)', fontWeight: 600 }}>{fmtNum(v)}</span>
          : <span style={{ color: 'var(--mt)' }}>—</span>;
      },
    },
    {
      field: 'adjustment_qty', headerName: 'Adj Qty', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return <span style={{ color: v < 0 ? 'var(--rd)' : 'var(--mt)' }}>{fmtNum(v)}</span>;
      },
    },
    {
      field: 'shrinkage_qty', headerName: 'Shrink', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => (
        <span style={{ color: 'var(--rd)' }}>{p.value != null ? fmtNum(Number(p.value)) : '—'}</span>
      ),
    },
    { field: 'consumed_qty', headerName: 'Used in runs/repacks', type: 'number', width: 150, cellClassName: 'mn',
      valueFormatter: (v) => (v == null || Number(v) === 0 ? '—' : fmtNum(Number(v))) },
    { field: 'daily_velocity', headerName: 'Recent/day', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
    { field: 'velocity_trend_pct', headerName: '28d trend', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => <TrendCell value={p.value as number | null | undefined} /> },
    { field: 'forecast_daily', headerName: 'LY forecast/day', type: 'number', width: 120, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
    { field: 'yoy_growth_pct', headerName: 'YoY', type: 'number', width: 80, cellClassName: 'mn',
      renderCell: (p) => <YoyCell value={p.value as number | null | undefined} /> },
    { field: 'planning_velocity', headerName: 'Plan rate/day', type: 'number', width: 110, cellClassName: 'mn',
      renderCell: (p) => <span style={{ fontWeight: 700 }}>{p.value == null ? '—' : Number(p.value).toFixed(2)}</span> },
    { field: 'days_of_supply', headerName: 'Days Supply', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(0)) },
    { field: 'days_of_cover', headerName: 'Cover w/ inbound', type: 'number', width: 130, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(0)) },
  ], []);

  if (!sorted) return <div className="cd" style={{ padding: 0 }}><TableSkeleton rows={10} cols={9} /></div>;

  return (
    <div>
      <div className="cd" style={{
        padding: '10px 12px', marginBottom: 14, display: 'flex',
        gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11,
      }}>
        <SearchInput value={search} onChange={setSearch} />
        <span style={{ color: 'var(--mt)', marginLeft: 6 }}>
          {filtered.length} of {sorted.length} items
        </span>
      </div>
      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        {filtered.length === 0 ? (
          <div className="ld">No items match.</div>
        ) : (
          <DataGridPro
            rows={gridRows} columns={columns}
            treeData getTreeDataPath={getTreeDataPath}
            groupingColDef={groupingColDef}
            density="compact" pagination disableRowSelectionOnClick
            pageSizeOptions={[10, 20, 40, 60, 100, { value: -1, label: 'All' }]}
            defaultGroupingExpansionDepth={1}
            initialState={{
              pagination: { paginationModel: { pageSize: 60, page: 0 } },
              sorting: { sortModel: [{ field: 'sold_revenue', sort: 'desc' }] },
            }}
            isGroupExpandedByDefault={(node: GridGroupNode) => node.groupingKey !== INACTIVE_GROUP}
            {...GRID_DEFAULTS}
            sx={GRID_SX}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Forecast — the planner's reasoning, per item: what last year did over the
 * coming window, how this year is trending against it, the rate the plan runs
 * on, and the two dates that come out of it. Pick a row for the week-by-week
 * comparison (same weekday last year; a week holding a holiday is matched to
 * last year's holiday week, so Labor Day compares to Labor Day).
 */
function ForecastTab({ rows }: { rows: InventoryHealthRow[] | null }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<InventoryHealthRow | null>(null);
  const [weeks, setWeeks] = useState<PlanningWeekRow[] | null>(null);
  const [weeksErr, setWeeksErr] = useState<string | null>(null);

  const planner = useMemo(
    () => rows ? rows.filter((r) => r.is_planner && r.active).sort((a, b) => (a.order_by_date ?? '9999').localeCompare(b.order_by_date ?? '9999')) : null,
    [rows],
  );
  const filtered = useMemo(() => planner ? filterBySearch(planner, search) : [], [planner, search]);
  const gridRows = useMemo(() => filtered.map((r) => ({ ...r, id: r.qbo_item_id })), [filtered]);

  useEffect(() => {
    if (!selected) { setWeeks(null); return; }
    let live = true;
    setWeeks(null); setWeeksErr(null);
    fetchPlanningWeekly(selected.qbo_item_id, 13, 8)
      .then((w) => { if (live) setWeeks(w); })
      .catch((e) => { if (live) setWeeksErr((e as Error).message); });
    return () => { live = false; };
  }, [selected]);

  const columns: GridColDef[] = useMemo(() => [
    { field: 'item_name', headerName: 'Item', flex: 1, minWidth: 240,
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{p.value as string}</span> },
    { field: 'planning_on_hand', headerName: 'Sellable', type: 'number', width: 90, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : fmtNum(Number(v))) },
    { field: 'qty_inbound', headerName: 'Inbound', type: 'number', width: 85, cellClassName: 'mn',
      valueFormatter: (v) => (v == null || Number(v) === 0 ? '—' : fmtNum(Number(v))) },
    { field: 'daily_velocity', headerName: 'Recent/day', type: 'number', width: 100, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
    { field: 'ly_window_qty', headerName: 'LY same window', type: 'number', width: 130, cellClassName: 'mn',
      description: "Last year's units over the coming lead + target window, aligned by weekday and holiday",
      renderCell: (p) => {
        const r = p.row as InventoryHealthRow;
        if (r.ly_window_qty == null) return <span style={{ color: 'var(--mt)' }} title="No last-year data for this window">—</span>;
        return <span>{fmtNum(Number(r.ly_window_qty))} <span style={{ fontSize: 9, color: 'var(--mt)' }}>/ {r.forecast_window_days}d</span></span>;
      } },
    { field: 'yoy_growth_pct', headerName: 'YoY', type: 'number', width: 80, cellClassName: 'mn',
      description: 'Trailing 13 weeks this year vs the same weeks last year',
      renderCell: (p) => <YoyCell value={p.value as number | null | undefined} /> },
    { field: 'forecast_daily', headerName: 'LY forecast/day', type: 'number', width: 120, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
    { field: 'planning_velocity', headerName: 'Plan rate/day', type: 'number', width: 110, cellClassName: 'mn',
      renderCell: (p) => <span style={{ fontWeight: 700 }}>{p.value == null ? '—' : Number(p.value).toFixed(2)}</span> },
    { field: 'lead_time_days', headerName: 'Lead', type: 'number', width: 70, cellClassName: 'mn',
      valueFormatter: (v) => `${v}d` },
    { field: 'safety_stock', headerName: 'Buffer', type: 'number', width: 80, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : fmtNum(Math.round(Number(v)))) },
    { field: 'par_min', headerName: 'Par (min)', type: 'number', width: 95, cellClassName: 'mn',
      renderCell: (p) => <span style={{ fontWeight: 700 }}>{p.value == null ? '—' : fmtNum(Math.round(Number(p.value)))}</span> },
    { field: 'par_max', headerName: 'Par (max)', type: 'number', width: 95, cellClassName: 'mn',
      renderCell: (p) => <span style={{ fontWeight: 700 }}>{p.value == null ? '—' : fmtNum(Math.round(Number(p.value)))}</span> },
    { field: 'order_by_date', headerName: 'Order by', width: 120,
      renderCell: (p) => <DateCell value={p.value as string | null} kind="order" /> },
    { field: 'stockout_date', headerName: 'Stockout', width: 120,
      renderCell: (p) => <DateCell value={p.value as string | null} kind="stockout" /> },
    { field: 'suggested_order_qty', headerName: 'Suggested', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => <span style={{ color: 'var(--ac)', fontWeight: 600 }}>{p.value != null && Number(p.value) > 0 ? fmtNum(Number(p.value)) : '—'}</span> },
    { field: 'status', headerName: 'Status', width: 120,
      renderCell: (p) => {
        const c = STATUS_COLOR[p.value as string] ?? 'var(--mt)';
        return <span style={{ color: c, fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>{String(p.value).toUpperCase().replace('_', ' ')}</span>;
      } },
  ], []);

  if (!planner) return <div className="cd" style={{ padding: 0 }}><TableSkeleton rows={10} cols={9} /></div>;

  const lateCount = planner.filter((r) => r.order_by_date && daysFromToday(r.order_by_date) < 0).length;
  const weekCount = planner.filter((r) => r.order_by_date && daysFromToday(r.order_by_date) >= 0 && daysFromToday(r.order_by_date) <= 7).length;
  const noLy = planner.filter((r) => r.forecast_daily == null).length;

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 14 }}>
        <KPICard title="ORDER TODAY" value={lateCount} accent="var(--rd)" sub="order-by date is behind us" />
        <KPICard title="ORDER THIS WEEK" value={weekCount} accent="var(--am)" sub="order-by date within 7 days" />
        <KPICard title="WITH LAST-YEAR FORECAST" value={planner.length - noLy} accent="var(--gn)" sub={`${noLy} on recent rate only (no last-year window)`} />
        <KPICard title="PLANNER ITEMS" value={planner.length} accent="var(--ac)" sub="BIB · 24-pack · 8-pack in this lane" />
      </div>

      <div className="cd" style={{ padding: '10px 12px', marginBottom: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11 }}>
        <SearchInput value={search} onChange={setSearch} />
        <span style={{ color: 'var(--mt)', marginLeft: 6 }}>{filtered.length} of {planner.length} items · pick a row for the week-by-week view</span>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
        {filtered.length === 0 ? (
          <div className="ld">No planner items in this lane. Set "In planner" on the item in Settings → Items.</div>
        ) : (
          <DataGridPro
            rows={gridRows} columns={columns}
            density="compact" pagination disableRowSelectionOnClick={false}
            onRowClick={(p) => setSelected(p.row as InventoryHealthRow)}
            pageSizeOptions={[10, 20, 40, 60, 100, { value: -1, label: 'All' }]}
            initialState={{
              pagination: { paginationModel: { pageSize: 60, page: 0 } },
              sorting: { sortModel: [{ field: 'order_by_date', sort: 'asc' }] },
            }}
            {...GRID_DEFAULTS}
            sx={{ ...GRID_SX, '& .MuiDataGrid-row': { cursor: 'pointer' } }}
          />
        )}
      </div>

      {selected && (
        <div className="cd" style={{ padding: 0 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bd)', display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div className="ct" style={{ margin: 0 }}>{selected.item_name}</div>
            <span style={{ fontSize: 10, color: 'var(--mt)' }}>
              Last 13 weeks against the same weeks last year, then the next 8 weeks as last year × growth.
              A week with a holiday is matched to last year's holiday week, not the same calendar week.
              {selected.yoy_growth_pct != null && <> Growth applied: <strong>{Number(selected.yoy_growth_pct) > 0 ? '+' : ''}{Number(selected.yoy_growth_pct).toFixed(1)}%</strong>.</>}
            </span>
            <button onClick={() => setSelected(null)} style={{ ...btnSecondary(), marginLeft: 'auto' }}>Close</button>
          </div>
          {weeksErr ? (
            <div className="ld" style={{ color: 'var(--rd)' }}>{weeksErr}</div>
          ) : !weeks ? (
            <div className="ld">Loading weeks…</div>
          ) : (
            <table style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Week of</th><th>Holiday</th>
                  <th style={{ textAlign: 'right' }}>Last year</th>
                  <th style={{ textAlign: 'right' }}>This year</th>
                  <th style={{ textAlign: 'right' }}>vs LY</th>
                  <th style={{ textAlign: 'right' }}>Forecast</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => {
                  const ty = w.this_year_qty == null ? null : Number(w.this_year_qty);
                  const ly = Number(w.last_year_qty);
                  const diff = ty == null || ly === 0 ? null : (ty - ly) / ly * 100;
                  const rowBg = w.is_current ? 'rgba(14,165,184,0.08)' : w.is_future ? 'rgba(255,255,255,0.02)' : undefined;
                  return (
                    <tr key={w.week_start} style={{ background: rowBg }}>
                      <td style={{ fontWeight: w.is_current ? 700 : 500 }}>
                        {fmtDate(w.week_start)}
                        {w.is_current && <span style={{ fontSize: 9, color: 'var(--ac)', marginLeft: 6 }}>THIS WEEK</span>}
                        {w.is_future && <span style={{ fontSize: 9, color: 'var(--mt)', marginLeft: 6 }}>ahead</span>}
                      </td>
                      <td style={{ fontSize: 10, color: 'var(--am)' }}>{w.holiday ?? ''}</td>
                      <td className="mn" style={{ textAlign: 'right', color: 'var(--mt)' }}>{fmtNum(ly)}</td>
                      <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{ty == null ? '—' : fmtNum(ty)}{w.is_current && ty != null ? <span style={{ fontSize: 9, color: 'var(--mt)' }}> so far</span> : null}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>
                        {diff == null ? <span style={{ color: 'var(--mt)' }}>—</span>
                          : <span style={{ color: Math.abs(diff) < 10 ? 'var(--mt)' : diff > 0 ? 'var(--gn)' : 'var(--am)' }}>{diff > 0 ? '+' : ''}{diff.toFixed(0)}%</span>}
                      </td>
                      <td className="mn" style={{ textAlign: 'right', color: 'var(--ac)', fontWeight: w.is_future ? 700 : 500 }}>
                        {w.forecast_qty == null ? '' : fmtNum(Math.round(Number(w.forecast_qty)))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ── Fill plan: cylinders we fill, not stock ─────────────────────────────
function FillPlanTab() {
  const [rows, setRows] = useState<FillPlanRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetchFillPlan(8, 3).then(setRows).catch((e) => { setErr((e as Error).message); setRows([]); });
  }, []);
  if (!rows) return <div className="cd" style={{ padding: 0 }}><TableSkeleton rows={8} cols={7} /></div>;
  if (err) return <div className="cd" style={{ padding: 16, color: 'var(--rd)' }}>{err}</div>;
  const items = Array.from(new Map(rows.map((r) => [r.qbo_item_id, r.label])).entries());
  const nextWeek = rows.filter((r) => r.is_future).reduce<Record<string, FillPlanRow>>((acc, r) => {
    if (!acc[r.qbo_item_id] || r.week_start < acc[r.qbo_item_id].week_start) acc[r.qbo_item_id] = r;
    return acc;
  }, {});
  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 14 }}>
        {items.map(([id, label]) => {
          const n = nextWeek[id];
          return <KPICard key={id} title={label.toUpperCase()} value={n?.weekly_par != null ? fmtNum(Number(n.weekly_par)) : '—'} accent="var(--ac)"
            sub={n ? `tanks to have filled for the week of ${fmtDate(n.week_start)} · forecast ${n.forecast_qty ?? '—'}${n.holiday ? ` · ${n.holiday}` : ''}` : 'no forecast'} />;
        })}
      </div>
      <div className="cd" style={{ padding: '10px 12px', marginBottom: 14, fontSize: 11, color: 'var(--mt)', lineHeight: 1.5 }}>
        We do not stock these — we fill them. <strong>Weekly par</strong> is the number of tanks to have filled before the week starts:
        the forecast (half the last 8 weeks' average, half last year's aligned week grown by the trend) plus a buffer of 1.65 × the weekly
        swing. Items live in <code>ops.planning_fill_items</code>; sampling and lapsed customers are already out.
      </div>
      {items.map(([id, label]) => {
        const mine = rows.filter((r) => r.qbo_item_id === id);
        return (
          <div key={id} className="cd" style={{ padding: 0, marginBottom: 14 }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--bd)' }} className="ct">{label}</div>
            <table style={{ width: '100%' }}>
              <thead><tr>
                <th>Week of</th><th>Holiday</th>
                <th style={{ textAlign: 'right' }}>Last year</th>
                <th style={{ textAlign: 'right' }}>This year</th>
                <th style={{ textAlign: 'right' }}>Forecast</th>
                <th style={{ textAlign: 'right' }}>Weekly par</th>
              </tr></thead>
              <tbody>
                {mine.map((w) => {
                  const rowBg = w.is_current ? 'rgba(14,165,184,0.08)' : w.is_future ? 'rgba(255,255,255,0.02)' : undefined;
                  return (
                    <tr key={w.week_start} style={{ background: rowBg }}>
                      <td style={{ fontWeight: w.is_current ? 700 : 500 }}>
                        {fmtDate(w.week_start)}
                        {w.is_current && <span style={{ fontSize: 9, color: 'var(--ac)', marginLeft: 6 }}>THIS WEEK</span>}
                        {w.is_future && <span style={{ fontSize: 9, color: 'var(--mt)', marginLeft: 6 }}>ahead</span>}
                      </td>
                      <td style={{ fontSize: 10, color: 'var(--am)' }}>{w.holiday ?? ''}</td>
                      <td className="mn" style={{ textAlign: 'right', color: 'var(--mt)' }}>{w.last_year_qty == null ? '—' : fmtNum(Number(w.last_year_qty))}</td>
                      <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{w.this_year_qty == null ? '—' : fmtNum(Number(w.this_year_qty))}{w.is_current && w.this_year_qty != null ? <span style={{ fontSize: 9, color: 'var(--mt)' }}> so far</span> : null}</td>
                      <td className="mn" style={{ textAlign: 'right', color: 'var(--ac)' }}>{w.forecast_qty == null ? '' : fmtNum(Number(w.forecast_qty))}</td>
                      <td className="mn" style={{ textAlign: 'right', fontWeight: 700 }}>{w.weekly_par == null ? '' : fmtNum(Number(w.weekly_par))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ── Anomalies: what the baseline leaves out, and why ────────────────────
function describeEvidence(x: PlanningException): string {
  const e = x.evidence as Record<string, unknown>;
  if (x.kind === 'lapsed_customer') {
    const items = Array.isArray(e.items) ? (e.items as { ly_qty?: number; ly_share_pct?: number }[]) : [];
    const top = items[0];
    return `last order ${e.last_order ?? '?'} (${e.days_silent ?? '?'} days ago)${top ? ` · ${fmtNum(Number(top.ly_qty ?? 0))} units last year, ${top.ly_share_pct ?? '?'}% of the item` : ''}`;
  }
  if (x.kind === 'volume_spike') {
    return `${fmtNum(Number(e.qty ?? 0))} in one week · their normal week ${e.customer_median_week ?? '?'} · the item's normal week ${e.item_median_week ?? '?'}`;
  }
  return x.note ?? '';
}

function AnomaliesTab() {
  const [rows, setRows] = useState<PlanningException[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  function load() {
    fetchPlanningExceptions().then(setRows).catch((e) => { setErr((e as Error).message); setRows([]); });
  }
  useEffect(load, []);

  async function refresh() {
    setBusy(true);
    try {
      const r = await refreshPlanningExceptions();
      toast.success(`Detector ran: ${r.lapsed} lapsed customer${r.lapsed === 1 ? '' : 's'}, ${r.spikes} volume spike${r.spikes === 1 ? '' : 's'}${r.cleared ? `, ${r.cleared} cleared` : ''}`);
      load();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  }
  async function decide(x: PlanningException, status: 'excluded' | 'kept') {
    try { await setPlanningException(x.id, status); load(); }
    catch (e) { toast.error((e as Error).message); }
  }

  if (!rows) return <div className="cd" style={{ padding: 0 }}><TableSkeleton rows={8} cols={6} /></div>;
  const excluded = rows.filter((r) => r.status === 'excluded');
  const lapsed = excluded.filter((r) => r.kind === 'lapsed_customer').length;
  const spikes = excluded.filter((r) => r.kind === 'volume_spike').length;
  const kept = rows.filter((r) => r.status === 'kept').length;

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 14 }}>
        <KPICard title="LAPSED CUSTOMERS" value={lapsed} accent="var(--rd)" sub="bought ≥10% of an item last year, nothing in 120 days — out of the baseline" />
        <KPICard title="VOLUME SPIKES" value={spikes} accent="var(--am)" sub="one customer's week far above their normal — that week is out" />
        <KPICard title="KEPT BY A HUMAN" value={kept} accent="var(--gn)" sub="flagged, reviewed, counted anyway" />
        <KPICard title="RESOLVED" value={rows.filter((r) => r.status === 'resolved').length} accent="var(--mt)" sub="the customer came back" />
      </div>
      <div className="cd" style={{ padding: '10px 12px', marginBottom: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11 }}>
        <span style={{ color: 'var(--mt)', lineHeight: 1.5, flex: 1, minWidth: 320 }}>
          Every row here is <strong>out of last year's baseline</strong> unless you keep it. Runs daily at 10:05 UTC and on the button.
          A customer who ordered a lot last year and has gone quiet is excluded whole; a one-week spike is excluded for that customer,
          item and week only. Recent sales are never touched — the anomaly is in the history the forecast reads, not the rate.
        </span>
        <button onClick={refresh} disabled={busy} style={btnPrimary()}>
          <RefreshCw size={11} style={{ marginRight: 4, verticalAlign: -1 }} />{busy ? 'RUNNING…' : 'RUN THE DETECTOR'}
        </button>
      </div>
      {err && <div className="cd" style={{ padding: 12, color: 'var(--rd)', marginBottom: 14 }}>{err}</div>}
      <div className="cd" style={{ padding: 0 }}>
        {rows.length === 0 ? <div className="ld">Nothing flagged. Run the detector to look again.</div> : (
          <table style={{ width: '100%' }}>
            <thead><tr>
              <th>Kind</th><th>Customer</th><th>Item</th><th>Week</th><th>Evidence</th><th>Status</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map((x) => {
                const c = x.status === 'excluded' ? (x.kind === 'lapsed_customer' ? 'var(--rd)' : 'var(--am)') : x.status === 'kept' ? 'var(--gn)' : 'var(--mt)';
                return (
                  <tr key={x.id} style={{ opacity: x.status === 'resolved' ? 0.6 : 1 }}>
                    <td style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: c }}>{x.kind.replace('_', ' ').toUpperCase()}</td>
                    <td style={{ fontWeight: 600 }}>{x.customer_name ?? x.qbo_customer_id}</td>
                    <td style={{ color: x.item_name ? undefined : 'var(--mt)' }}>{x.item_name ?? 'every planner item'}</td>
                    <td className="mn">{x.week_start ? fmtDate(x.week_start) : <span style={{ color: 'var(--mt)' }}>all</span>}</td>
                    <td style={{ fontSize: 11, color: 'var(--mt)' }}>{describeEvidence(x)}{x.decided_by ? <span> · {x.status} by {x.decided_by}</span> : null}</td>
                    <td style={{ fontSize: 10, fontWeight: 700, color: c }}>{x.status.toUpperCase()}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {x.status === 'excluded' && <button onClick={() => decide(x, 'kept')} style={btnSecondary()} title="Count this in the baseline after all">KEEP</button>}
                      {x.status === 'kept' && <button onClick={() => decide(x, 'excluded')} style={btnDanger()} title="Take it out of the baseline again">EXCLUDE</button>}
                    </td>
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

function ExcludesTab() {
  const [excludes, setExcludes] = useState<VelocityExcludeRow[]>([]);
  const [customers, setCustomers] = useState<QboCustomerOption[]>([]);
  const [draftCustomerId, setDraftCustomerId] = useState('');
  const [draftReason, setDraftReason] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    Promise.all([fetchVelocityExcludes(), fetchCustomerOptions()])
      .then(([ex, cs]) => { setExcludes(ex); setCustomers(cs); })
      .catch(() => { setExcludes([]); setCustomers([]); });
  }
  useEffect(load, []);

  async function add() {
    if (!draftCustomerId) return;
    setSaving(true);
    try {
      await addVelocityExclude(draftCustomerId, draftReason.trim() || undefined);
      setDraftCustomerId(''); setDraftReason('');
      load();
    } finally { setSaving(false); }
  }

  const available = customers.filter((c) => !excludes.some((ex) => ex.qbo_customer_id === c.qbo_customer_id));

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bd)' }}>
        <div className="ct" style={{ margin: 0 }}>VELOCITY EXCLUDES — {excludes.length}</div>
        <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3 }}>
          Customers in this list don't count toward inventory velocity (one-off bulk buyers, internal transfers, samples).
        </div>
      </div>
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--bd)',
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <select value={draftCustomerId} onChange={(e) => setDraftCustomerId(e.target.value)}
          style={{ ...inp(), flex: '1 1 240px', maxWidth: 380, minWidth: 200 }}>
          <option value="">Pick a customer…</option>
          {available.map((c) => (
            <option key={c.qbo_customer_id} value={c.qbo_customer_id}>{c.display_name}</option>
          ))}
        </select>
        <input type="text" value={draftReason}
          onChange={(e) => setDraftReason(e.target.value)}
          placeholder="Reason (optional) — e.g. internal transfer, bulk one-off"
          style={{ ...inp(), flex: '1 1 320px', minWidth: 240 }}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button onClick={add} disabled={!draftCustomerId || saving} style={btnPrimary()}>
          {saving ? 'Adding…' : 'Add Exclude'}
        </button>
      </div>
      {excludes.length === 0 ? (
        <div className="ld">No customers excluded.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Customer</th><th>Reason</th><th>Added</th><th></th></tr>
          </thead>
          <tbody>
            {excludes.map((ex) => {
              const cust = customers.find((c) => c.qbo_customer_id === ex.qbo_customer_id);
              return (
                <tr key={ex.qbo_customer_id}>
                  <td style={{ fontWeight: 600 }}>{cust?.display_name ?? ex.qbo_customer_id}</td>
                  <td style={{ fontSize: 11, color: 'var(--mt)' }}>{ex.reason ?? '—'}</td>
                  <td style={{ fontSize: 11, color: 'var(--mt)' }}>
                    {ex.added_at ? new Date(ex.added_at).toLocaleDateString() : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button onClick={() => removeVelocityExclude(ex.qbo_customer_id).then(load)}
                      style={btnDanger()} title="Remove this exclude">Remove</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
}
