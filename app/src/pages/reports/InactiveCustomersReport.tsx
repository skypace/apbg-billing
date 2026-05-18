import { useEffect, useMemo, useState } from 'react';
import type { GridColDef } from '@mui/x-data-grid-pro';
import { KPICard } from '../../components/KPICard';
import { CustomerLink } from '../../components/CustomerLink';
import { ReportGrid } from '../../components/ReportGrid';
import { fm } from '../../lib/formatters';
import { InactiveCustomerRow, fetchInactiveCustomers } from '../../lib/reports';

interface InactiveGridRow extends InactiveCustomerRow {
  id: string;
}

export function InactiveCustomersReport() {
  const today = new Date();
  const ytdStart = today.getFullYear() + '-01-01';
  const todayStr = today.toISOString().slice(0, 10);
  const priorYearStart = (today.getFullYear() - 1) + '-01-01';
  const priorYearEnd = (today.getFullYear() - 1) + '-12-31';

  const [f, setF] = useState({
    current_start: ytdStart,
    current_end: todayStr,
    prior_start: priorYearStart,
    prior_end: priorYearEnd,
    min_prior: 1000,
    max_current: 0,
  });
  const [rows, setRows] = useState<InactiveCustomerRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      fetchInactiveCustomers({
        current_start: f.current_start,
        current_end: f.current_end,
        prior_start: f.prior_start,
        prior_end: f.prior_end,
        min_prior_rev: Number(f.min_prior) || 1000,
        max_current_rev: Number(f.max_current) || 0,
        limit: 200,
      })
        .then((rs) => { if (!cancelled) { setRows(rs); setLoading(false); } })
        .catch(() => { if (!cancelled) { setRows([]); setLoading(false); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [f.current_start, f.current_end, f.prior_start, f.prior_end, f.min_prior, f.max_current]);

  const gridRows: InactiveGridRow[] = useMemo(
    () => (rows ?? []).map((r) => ({ ...r, id: r.qbo_customer_id })),
    [rows],
  );

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'customer_name', headerName: 'Customer', flex: 2, minWidth: 220,
      renderCell: (p) => (
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <CustomerLink qboCustomerId={p.row.qbo_customer_id} name={p.row.customer_name} />
        </span>
      ),
    },
    { field: 'primary_channel', headerName: 'Channel', width: 160,
      valueFormatter: (v) => (v == null ? '—' : String(v)) },
    { field: 'bill_state', headerName: 'State', width: 80, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : String(v)) },
    {
      field: 'prior_revenue', headerName: 'Prior Rev', type: 'number', width: 130, cellClassName: 'mn',
      renderCell: (p) => <span style={{ fontWeight: 600, color: 'var(--am)' }}>{fm(p.value)}</span>,
    },
    { field: 'current_revenue', headerName: 'Current Rev', type: 'number', width: 130, cellClassName: 'mn',
      valueFormatter: (v) => fm(v) },
    { field: 'last_invoice_date', headerName: 'Last Invoice', width: 130, cellClassName: 'mn',
      valueFormatter: (v) => (v == null ? '—' : String(v)) },
  ], []);

  if (!rows) return <div className="ld">Loading…</div>;

  const totalLost = rows.reduce((s, r) => s + Number(r.prior_revenue || 0), 0);
  const withChannel = rows.filter((r) => r.primary_channel).length;
  const biggest = rows[0];

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="INACTIVE CUSTOMERS" value={rows.length}
          accent={rows.length > 0 ? 'var(--am)' : 'var(--gn)'} />
        <KPICard title="PRIOR REV AT RISK" value={fm(totalLost)} accent="var(--am)"
          sub="prior period revenue not repeating" />
        <KPICard title="BIGGEST LOSS" value={biggest ? fm(biggest.prior_revenue) : '—'}
          sub={biggest?.customer_name ?? ''} />
        <KPICard title="WITH CHANNEL" value={withChannel} sub="have a classified channel" />
      </div>

      <div className="toolbar" style={{ marginBottom: 10 }}>
        <div className="toolbar-row">
          <div className="toolbar-section">
            <span className="toolbar-label">Prior</span>
            <input type="date" value={f.prior_start}
              onChange={(e) => setF({ ...f, prior_start: e.target.value })} className="date-input" />
            <span style={{ color: 'var(--mt)', fontSize: 11 }}>to</span>
            <input type="date" value={f.prior_end}
              onChange={(e) => setF({ ...f, prior_end: e.target.value })} className="date-input" />
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">Current</span>
            <input type="date" value={f.current_start}
              onChange={(e) => setF({ ...f, current_start: e.target.value })} className="date-input" />
            <span style={{ color: 'var(--mt)', fontSize: 11 }}>to</span>
            <input type="date" value={f.current_end}
              onChange={(e) => setF({ ...f, current_end: e.target.value })} className="date-input" />
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">Min prior $</span>
            <input type="number" value={f.min_prior}
              onChange={(e) => setF({ ...f, min_prior: Number(e.target.value) })}
              className="date-input" style={{ width: 80 }} />
          </div>
          <div className="toolbar-section">
            <span className="toolbar-label">Max current $</span>
            <input type="number" value={f.max_current}
              onChange={(e) => setF({ ...f, max_current: Number(e.target.value) })}
              className="date-input" style={{ width: 80 }} />
          </div>
        </div>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div className="ld">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="ld">No inactive customers in this window — everyone is buying.</div>
        ) : (
          <ReportGrid
            rows={gridRows}
            columns={columns}
            pinnedLeft={['customer_name']}
            defaultSort={[{ field: 'prior_revenue', sort: 'desc' }]}
          />
        )}
      </div>
    </div>
  );
}
