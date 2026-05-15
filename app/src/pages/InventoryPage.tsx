import { useEffect, useMemo, useState } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { DataGridPro, type GridColDef, type GridGroupNode } from '@mui/x-data-grid-pro';
import { Search, X, ShoppingCart } from 'lucide-react';
import { KPICard } from '../components/KPICard';
import { fm, fmtNum } from '../lib/formatters';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../lib/styles';
import { downloadCsv, toCsv } from '../lib/csv';
import { KpiRowSkeleton, TableSkeleton } from '../components/Skeletons';
import {
  InventoryHealthRow, QboCustomerOption, VelocityExcludeRow,
  addVelocityExclude, fetchCustomerOptions, fetchInventoryHealth,
  fetchVelocityExcludes, removeVelocityExclude,
} from '../lib/inventory';

type TabId = 'reorder' | 'velocity' | 'excludes';

const TABS: { id: TabId; label: string }[] = [
  { id: 'reorder',  label: 'Reorder' },
  { id: 'velocity', label: 'Velocity' },
  { id: 'excludes', label: 'Velocity Excludes' },
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

const GRID_SX = {
  height: '64vh', border: 'none', background: 'transparent', color: 'var(--ink)',
  fontFamily: 'inherit', fontSize: 12,
  '--DataGrid-rowBorderColor': 'rgba(255,255,255,0.04)',
  '--DataGrid-containerBackground': 'var(--sf)',
  '& .MuiDataGrid-columnHeaders': { background: 'var(--sf)', borderBottom: '1px solid var(--bd)' },
  '& .MuiDataGrid-columnHeader': {
    fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
    fontSize: 10.5, color: 'var(--mt)',
  },
  '& .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within': { outline: 'none' },
  '& .MuiDataGrid-cell': { borderBottom: '1px solid rgba(255,255,255,0.04)', py: 0.5 },
  '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': { outline: 'none' },
  '& .MuiDataGrid-row:hover': { background: 'rgba(91, 181, 240, 0.05)' },
  '& .MuiDataGrid-groupingCriteriaCellToggle': { color: 'var(--ac)' },
  '& .MuiDataGrid-footerContainer': { borderTop: '1px solid var(--bd)', background: 'var(--sf)', minHeight: 40 },
  '& .MuiTablePagination-root': { color: 'var(--tx)', fontFamily: 'inherit', fontSize: 12 },
  '& .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows': {
    color: 'var(--mt)', fontSize: 11, fontFamily: 'inherit', letterSpacing: 0.3,
  },
  '& .MuiTablePagination-select': { color: 'var(--ac)', fontWeight: 700, fontFamily: 'var(--ff-mono)', fontSize: 12 },
  '& .MuiTablePagination-actions .MuiIconButton-root': {
    color: 'var(--tx2)',
    '&:hover': { background: 'rgba(91, 181, 240, 0.08)', color: 'var(--ac)' },
    '&.Mui-disabled': { color: 'var(--mt)', opacity: 0.4 },
  },
  '& .MuiDataGrid-overlay': { background: 'var(--sf)', color: 'var(--mt)' },
  '& .mn': { fontFeatureSettings: '"tnum" on, "lnum" on' },
  '& .MuiDataGrid-menuIconButton, & .MuiDataGrid-sortIcon': { color: 'var(--mt)' },
  '& .MuiDataGrid-columnSeparator': { color: 'rgba(255,255,255,0.06)' },
  '& .MuiDataGrid-scrollbar': { background: 'transparent' },
  '& .MuiDataGrid-scrollbar::-webkit-scrollbar': { width: 10, height: 10 },
  '& .MuiDataGrid-scrollbar::-webkit-scrollbar-thumb': { background: 'rgba(91, 181, 240, 0.20)', borderRadius: 6 },
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
      background: 'var(--bg)', border: '1px solid var(--bd)', minWidth: 240,
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
  const [lookback, setLookback] = useState(90);
  const [managedOnly, setManagedOnly] = useState(true);
  const [rows, setRows] = useState<InventoryHealthRow[] | null>(null);

  function load() {
    setRows(null);
    fetchInventoryHealth({ lookback: Number(lookback) || 90, managed_only: managedOnly })
      .then(setRows).catch(() => setRows([]));
  }
  useEffect(load, [lookback, managedOnly]);

  const tabLabel = TABS.find((t) => t.id === tab)?.label ?? 'Inventory';

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Reorder · Velocity · Health</div>
          <h1 className="hero-title">Inventory</h1>
          <div className="hero-meta">
            {tabLabel} · {lookback}-day lookback{managedOnly ? ' · managed only' : ''}
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

      {(tab === 'reorder' || tab === 'velocity') && (
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <div className="toolbar-row">
            <div className="toolbar-section">
              <span className="toolbar-label">Velocity lookback</span>
              <input type="number" min={7} max={365} value={lookback}
                onChange={(e) => setLookback(Number(e.target.value) || 90)}
                className="date-input" style={{ width: 70 }} />
              <span style={{ color: 'var(--mt)', fontSize: 11 }}>days</span>
            </div>
            <label className="toolbar-section" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={managedOnly}
                onChange={(e) => setManagedOnly(e.target.checked)}
                style={{ accentColor: 'var(--ac)' }} />
              <span className="toolbar-label">Managed only</span>
            </label>
            <div className="toolbar-spacer" />
            <span style={{ fontSize: 10, color: 'var(--mt)', marginRight: 8 }}>
              Edit per-item settings in <strong style={{ color: 'var(--ac)' }}>Settings → Items</strong>
            </span>
            <button onClick={load} className="tb-btn">Refresh</button>
          </div>
        </div>
      )}

      {tab === 'reorder' && <ReorderTable rows={rows} />}
      {tab === 'velocity' && <VelocityTable rows={rows} />}
      {tab === 'excludes' && <ExcludesTab />}
    </div>
  );
}

function ReorderTable({ rows }: { rows: InventoryHealthRow[] | null }) {
  const [search, setSearch] = useState('');

  const reorder = useMemo(() => {
    if (!rows) return [];
    return rows
      .filter((r) => REORDER_STATUSES.has(r.status) || !r.active)
      .sort((a, b) => Number(a.days_of_supply ?? 999) - Number(b.days_of_supply ?? 999));
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
    { field: 'on_hand', headerName: 'On Hand', type: 'number', width: 90, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : fmtNum(Number(v))) },
    { field: 'daily_velocity', headerName: 'Velocity/day', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
    { field: 'days_of_supply', headerName: 'Days Supply', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(0)) },
    {
      field: 'qty_on_order', headerName: 'On Order', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return v > 0
          ? <span style={{ color: 'var(--gn)', fontWeight: 600 }}>{fmtNum(v)}</span>
          : <span style={{ color: 'var(--mt)' }}>—</span>;
      },
    },
    { field: 'reorder_point', headerName: 'Reorder Pt', type: 'number', width: 100, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : String(v)) },
    {
      field: 'suggested_order_qty', headerName: 'Suggested Qty', type: 'number', width: 130, cellClassName: 'mn',
      renderCell: (p) => (
        <span style={{ color: 'var(--ac)', fontWeight: 600 }}>{p.value != null ? fmtNum(Number(p.value)) : '—'}</span>
      ),
    },
  ], []);

  function exportCsv() {
    if (reorder.length === 0) return;
    const head = ['Item', 'Category', 'Active', 'On Hand', 'On Order', 'Daily Velocity', 'Days of Supply', 'Reorder Point', 'Suggested Order Qty', 'Status'];
    const data = reorder.map((r) => [
      r.item_name, r.category_resolved ?? '', r.active ? 'yes' : 'no',
      r.on_hand ?? '', r.qty_on_order ?? '',
      r.daily_velocity != null ? Number(r.daily_velocity).toFixed(2) : '',
      r.days_of_supply != null ? Number(r.days_of_supply).toFixed(0) : '',
      r.reorder_point ?? '', r.suggested_order_qty ?? '', r.status,
    ]);
    downloadCsv(`reorder_${new Date().toISOString().slice(0,10)}.csv`, toCsv([head, ...data]));
  }

  // Push the visible reorder list into sessionStorage as a PO prefill,
  // then navigate to the Production page → Purchase Orders tab. The PO
  // module reads the key on mount, opens its Create form, and seeds
  // lines with item + suggested qty + last known unit cost.
  function createPoFromReorder() {
    const candidates = (filtered.length > 0 ? filtered : reorder).filter(
      (r) => r.active && r.suggested_order_qty != null && Number(r.suggested_order_qty) > 0,
    );
    if (candidates.length === 0) return;
    const prefill = candidates.map((r) => ({
      qbo_item_id: r.qbo_item_id,
      item_name: r.item_name,
      qty_ordered: Number(r.suggested_order_qty),
      unit_cost: r.purchase_cost ?? 0,
    }));
    sessionStorage.setItem('brix.po.prefill', JSON.stringify({
      source: 'inventory-reorder',
      generated_at: new Date().toISOString(),
      lines: prefill,
    }));
    window.location.hash = '#production';
  }

  function printOrderSheet() {
    const printable = reorder.filter((r) => r.active);
    if (printable.length === 0) return;
    const w = window.open('', '_blank');
    if (!w) return;
    const tableRows = printable.map((r) => `<tr><td>${escapeHtml(r.item_name)}</td><td style="text-align:right">${r.on_hand ?? '—'}</td><td style="text-align:right">${r.daily_velocity != null ? Number(r.daily_velocity).toFixed(2) : '—'}</td><td style="text-align:right">${r.days_of_supply != null ? Number(r.days_of_supply).toFixed(0) : '—'}</td><td style="text-align:right;font-weight:600">${r.suggested_order_qty ?? '—'}</td><td>${r.status}</td><td>      </td></tr>`).join('');
    w.document.write(`<html><head><title>Reorder Sheet</title><style>body{font-family:system-ui,-apple-system,sans-serif;color:#0a0e17;max-width:980px;margin:24px auto;padding:0 24px}h1{font-size:18px;border-bottom:2px solid #0ea5b8;padding-bottom:6px}table{width:100%;border-collapse:collapse;font-size:11px;margin-top:12px}td,th{padding:5px 8px;border-bottom:1px solid #e2e8f0;text-align:left}th{background:#f1f5f9;font-size:9px;text-transform:uppercase;letter-spacing:1px}@media print{body{margin:0}}</style></head><body><h1>Reorder Sheet — ${new Date().toISOString().slice(0,10)}</h1><div style="font-size:10px;color:#64748b">${printable.length} items below threshold (active only)</div><table><thead><tr><th>Item</th><th style="text-align:right">On Hand</th><th style="text-align:right">Velocity/day</th><th style="text-align:right">Days Supply</th><th style="text-align:right">Suggested Qty</th><th>Status</th><th>Order Qty</th></tr></thead><tbody>${tableRows}</tbody></table><script>setTimeout(function(){window.print()},350);</script></body></html>`);
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
        <KPICard title="REORDER NOW" value={reorderNow.length} accent="var(--rd)" sub="days of supply ≤ lead time" />
        <KPICard title="REORDER SOON" value={reorderSoon.length} accent="var(--am)" sub="within 2× lead time" />
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
            onClick={createPoFromReorder}
            disabled={reorder.length === 0}
            style={btnPrimary()}
            title="Open Production → Purchase Orders pre-filled with these items"
          >
            <ShoppingCart size={11} style={{ marginRight: 4, verticalAlign: -1 }} />
            CREATE PO
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
              sorting: { sortModel: [{ field: 'days_of_supply', sort: 'asc' }] },
            }}
            isGroupExpandedByDefault={(node: GridGroupNode) => node.groupingKey !== INACTIVE_GROUP}
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
    { field: 'daily_velocity', headerName: 'Velocity/day', type: 'number', width: 120, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
    { field: 'days_of_supply', headerName: 'Days Supply', type: 'number', width: 110, cellClassName: 'mn',
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
            sx={GRID_SX}
          />
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
