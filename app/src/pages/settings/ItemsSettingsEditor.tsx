import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef, type GridGroupNode } from '@mui/x-data-grid-pro';
import { Search, X } from 'lucide-react';
import { KPICard } from '../../components/KPICard';
import { fm, fmtNum } from '../../lib/formatters';
import { inp } from '../../lib/styles';
import { sbrpc } from '../../lib/rpc';
import { useToast } from '../../lib/toast';

interface ItemMasterRow {
  qbo_item_id: string;
  item_name: string;
  fully_qualified_name: string | null;
  active: boolean;
  category_path: string | null;
  category_override: string | null;
  category_resolved: string;
  income_account_name: string | null;
  expense_account_name: string | null;
  on_hand: number;
  unit_price: number | null;
  purchase_cost: number | null;
  is_managed: boolean;
  target_days_supply: number;
  lead_time_days: number;
  reorder_point: number | null;
  min_order_qty: number | null;
  notes: string | null;
  sold_qty: number;
  sold_revenue: number;
  customers_count: number;
  daily_velocity: number | null;
  days_of_supply: number | null;
  status: string;
}

const STATUS_COLOR: Record<string, string> = {
  reorder:  'var(--rd)', critical: 'var(--rd)',
  idle:     'var(--mt)', ok:       'var(--gn)',
  inactive: '#64748b',   overstock: '#a78bfa',
};

const INACTIVE_GROUP = 'INACTIVE';

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

function getTreeDataPath(row: Record<string, unknown>): string[] {
  return [
    String(row.active === false ? INACTIVE_GROUP : (row.category_resolved ?? 'Uncategorized')),
    String(row.qbo_item_id ?? ''),
  ];
}

export function ItemsSettingsEditor() {
  const toast = useToast();
  const [rows, setRows] = useState<ItemMasterRow[] | null>(null);
  const [search, setSearch] = useState('');

  function load() {
    setRows(null);
    sbrpc<ItemMasterRow[]>('fn_items_master', { p_lookback_days: 90, p_search: null })
      .then(setRows)
      .catch((e) => { toast.error('Load failed: ' + (e as Error).message); setRows([]); });
  }
  useEffect(load, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.item_name.toLowerCase().includes(q)
      || (r.fully_qualified_name?.toLowerCase().includes(q) ?? false)
      || r.category_resolved.toLowerCase().includes(q)
      || (r.notes?.toLowerCase().includes(q) ?? false),
    );
  }, [rows, search]);

  const gridRows = useMemo(
    () => filtered.map((r) => ({ ...r, id: r.qbo_item_id })),
    [filtered],
  );

  async function patch(
    qbo_item_id: string,
    patchData: Partial<Pick<ItemMasterRow, 'is_managed' | 'target_days_supply' | 'lead_time_days' | 'reorder_point' | 'min_order_qty' | 'notes' | 'category_override'>>,
  ) {
    try {
      await sbrpc<void>('fn_set_inventory_settings', {
        p_qbo_item_id:        qbo_item_id,
        p_is_managed:         patchData.is_managed ?? null,
        p_target_days_supply: patchData.target_days_supply ?? null,
        p_lead_time_days:     patchData.lead_time_days ?? null,
        p_reorder_point:      patchData.reorder_point ?? null,
        p_min_order_qty:      patchData.min_order_qty ?? null,
        p_notes:              patchData.notes ?? null,
        p_category_override:  patchData.category_override ?? null,
      });
      setRows((cur) => cur?.map((r) =>
        r.qbo_item_id === qbo_item_id ? { ...r, ...patchData,
          category_resolved: patchData.category_override ?? r.category_path ?? 'Uncategorized',
        } : r,
      ) ?? cur);
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
      load();
    }
  }

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'category_override', headerName: 'Category Override', width: 200,
      renderCell: (p) => {
        const cur = p.row.category_override as string | null;
        const inherited = p.row.category_path as string | null;
        return (
          <input
            type="text" defaultValue={cur ?? ''}
            placeholder={inherited ?? 'set category'}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (cur ?? '')) patch(p.row.qbo_item_id, { category_override: v || null });
            }}
            style={{ ...inp(), width: '100%', fontSize: 11 }}
          />
        );
      },
    },
    {
      field: 'active', headerName: 'Active', width: 80,
      renderCell: (p) => (
        <span style={{ fontSize: 10, color: p.value ? 'var(--gn)' : 'var(--mt)', fontWeight: 600 }}>
          {p.value ? 'YES' : 'NO'}
        </span>
      ),
    },
    {
      field: 'is_managed', headerName: 'Managed?', width: 90,
      renderCell: (p) => (
        <input type="checkbox" defaultChecked={!!p.value}
          onChange={(e) => patch(p.row.qbo_item_id, { is_managed: e.target.checked })}
          style={{ accentColor: 'var(--ac)' }} />
      ),
    },
    { field: 'on_hand', headerName: 'On Hand', type: 'number', width: 90, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)) },
    { field: 'daily_velocity', headerName: 'Vel/day', type: 'number', width: 90, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
    {
      field: 'days_of_supply', headerName: 'Days Supply', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(0)),
    },
    {
      field: 'status', headerName: 'Status', width: 110,
      renderCell: (p) => {
        if (!p.value) return null;
        const c = STATUS_COLOR[p.value as string] ?? 'var(--mt)';
        return (
          <span style={{
            background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
            padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
          }}>{String(p.value).toUpperCase()}</span>
        );
      },
    },
    {
      field: 'target_days_supply', headerName: 'Target Days', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => (
        <input type="number" defaultValue={p.value ?? 30}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (v !== p.value) patch(p.row.qbo_item_id, { target_days_supply: v });
          }}
          style={{ ...inp(), width: 60, textAlign: 'right' }} />
      ),
    },
    {
      field: 'lead_time_days', headerName: 'Lead Time', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => (
        <input type="number" defaultValue={p.value ?? 7}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (v !== p.value) patch(p.row.qbo_item_id, { lead_time_days: v });
          }}
          style={{ ...inp(), width: 60, textAlign: 'right' }} />
      ),
    },
    {
      field: 'reorder_point', headerName: 'Reorder Pt', type: 'number', width: 110, cellClassName: 'mn',
      renderCell: (p) => (
        <input type="number" defaultValue={p.value ?? ''}
          placeholder="auto"
          onBlur={(e) => {
            const v = e.target.value === '' ? null : Number(e.target.value);
            if (v !== p.value) patch(p.row.qbo_item_id, { reorder_point: v });
          }}
          style={{ ...inp(), width: 70, textAlign: 'right' }} />
      ),
    },
    {
      field: 'min_order_qty', headerName: 'Min Order', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => (
        <input type="number" defaultValue={p.value ?? ''}
          onBlur={(e) => {
            const v = e.target.value === '' ? null : Number(e.target.value);
            if (v !== p.value) patch(p.row.qbo_item_id, { min_order_qty: v });
          }}
          style={{ ...inp(), width: 70, textAlign: 'right' }} />
      ),
    },
    { field: 'sold_revenue', headerName: 'Rev 90d', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => fm(Number(v ?? 0)) },
    {
      field: 'notes', headerName: 'Notes', flex: 1, minWidth: 200,
      renderCell: (p) => (
        <input type="text" defaultValue={p.value ?? ''}
          placeholder="—"
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== (p.value ?? '')) patch(p.row.qbo_item_id, { notes: v || null });
          }}
          style={{ ...inp(), width: '100%', fontSize: 11 }} />
      ),
    },
  ], []);

  // groupingColDef.renderCell — MUI's GridTreeNodeWithRender has
  // `groupingKey: GridKeyValue | null`. Allow null in the local type
  // and `as any` the column to satisfy MUI's deep overload chain.
  const groupingColDef = useMemo(() => ({
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
  }) as any, []);

  if (!rows) return <div className="ld">Loading items…</div>;

  const activeCount      = rows.filter((r) => r.active).length;
  const inactiveCount    = rows.filter((r) => !r.active).length;
  const managedCount     = rows.filter((r) => r.is_managed).length;
  const withOverrideCount = rows.filter((r) => r.category_override).length;

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="ITEMS TOTAL"     value={rows.length} sub={`${activeCount} active · ${inactiveCount} inactive`} />
        <KPICard title="MANAGED"          value={managedCount} accent="var(--ac)" sub="velocity-driven reorder" />
        <KPICard title="CATEGORY OVERRIDES" value={withOverrideCount} sub="custom-grouped" />
        <KPICard title="UNCATEGORIZED"    value={rows.filter((r) => !r.category_path && !r.category_override).length}
          accent={rows.filter((r) => !r.category_path && !r.category_override).length > 0 ? 'var(--am)' : undefined}
          sub="needs a category" />
      </div>

      <div className="cd" style={{
        padding: '10px 12px', marginBottom: 14, display: 'flex',
        gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11,
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', height: 30, borderRadius: 4,
          background: 'var(--bg)', border: '1px solid var(--bd)', minWidth: 260,
        }}>
          <Search size={13} strokeWidth={2.2} color="var(--mt)" aria-hidden="true" />
          <input type="text" value={search} placeholder="Search name, category, notes…"
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--tx)', fontFamily: 'var(--ff-mono)', fontSize: 12,
              flex: 1, padding: 0,
            }} />
          {search && (
            <button onClick={() => setSearch('')} aria-label="Clear"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, display: 'inline-flex' }}>
              <X size={12} strokeWidth={2.4} color="var(--mt)" />
            </button>
          )}
        </div>
        <span style={{ color: 'var(--mt)', marginLeft: 6 }}>
          {filtered.length} of {rows.length} items
        </span>
        <button onClick={load} className="tb-btn" style={{ marginLeft: 'auto' }}>Refresh</button>
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
            pageSizeOptions={[20, 40, 60, 100, 250, { value: -1, label: 'All' }]}
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

      <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 8, lineHeight: 1.4 }}>
        <strong style={{ color: 'var(--tx)' }}>One place for every item.</strong> Category override beats QBO's category_path everywhere — Margin Control, Inventory, Reports all use the resolved category. Managed/Target/Lead/Reorder/Min/Notes are the inventory-health inputs.
      </div>
    </div>
  );
}
