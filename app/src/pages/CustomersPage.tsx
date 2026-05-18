import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef, type GridRenderCellParams, type GridRowParams } from '@mui/x-data-grid-pro';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { Printer, Search } from 'lucide-react';
import { CustomerHealth, CustomerListRow, fetchCustomerHealth, fetchCustomerList } from '../lib/customers';
import { fm, fmtNum } from '../lib/formatters';
import { downloadCsv, toCsv } from '../lib/csv';
import { SegmentChip } from '../components/SegmentChip';
import { TableSkeleton } from '../components/Skeletons';
import { useToast } from '../lib/toast';

interface CustomerGridRow extends CustomerListRow {
  id: string;
  rfm_segment: string | null;
  rfm_total:   number | null;
}

export function CustomersPage() {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const ytdStart = new Date().getFullYear() + '-01-01';

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [channel, setChannel] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [rows, setRows] = useState<CustomerListRow[] | null>(null);
  const [healthByCust, setHealthByCust] = useState<Record<string, CustomerHealth>>({});
  const [err, setErr] = useState('');

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr('');
    fetchCustomerList({
      search: debouncedSearch.trim() || undefined,
      channel: channel || undefined,
      start: ytdStart,
      end: today,
      limit: 1000,
    })
      .then((rs) => { if (!cancelled) setRows(rs); })
      .catch((e: unknown) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [debouncedSearch, channel, ytdStart, today]);

  useEffect(() => {
    fetchCustomerHealth(365)
      .then((rs) => {
        const map: Record<string, CustomerHealth> = {};
        for (const h of rs) map[h.qbo_customer_id] = h;
        setHealthByCust(map);
      })
      .catch(() => setHealthByCust({}));
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return null;
    return showInactive ? rows : rows.filter((r) => r.active);
  }, [rows, showInactive]);

  const gridRows: CustomerGridRow[] = useMemo(() => {
    if (!filtered) return [];
    return filtered.map((r) => {
      const h = healthByCust[r.qbo_customer_id];
      return {
        ...r,
        id: r.qbo_customer_id,
        rfm_segment: h?.rfm_segment ?? null,
        rfm_total:   h?.rfm_total ?? null,
      };
    });
  }, [filtered, healthByCust]);

  const channelOptions = useMemo(() => {
    if (!rows) return [];
    const set = new Set<string>();
    for (const r of rows) if (r.primary_channel) set.add(r.primary_channel);
    return Array.from(set).sort();
  }, [rows]);

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'display_name',
      headerName: 'Customer',
      flex: 2,
      minWidth: 240,
      renderCell: (p: GridRenderCellParams<CustomerGridRow>) => {
        const name = (p.value as string | null | undefined);
        const hasName = name && String(name).trim() !== '';
        return (
          <span style={{
            fontWeight: hasName ? 600 : 500,
            color: hasName ? undefined : 'var(--am)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontStyle: hasName ? undefined : 'italic',
          }} title={hasName ? String(name) : `Customer with no name. QBO ID: ${p.row.qbo_customer_id}`}>
            {hasName ? name : `(no name · QBO #${p.row.qbo_customer_id})`}
            {p.row.is_sub_customer && <span className="bg bg-p" style={{ marginLeft: 6 }}>SUB</span>}
            {!p.row.active && <span className="bg bg-p" style={{ marginLeft: 6 }}>INACTIVE</span>}
          </span>
        );
      },
    },
    {
      field: 'state',
      headerName: 'State',
      width: 70,
      cellClassName: 'mn',
      valueFormatter: (v) => v ?? '—',
    },
    {
      field: 'primary_channel',
      headerName: 'Channel',
      width: 160,
      valueFormatter: (v) => v ?? '—',
    },
    {
      field: 'ytd_revenue',
      headerName: 'YTD Revenue',
      type: 'number',
      width: 140,
      cellClassName: 'mn',
      renderCell: (p) => <span style={{ fontWeight: 600 }}>{fm(p.value)}</span>,
    },
    {
      field: 'invoice_count',
      headerName: 'Invoices',
      type: 'number',
      width: 90,
      cellClassName: 'mn',
      valueFormatter: (v) => v != null ? fmtNum(Number(v)) : '0',
    },
    {
      field: 'rfm_segment',
      headerName: 'Segment',
      width: 120,
      renderCell: (p) => <SegmentChip segment={(p.value as string | null) ?? null} />,
      sortComparator: (a, b) => String(a ?? 'zzz').localeCompare(String(b ?? 'zzz')),
    },
    {
      field: 'rfm_total',
      headerName: 'RFM',
      type: 'number',
      width: 80,
      cellClassName: 'mn',
      renderCell: (p) => p.value != null ? <span style={{ color: 'var(--mt)' }}>{p.value}/15</span> : '—',
    },
  ], []);

  function exportCsv() {
    if (!gridRows || gridRows.length === 0) return;
    const head = ['Customer', 'Active', 'State', 'Channel', 'YTD Revenue', 'Invoices', 'RFM Segment', 'RFM Total'];
    const data = gridRows.map((r) => [
      r.display_name,
      r.active ? 'Y' : 'N',
      r.state ?? '',
      r.primary_channel ?? '',
      Number(r.ytd_revenue ?? 0).toFixed(2),
      r.invoice_count,
      r.rfm_segment ?? '',
      r.rfm_total ?? '',
    ]);
    downloadCsv(`customers_${ytdStart}_${today}.csv`, toCsv([head, ...data]));
    toast.success(`Exported ${data.length} customers to CSV`);
  }

  function printDashboard() {
    toast.info('Opening print preview…');
    setTimeout(() => window.print(), 250);
  }

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Customer health · RFM · YTD</div>
          <h1 className="hero-title">Customers</h1>
          <div className="hero-meta">
            {gridRows ? `${fmtNum(gridRows.length)} customers` : 'loading…'}
            {channel ? ` · ${channel}` : ''}{showInactive ? ' · including inactive' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className="hero-stamp">
            <span className="status-dot" aria-hidden="true" />
            YTD {ytdStart} → {today}
          </div>
          <button onClick={printDashboard} className="tb-btn tb-btn--primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Printer size={13} strokeWidth={2.4} aria-hidden="true" />
            <span>Print</span>
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbar-row">
          <div className="toolbar-section" style={{ position: 'relative' }}>
            <Search size={14} strokeWidth={2.2} style={{ color: 'var(--mt)' }} />
            <input
              type="text"
              placeholder="Search by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="login-input"
              style={{ width: 260, padding: '6px 10px', fontSize: 12 }}
            />
          </div>

          <div className="toolbar-section">
            <span className="toolbar-label">Channel</span>
            <Autocomplete
              size="small"
              options={channelOptions}
              value={channel}
              onChange={(_, v) => setChannel(v)}
              sx={{
                minWidth: 200,
                '& .MuiInputBase-root': { background: 'var(--bg)', fontSize: 12, color: 'var(--tx)', height: 30, paddingY: 0 },
                '& .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--bd)' },
                '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--bd2)' },
              }}
              renderInput={(params) => <TextField {...params} placeholder="All channels" />}
            />
          </div>

          <label className="toolbar-section" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} style={{ accentColor: 'var(--ac)' }} />
            <span className="toolbar-label" style={{ cursor: 'pointer' }}>Show inactive</span>
          </label>

          <div className="toolbar-spacer" />

          <button onClick={exportCsv} disabled={!gridRows?.length} className="tb-btn tb-btn--primary">Export CSV</button>
        </div>
      </div>

      {err ? (
        <div className="cd" style={{ padding: 14, color: 'var(--rd)' }}>Error: {err}</div>
      ) : !filtered ? (
        <div className="cd" style={{ padding: 0 }}>
          <TableSkeleton rows={10} cols={7} />
        </div>
      ) : gridRows.length === 0 ? (
        <div className="cd" style={{ padding: 14, color: 'var(--mt)' }}>No customers match.</div>
      ) : (
        <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
          <DataGridPro
            rows={gridRows}
            columns={columns}
            density="compact"
            pagination
            pageSizeOptions={[10, 25, 50, 100, 250, { value: -1, label: 'All' }]}
            initialState={{
              pagination: { paginationModel: { pageSize: 25, page: 0 } },
              pinnedColumns: { left: ['display_name'] },
              sorting: { sortModel: [{ field: 'ytd_revenue', sort: 'desc' }] },
            }}
            disableRowSelectionOnClick
            onRowClick={(params: GridRowParams<CustomerGridRow>) => {
              window.location.hash = '#customer-' + params.row.qbo_customer_id;
            }}
            sx={{
              height: '64vh',
              border: 'none',
              background: 'transparent',
              color: 'var(--tx)',
              fontFamily: 'inherit',
              fontSize: 12,
              '& .MuiDataGrid-row': { cursor: 'pointer' },
              '& .MuiDataGrid-columnHeaders': { background: 'var(--sf)', borderBottom: '1px solid var(--bd)' },
              '& .MuiDataGrid-columnHeader': {
                fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
                fontSize: 10.5, color: 'var(--mt)',
              },
              '& .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within': { outline: 'none' },
              '& .MuiDataGrid-cell': { borderBottom: '1px solid rgba(255,255,255,0.04)', py: 0.5 },
              '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': { outline: 'none' },
              '& .MuiDataGrid-row:hover': { background: 'rgba(91,181,240,0.06)' },
              '& .MuiDataGrid-pinnedColumns': { background: 'var(--sf)', boxShadow: '4px 0 12px rgba(0,0,0,0.35)' },
              '& .MuiDataGrid-pinnedColumnHeaders': { background: 'var(--sf)' },
              '& .MuiDataGrid-footerContainer': {
                borderTop: '1px solid var(--bd)',
                background: 'var(--sf)',
                minHeight: 40,
              },
              '& .MuiTablePagination-root, & .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows': {
                color: 'var(--mt)',
                fontFamily: 'inherit',
                fontSize: 11,
              },
              '& .MuiTablePagination-select': { color: 'var(--ac)' },
              '& .mn': { fontFeatureSettings: '"tnum" on, "lnum" on' },
              '& .MuiDataGrid-menuIconButton, & .MuiDataGrid-sortIcon': { color: 'var(--mt)' },
            }}
          />
        </div>
      )}
    </div>
  );
}
