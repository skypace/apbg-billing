import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef, type GridRenderCellParams, type GridRowParams } from '@mui/x-data-grid-pro';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { AlertTriangle, Archive, CheckCircle2, Clock, Printer, RefreshCw, Search, XCircle } from 'lucide-react';
import { CustomerHealth, CustomerListRow, fetchCustomerHealth, fetchCustomerList, runCustomerInactivation } from '../lib/customers';
import { fd, fm, fmtNum } from '../lib/formatters';
import { downloadCsv, toCsv } from '../lib/csv';
import { SegmentChip } from '../components/SegmentChip';
import { TableSkeleton } from '../components/Skeletons';
import { useToast } from '../lib/toast';
import { GRID_SX, GRID_DEFAULTS } from '../lib/gridStyles';

interface CustomerGridRow extends CustomerListRow {
  id: string;
  rfm_segment: string | null;
  rfm_total:   number | null;
}

const ACTION_TONE: Record<string, { color: string; bg: string; icon: typeof AlertTriangle }> = {
  'Review Inactive':    { color: 'var(--am)', bg: 'rgba(244, 178, 80, 0.12)', icon: Archive },
  'Queued Inactive':    { color: 'var(--ac)', bg: 'rgba(91, 181, 240, 0.12)', icon: Clock },
  'Fix Inactive Error': { color: 'var(--rd)', bg: 'rgba(224, 79, 95, 0.12)', icon: XCircle },
  'Blocked Inactive':   { color: 'var(--rd)', bg: 'rgba(224, 79, 95, 0.12)', icon: AlertTriangle },
  'Collect AR':         { color: 'var(--rd)', bg: 'rgba(224, 79, 95, 0.12)', icon: AlertTriangle },
  'Future Invoice':     { color: 'var(--ac)', bg: 'rgba(91, 181, 240, 0.12)', icon: Clock },
  'Review Cost':        { color: 'var(--am)', bg: 'rgba(244, 178, 80, 0.12)', icon: AlertTriangle },
  'Review Margin':      { color: 'var(--rd)', bg: 'rgba(224, 79, 95, 0.12)', icon: AlertTriangle },
  'Expand Basket':      { color: 'var(--gn)', bg: 'rgba(46, 184, 114, 0.12)', icon: CheckCircle2 },
  'Inactive':           { color: 'var(--mt)', bg: 'rgba(255, 255, 255, 0.05)', icon: XCircle },
  'Healthy':            { color: 'var(--gn)', bg: 'rgba(46, 184, 114, 0.12)', icon: CheckCircle2 },
};

function fmtPct(v: number | null | undefined) {
  if (v == null || !isFinite(Number(v))) return '—';
  return (Number(v) * 100).toFixed(0) + '%';
}

function ActionBadge({ action }: { action: string | null | undefined }) {
  const label = action || 'Healthy';
  const tone = ACTION_TONE[label] ?? ACTION_TONE.Healthy;
  const Icon = tone.icon;
  return (
    <span
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        maxWidth: '100%',
        padding: '3px 7px',
        borderRadius: 6,
        color: tone.color,
        background: tone.bg,
        fontSize: 10,
        fontWeight: 700,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      <Icon size={11} strokeWidth={2.4} aria-hidden="true" />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </span>
  );
}

export function CustomersPage() {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const ytdStart = new Date().getFullYear() + '-01-01';

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [channel, setChannel] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [reviewInactive, setReviewInactive] = useState(false);
  const [rows, setRows] = useState<CustomerListRow[] | null>(null);
  const [healthByCust, setHealthByCust] = useState<Record<string, CustomerHealth>>({});
  const [processing, setProcessing] = useState<Record<string, boolean>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
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
  }, [debouncedSearch, channel, ytdStart, today, reloadTick]);

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
    let next = showInactive ? rows : rows.filter((r) => r.active);
    if (reviewInactive) {
      next = next.filter((r) => r.can_inactivate || (r.next_action ?? '').includes('Inactive') || !!r.lifecycle_status);
    }
    return next;
  }, [rows, showInactive, reviewInactive]);

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

  const summary = useMemo(() => {
    const source = rows ?? [];
    return {
      active: source.filter((r) => r.active).length,
      inactive: source.filter((r) => !r.active).length,
      reviewInactive: source.filter((r) => r.can_inactivate).length,
      queued: source.filter((r) => !!r.lifecycle_status && r.lifecycle_status !== 'blocked').length,
      blocked: source.filter((r) => r.lifecycle_status === 'blocked').length,
      collectAr: source.filter((r) => r.next_action === 'Collect AR').length,
    };
  }, [rows]);

  async function runOne(row: CustomerGridRow) {
    if (!row.can_inactivate) {
      toast.warn(`Not safe to inactivate: ${row.inactive_reason || 'review needed'}`);
      return;
    }
    if (!window.confirm(`Inactivate ${row.display_name} in Service Fusion, then QBO?`)) return;

    setProcessing((m) => ({ ...m, [row.qbo_customer_id]: true }));
    try {
      const result = await runCustomerInactivation({
        action: 'request_and_process',
        qbo_customer_id: row.qbo_customer_id,
        reason: 'Dormant active customer cleanup from customer list',
      });
      if (result.ok) {
        toast.success(`${row.display_name} marked inactive`);
      } else {
        const msg = result.action?.last_error || result.error || result.status || 'Needs review';
        toast.warn(`${row.display_name}: ${msg}`);
      }
      setReloadTick((n) => n + 1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setProcessing((m) => ({ ...m, [row.qbo_customer_id]: false }));
    }
  }

  async function runDormantBatch() {
    const candidates = gridRows
      .filter((r) => r.can_inactivate && !r.lifecycle_status)
      .slice(0, 5);
    if (candidates.length === 0) {
      toast.info('No unqueued dormant customers in this view');
      return;
    }
    if (!window.confirm(`Run Service Fusion then QBO inactive cleanup for ${candidates.length} dormant customers?`)) return;

    setBulkBusy(true);
    try {
      const result = await runCustomerInactivation({
        action: 'request_and_process_many',
        qbo_customer_ids: candidates.map((r) => r.qbo_customer_id),
        limit: candidates.length,
        reason: 'Dormant active customer cleanup from customer list batch',
      });
      const completed = result.results?.filter((r) => r.ok).length ?? 0;
      const blocked = (result.results?.length ?? 0) - completed;
      toast.info(`Inactive cleanup ran: ${completed} completed, ${blocked} need review`);
      setReloadTick((n) => n + 1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

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
      field: 'next_action',
      headerName: 'Next',
      width: 155,
      renderCell: (p: GridRenderCellParams<CustomerGridRow>) => <ActionBadge action={p.row.next_action} />,
      sortComparator: (a, b) => String(a ?? '').localeCompare(String(b ?? '')),
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
      field: 'revenue_365',
      headerName: '365D Rev',
      type: 'number',
      width: 120,
      cellClassName: 'mn',
      renderCell: (p) => <span>{fm(p.value)}</span>,
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
      field: 'last_invoice_date',
      headerName: 'Last Sale',
      width: 105,
      cellClassName: 'mn',
      renderCell: (p) => (
        <div style={{ lineHeight: 1.25 }}>
          <div>{fd(p.row.last_invoice_date)}</div>
          {p.row.inactive_reason && <div style={{ fontSize: 9, color: 'var(--mt)' }}>{p.row.inactive_reason}</div>}
        </div>
      ),
    },
    {
      field: 'ar_overdue',
      headerName: 'Overdue AR',
      type: 'number',
      width: 125,
      cellClassName: 'mn',
      renderCell: (p) => (
        <div style={{ lineHeight: 1.25, color: Number(p.row.ar_overdue || 0) > 0 ? 'var(--rd)' : undefined }}>
          <div>{fm(p.row.ar_overdue)}</div>
          {p.row.days_oldest_overdue ? <div style={{ fontSize: 9, color: 'var(--mt)' }}>{p.row.days_oldest_overdue}d oldest</div> : null}
        </div>
      ),
    },
    {
      field: 'future_invoice_count',
      headerName: 'Future',
      type: 'number',
      width: 92,
      cellClassName: 'mn',
      renderCell: (p) => p.row.future_invoice_count > 0 ? (
        <span title={p.row.future_last_invoice_date ? `Last future invoice ${fd(p.row.future_last_invoice_date)}` : undefined}>
          {fmtNum(p.row.future_invoice_count)} · {fm(p.row.future_revenue)}
        </span>
      ) : <span style={{ color: 'var(--mt)' }}>—</span>,
    },
    {
      field: 'cost_coverage_pct',
      headerName: 'Cost Cov',
      type: 'number',
      width: 95,
      cellClassName: 'mn',
      renderCell: (p) => (
        <span style={{ color: p.row.cost_coverage_pct != null && p.row.cost_coverage_pct < 0.95 ? 'var(--am)' : undefined }}>
          {fmtPct(p.row.cost_coverage_pct)}
        </span>
      ),
    },
    {
      field: 'top_item_share_pct',
      headerName: 'Top Item',
      type: 'number',
      width: 165,
      renderCell: (p) => (
        <div style={{ minWidth: 0, overflow: 'hidden', lineHeight: 1.25 }}>
          <div className="mn">{fmtPct(p.row.top_item_share_pct)}</div>
          <div title={p.row.top_item_name ?? undefined} style={{ fontSize: 9, color: 'var(--mt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.row.top_item_name ?? '—'}
          </div>
        </div>
      ),
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
    {
      field: 'lifecycle_status',
      headerName: 'Inactive Sync',
      width: 135,
      sortable: false,
      renderCell: (p: GridRenderCellParams<CustomerGridRow>) => {
        const busy = !!processing[p.row.qbo_customer_id];
        if (p.row.lifecycle_status) {
          const color = p.row.lifecycle_status === 'blocked' || p.row.lifecycle_status.includes('failed') ? 'var(--rd)' : 'var(--ac)';
          return (
            <span title={p.row.lifecycle_last_error ?? p.row.lifecycle_status} style={{ color, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>
              {p.row.lifecycle_status.replace(/_/g, ' ')}
            </span>
          );
        }
        if (!p.row.can_inactivate) return <span style={{ color: 'var(--mt)', fontSize: 10 }}>—</span>;
        return (
          <button
            className="tb-btn"
            title="Inactivate in Service Fusion, then QBO"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              runOne(p.row);
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px' }}
          >
            {busy ? <RefreshCw size={12} strokeWidth={2.2} aria-hidden="true" /> : <Archive size={12} strokeWidth={2.2} aria-hidden="true" />}
            <span>{busy ? 'Running' : 'Run'}</span>
          </button>
        );
      },
    },
  ], [processing]);

  function exportCsv() {
    if (!gridRows || gridRows.length === 0) return;
    const head = ['Customer', 'Active', 'Next Action', 'Inactive Reason', 'Last Sale', 'State', 'Channel', 'YTD Revenue', '365D Revenue', 'Overdue AR', 'Future Invoices', 'Cost Coverage', 'Top Item Share', 'Lifecycle Status', 'Invoices', 'RFM Segment', 'RFM Total'];
    const data = gridRows.map((r) => [
      r.display_name,
      r.active ? 'Y' : 'N',
      r.next_action ?? '',
      r.inactive_reason ?? '',
      r.last_invoice_date ?? '',
      r.state ?? '',
      r.primary_channel ?? '',
      Number(r.ytd_revenue ?? 0).toFixed(2),
      Number(r.revenue_365 ?? 0).toFixed(2),
      Number(r.ar_overdue ?? 0).toFixed(2),
      r.future_invoice_count,
      r.cost_coverage_pct == null ? '' : (r.cost_coverage_pct * 100).toFixed(1) + '%',
      r.top_item_share_pct == null ? '' : (r.top_item_share_pct * 100).toFixed(1) + '%',
      r.lifecycle_status ?? '',
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
            {filtered ? `${fmtNum(gridRows.length)} customers` : 'loading...'}
            {channel ? ` · ${channel}` : ''}{showInactive ? ' · including inactive' : ''}{reviewInactive ? ' · inactive review' : ''}
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
                '& .MuiInputBase-root': { background: 'var(--ctl-bg)', fontSize: 12, color: 'var(--tx)', height: 30, paddingY: 0 },
                '& .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--ctl-bd)' },
                '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--ac)' },
              }}
              renderInput={(params) => <TextField {...params} placeholder="All channels" />}
            />
          </div>

          <label className="toolbar-section" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} style={{ accentColor: 'var(--ac)' }} />
            <span className="toolbar-label" style={{ cursor: 'pointer' }}>Show inactive</span>
          </label>

          <label className="toolbar-section" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={reviewInactive} onChange={(e) => setReviewInactive(e.target.checked)} style={{ accentColor: 'var(--ac)' }} />
            <span className="toolbar-label" style={{ cursor: 'pointer' }}>Dormant review</span>
          </label>

          <div className="toolbar-spacer" />

          <button
            onClick={runDormantBatch}
            disabled={bulkBusy || !gridRows.some((r) => r.can_inactivate && !r.lifecycle_status)}
            className="tb-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            title="Runs the first five safe dormant customers in this view"
          >
            {bulkBusy ? <RefreshCw size={13} strokeWidth={2.4} aria-hidden="true" /> : <Archive size={13} strokeWidth={2.4} aria-hidden="true" />}
            <span>{bulkBusy ? 'Running' : 'Run 5 dormant'}</span>
          </button>
          <button onClick={exportCsv} disabled={!gridRows?.length} className="tb-btn tb-btn--primary">Export CSV</button>
        </div>
      </div>

      {rows && (
        <div className="gr" style={{ marginBottom: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <div className="kpi-card">
            <div className="kpi-label">ACTIVE</div>
            <div className="kpi-value">{fmtNum(summary.active)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">REVIEW INACTIVE</div>
            <div className="kpi-value" style={{ color: summary.reviewInactive > 0 ? 'var(--am)' : undefined }}>{fmtNum(summary.reviewInactive)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">COLLECT AR</div>
            <div className="kpi-value" style={{ color: summary.collectAr > 0 ? 'var(--rd)' : undefined }}>{fmtNum(summary.collectAr)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">QUEUED</div>
            <div className="kpi-value" style={{ color: summary.queued > 0 ? 'var(--ac)' : undefined }}>{fmtNum(summary.queued)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">QBO INACTIVE</div>
            <div className="kpi-value">{fmtNum(summary.inactive)}</div>
          </div>
        </div>
      )}

      {err ? (
        <div className="cd" style={{ padding: 14, color: 'var(--rd)' }}>Error: {err}</div>
      ) : !filtered ? (
        <div className="cd" style={{ padding: 0 }}>
          <TableSkeleton rows={10} cols={12} />
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
            {...GRID_DEFAULTS}
            pageSizeOptions={[10, 25, 50, 100, 250, { value: -1, label: 'All' }]}
            initialState={{
              pagination: { paginationModel: { pageSize: 50, page: 0 } },
              pinnedColumns: { left: ['display_name', 'next_action'] },
              sorting: { sortModel: [{ field: 'priority_score', sort: 'desc' }] },
            }}
            disableRowSelectionOnClick
            onRowClick={(params: GridRowParams<CustomerGridRow>) => {
              window.location.hash = '#customer-' + params.row.qbo_customer_id;
            }}
            sx={{ ...GRID_SX, '& .MuiDataGrid-row': { cursor: 'pointer' } }}
          />
        </div>
      )}
    </div>
  );
}
