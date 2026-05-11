import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef, type GridGroupNode } from '@mui/x-data-grid-pro';
import { Search, X } from 'lucide-react';
import { KPICard } from '../../components/KPICard';
import { fm, fmtNum } from '../../lib/formatters';
import { inp } from '../../lib/styles';
import { useToast } from '../../lib/toast';
import {
  Channel,
  CustomersMasterRow,
  fetchChannels,
  fetchCustomersMaster,
  setCustomerChannels,
  setCustomerNotes,
} from '../../lib/settings';
import {
  SalesRep,
  assignCustomerToRep,
  fetchSalesReps,
  unassignCustomer,
} from '../../lib/salesReps';

const UNASSIGNED = '— Unassigned —';

const GRID_SX = {
  height: '66vh', border: 'none', background: 'transparent', color: 'var(--ink)',
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

function ytdRange() {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date().getFullYear() + '-01-01';
  return { start, end: today };
}

function getTreeDataPath(row: Record<string, unknown>): string[] {
  return [
    String(row.primary_channel ?? UNASSIGNED),
    String(row.qbo_customer_id ?? ''),
  ];
}

export function CustomersSettingsEditor() {
  const toast = useToast();
  const { start, end } = ytdRange();

  const [rows, setRows] = useState<CustomersMasterRow[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [repByCode, setRepByCode] = useState<Map<string, SalesRep>>(new Map());
  const [assignByCustomer, setAssignByCustomer] = useState<Map<string, string>>(new Map());
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  function load() {
    setRows(null);
    Promise.all([
      fetchCustomersMaster({ start, end, only_active: !showInactive, limit: 1500 }),
      fetchChannels(),
      fetchSalesReps(),
    ])
      .then(([rs, cs, sr]) => {
        setRows(rs);
        setChannels(cs.filter((c) => c.is_active));
        setReps(sr);
        const map = new Map<string, SalesRep>();
        for (const r of sr) map.set(r.rep_code, r);
        setRepByCode(map);
        // primary_sales_rep is the name, but assign* takes rep_code. Build
        // a name→code map for matching.
        const byName = new Map<string, string>();
        for (const r of sr) byName.set(r.name, r.rep_code);
        const ac = new Map<string, string>();
        for (const row of rs) {
          if (row.primary_sales_rep && byName.has(row.primary_sales_rep)) {
            ac.set(row.qbo_customer_id, byName.get(row.primary_sales_rep)!);
          }
        }
        setAssignByCustomer(ac);
      })
      .catch((e) => { toast.error('Load failed: ' + (e as Error).message); setRows([]); });
  }
  useEffect(load, [showInactive]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.display_name.toLowerCase().includes(q)
      || (r.fully_qualified_name?.toLowerCase().includes(q) ?? false)
      || (r.customer_type_name?.toLowerCase().includes(q) ?? false)
      || (r.primary_channel?.toLowerCase().includes(q) ?? false)
      || (r.notes?.toLowerCase().includes(q) ?? false),
    );
  }, [rows, search]);

  const gridRows = useMemo(
    () => filtered.map((r) => ({ ...r, id: r.qbo_customer_id })),
    [filtered],
  );

  async function patchChannel(qbo_customer_id: string, primary: string | null) {
    try {
      const existing = (rows ?? []).find((r) => r.qbo_customer_id === qbo_customer_id);
      const labels = primary ? Array.from(new Set([...(existing?.channels ?? []), primary])) : (existing?.channels ?? []);
      await setCustomerChannels(qbo_customer_id, primary ? labels : labels, primary);
      setRows((cur) => cur?.map((r) =>
        r.qbo_customer_id === qbo_customer_id
          ? { ...r, primary_channel: primary, channels: primary ? labels : r.channels }
          : r,
      ) ?? cur);
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
      load();
    }
  }

  async function patchRep(qbo_customer_id: string, rep_code: string) {
    try {
      if (!rep_code) {
        await unassignCustomer(qbo_customer_id);
        setAssignByCustomer((cur) => {
          const next = new Map(cur);
          next.delete(qbo_customer_id);
          return next;
        });
        setRows((cur) => cur?.map((r) =>
          r.qbo_customer_id === qbo_customer_id ? { ...r, primary_sales_rep: null, sales_reps: [] } : r,
        ) ?? cur);
        return;
      }
      await assignCustomerToRep(qbo_customer_id, rep_code);
      const rep = repByCode.get(rep_code);
      setAssignByCustomer((cur) => {
        const next = new Map(cur);
        next.set(qbo_customer_id, rep_code);
        return next;
      });
      setRows((cur) => cur?.map((r) =>
        r.qbo_customer_id === qbo_customer_id
          ? { ...r, primary_sales_rep: rep?.name ?? null, sales_reps: rep ? [rep.name] : [] }
          : r,
      ) ?? cur);
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
      load();
    }
  }

  async function patchNotes(qbo_customer_id: string, notes: string | null) {
    try {
      await setCustomerNotes(qbo_customer_id, notes);
      setRows((cur) => cur?.map((r) =>
        r.qbo_customer_id === qbo_customer_id ? { ...r, notes } : r,
      ) ?? cur);
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
      load();
    }
  }

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'display_name', headerName: 'Customer', flex: 1.4, minWidth: 200,
      renderCell: (p) => (
        <div style={{ minWidth: 0, overflow: 'hidden' }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.row.display_name}
          </div>
          {(p.row.state || p.row.is_sub_customer || p.row.customer_type_name) && (
            <div style={{ fontSize: 10, color: 'var(--mt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[p.row.state, p.row.is_sub_customer ? 'sub' : null, p.row.customer_type_name].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      ),
    },
    {
      field: 'active', headerName: 'Active', width: 70,
      renderCell: (p) => (
        <span style={{ fontSize: 10, color: p.value ? 'var(--gn)' : 'var(--mt)', fontWeight: 600 }}>
          {p.value ? 'YES' : 'NO'}
        </span>
      ),
    },
    {
      field: 'primary_channel', headerName: 'Primary Channel', width: 200,
      renderCell: (p) => (
        <select
          value={p.value ?? ''}
          onChange={(e) => patchChannel(p.row.qbo_customer_id, e.target.value || null)}
          style={{ ...inp(), width: '100%', fontSize: 11,
            color: p.value ? 'var(--ac)' : 'var(--mt)',
            fontWeight: p.value ? 600 : 400 }}
        >
          <option value="">— unassigned —</option>
          {channels.map((c) => (
            <option key={c.channel_code} value={c.label}>{c.label}</option>
          ))}
        </select>
      ),
    },
    {
      field: 'primary_sales_rep', headerName: 'Sales Rep', width: 180,
      renderCell: (p) => {
        const code = assignByCustomer.get(p.row.qbo_customer_id) ?? '';
        return (
          <select
            value={code}
            onChange={(e) => patchRep(p.row.qbo_customer_id, e.target.value)}
            style={{ ...inp(), width: '100%', fontSize: 11,
              color: code ? 'var(--ac)' : 'var(--mt)',
              fontWeight: code ? 600 : 400 }}
          >
            <option value="">— unassigned —</option>
            {reps.filter((r) => r.is_active || r.rep_code === code).map((r) => (
              <option key={r.rep_code} value={r.rep_code}>{r.rep_code} · {r.name}</option>
            ))}
          </select>
        );
      },
    },
    {
      field: 'ytd_revenue', headerName: 'YTD Rev', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => fm(Number(v ?? 0)),
    },
    {
      field: 'invoice_count', headerName: 'Invoices', type: 'number', width: 80, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)),
    },
    {
      field: 'last_invoice_date', headerName: 'Last Inv', width: 100,
      valueFormatter: (v) => v ? String(v).slice(0, 10) : '—',
    },
    {
      field: 'ar_total', headerName: 'AR Total', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return <span style={{ color: v > 0 ? 'var(--tx)' : 'var(--mt)', fontWeight: v > 0 ? 600 : 400 }}>{fm(v)}</span>;
      },
    },
    {
      field: 'ar_31_60', headerName: '31-60', type: 'number', width: 80, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return v > 0 ? <span style={{ color: 'var(--am)' }}>{fm(v)}</span> : <span style={{ color: 'var(--mt)' }}>—</span>;
      },
    },
    {
      field: 'ar_61_90', headerName: '61-90', type: 'number', width: 80, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return v > 0 ? <span style={{ color: 'var(--am)' }}>{fm(v)}</span> : <span style={{ color: 'var(--mt)' }}>—</span>;
      },
    },
    {
      field: 'ar_90_plus', headerName: '90+', type: 'number', width: 90, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return v > 0 ? <span style={{ color: 'var(--rd)', fontWeight: 700 }}>{fm(v)}</span> : <span style={{ color: 'var(--mt)' }}>—</span>;
      },
    },
    {
      field: 'open_invoice_count', headerName: 'Open Inv', type: 'number', width: 90, cellClassName: 'mn',
      valueFormatter: (v) => v ? fmtNum(Number(v)) : '—',
    },
    {
      field: 'notes', headerName: 'Notes', flex: 1, minWidth: 180,
      renderCell: (p) => (
        <input type="text" defaultValue={p.value ?? ''}
          placeholder="—"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (p.value ?? '')) patchNotes(p.row.qbo_customer_id, v || null);
          }}
          style={{ ...inp(), width: '100%', fontSize: 11 }} />
      ),
    },
  ], [channels, reps, assignByCustomer, repByCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupingColDef = useMemo(() => ({
    headerName: 'Channel / Customer', width: 280, hideDescendantCount: false,
    renderCell: (params: {
      rowNode: { type: string; groupingKey?: string | number | null };
      row: { display_name?: string };
    }) => {
      if (params.rowNode.type === 'group') {
        const key = params.rowNode.groupingKey;
        return <strong style={{ color: 'var(--ac)' }}>{key == null ? UNASSIGNED : String(key)}</strong>;
      }
      return <span style={{ fontWeight: 600 }}>{String(params.row.display_name ?? '')}</span>;
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any, []);

  if (!rows) return <div className="ld">Loading customers…</div>;

  const totalRev = rows.reduce((s, r) => s + Number(r.ytd_revenue || 0), 0);
  const totalAr = rows.reduce((s, r) => s + Number(r.ar_total || 0), 0);
  const past90 = rows.reduce((s, r) => s + Number(r.ar_90_plus || 0), 0);
  const unassignedCount = rows.filter((r) => !r.primary_channel).length;

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="CUSTOMERS" value={rows.length} sub={`${rows.filter((r) => r.active).length} active`} />
        <KPICard title="YTD REVENUE" value={fm(totalRev)} accent="var(--ac)" sub="all customers shown" />
        <KPICard title="AR OUTSTANDING" value={fm(totalAr)} sub="open invoices" />
        <KPICard
          title="UNASSIGNED CHANNEL"
          value={unassignedCount}
          accent={unassignedCount > 0 ? 'var(--am)' : undefined}
          sub={past90 > 0 ? fm(past90) + ' past 90' : 'all classified'}
        />
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
          <input type="text" value={search} placeholder="Search name, channel, type, notes…"
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
          {filtered.length} of {rows.length} customers
        </span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 10, cursor: 'pointer', color: 'var(--mt)' }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)}
            style={{ accentColor: 'var(--ac)' }} />
          show inactive
        </label>
        <button onClick={load} className="tb-btn" style={{ marginLeft: 'auto' }}>Refresh</button>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        {filtered.length === 0 ? (
          <div className="ld">No customers match.</div>
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
              sorting: { sortModel: [{ field: 'ytd_revenue', sort: 'desc' }] },
            }}
            isGroupExpandedByDefault={(node: GridGroupNode) =>
              node.groupingKey !== UNASSIGNED}
            sx={GRID_SX}
          />
        )}
      </div>

      <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 8, lineHeight: 1.4 }}>
        <strong style={{ color: 'var(--tx)' }}>One place for every customer.</strong> Primary channel,
        sales rep, and notes save inline. YTD revenue + AR aging come straight from QBO. Channel
        assignment flows into v_sales_lines for Margin Control filtering and reports.
      </div>
    </div>
  );
}
