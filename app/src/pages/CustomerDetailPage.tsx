import { useEffect, useMemo, useState } from 'react';
import dayjs, { Dayjs } from 'dayjs';
import { AlertTriangle, ArrowLeft, Printer } from 'lucide-react';
import { DateRangePicker } from '@mui/x-date-pickers-pro/DateRangePicker';
import { KPICard } from '../components/KPICard';
import { SegmentChip } from '../components/SegmentChip';
import { fm, fp, fmtNum } from '../lib/formatters';
import { downloadCsv, toCsv } from '../lib/csv';
import { useToast } from '../lib/toast';
import { KpiRowSkeleton, HeroSkeleton } from '../components/Skeletons';
import {
  CustomerDetail,
  CustomerHealth,
  CustomerScorecard,
  DrillRow,
  fetchCustomerDetail,
  fetchCustomerHealth,
  fetchCustomerScorecard,
  fetchInvoiceLines,
} from '../lib/customers';
import {
  Dim,
  SalesPivotRow,
  SparklineRow,
  fetchPivot,
  fetchSparkline,
  trailing12MonthKeys,
} from '../lib/sales';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { GRID_SX, GRID_DEFAULTS } from '../lib/gridStyles';

interface Props { customerId: string }

type InvoiceGridRow = DrillRow & { _gid: string };

const ITEM_COLUMNS: GridColDef<SalesPivotRow>[] = [
  { field: 'dim_label', headerName: 'Item', flex: 1, minWidth: 200, renderCell: (p) => <span style={{ fontSize: 11 }} title={p.row.dim_label}>{p.row.dim_label}</span> },
  { field: 'qty', headerName: 'Qty', type: 'number', width: 90, cellClassName: 'mn', valueGetter: (_v, row) => row.qty != null ? Number(row.qty) : null, renderCell: (p) => <span style={{ fontSize: 11 }}>{p.row.qty != null ? fmtNum(p.row.qty) : '-'}</span> },
  { field: 'revenue', headerName: 'Revenue', type: 'number', width: 120, cellClassName: 'mn', valueGetter: (_v, row) => Number(row.revenue ?? 0), renderCell: (p) => <span style={{ fontSize: 11, fontWeight: 600 }}>{fm(p.row.revenue)}</span> },
  {
    field: 'margin_pct', headerName: 'Margin %', type: 'number', width: 100, cellClassName: 'mn',
    valueGetter: (_v, row) => row.margin_pct != null ? Number(row.margin_pct) : -Infinity,
    renderCell: (p) => {
      const mp = p.row.margin_pct != null ? Number(p.row.margin_pct) : null;
      const c = mp == null ? 'var(--mt)' : mp >= 0.4 ? 'var(--gn)' : mp >= 0 ? 'var(--am)' : 'var(--rd)';
      return <span style={{ fontSize: 11, color: c }}>{fp(p.row.margin_pct)}</span>;
    },
  },
];

const INVOICE_COLUMNS: GridColDef<InvoiceGridRow>[] = [
  { field: 'txn_date', headerName: 'Date', width: 100, cellClassName: 'mn', renderCell: (p) => <span style={{ fontSize: 11 }}>{p.row.txn_date}</span> },
  { field: 'doc_number', headerName: 'Doc#', width: 90, cellClassName: 'mn', renderCell: (p) => <span style={{ fontSize: 11, color: 'var(--mt)' }}>{p.row.doc_number ?? '—'}</span> },
  { field: 'item_name', headerName: 'Item', flex: 1, minWidth: 200, renderCell: (p) => <span style={{ fontSize: 11 }} title={p.row.item_name ?? p.row.description ?? ''}>{p.row.item_name ?? p.row.description ?? '—'}</span> },
  { field: 'quantity', headerName: 'Qty', type: 'number', width: 80, cellClassName: 'mn', valueGetter: (_v, row) => row.quantity != null ? Number(row.quantity) : null, renderCell: (p) => <span style={{ fontSize: 11 }}>{p.row.quantity != null ? fmtNum(p.row.quantity) : '-'}</span> },
  { field: 'unit_price', headerName: 'Price', type: 'number', width: 100, cellClassName: 'mn', valueGetter: (_v, row) => row.unit_price != null ? Number(row.unit_price) : null, renderCell: (p) => <span style={{ fontSize: 11 }}>{p.row.unit_price != null ? fm(p.row.unit_price) : '-'}</span> },
  { field: 'revenue', headerName: 'Revenue', type: 'number', width: 110, cellClassName: 'mn', valueGetter: (_v, row) => Number(row.revenue ?? 0), renderCell: (p) => <span style={{ fontSize: 11, fontWeight: 600 }}>{fm(p.row.revenue)}</span> },
  { field: 'est_margin', headerName: 'Margin', type: 'number', width: 100, cellClassName: 'mn', valueGetter: (_v, row) => row.est_margin != null ? Number(row.est_margin) : null, renderCell: (p) => <span style={{ fontSize: 11 }}>{p.row.est_margin != null ? fm(p.row.est_margin) : '—'}</span> },
];

export function CustomerDetailPage({ customerId }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const ytdStart = new Date().getFullYear() + '-01-01';
  const toast = useToast();

  const [start, setStart] = useState(ytdStart);
  const [end, setEnd] = useState(today);
  const [detail, setDetail] = useState<CustomerDetail | null | undefined>(undefined);
  const [health, setHealth] = useState<CustomerHealth | null>(null);
  const [scorecard, setScorecard] = useState<CustomerScorecard | null | undefined>(undefined);
  const [items, setItems] = useState<SalesPivotRow[] | null>(null);
  const [monthly, setMonthly] = useState<SparklineRow[]>([]);
  const [invoices, setInvoices] = useState<DrillRow[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    fetchCustomerHealth(365)
      .then((rs) => setHealth(rs.find((h) => h.qbo_customer_id === customerId) ?? null))
      .catch(() => setHealth(null));
  }, [customerId]);

  useEffect(() => {
    let cancelled = false;
    setScorecard(undefined);
    fetchCustomerScorecard(customerId, 365)
      .then((sc) => { if (!cancelled) setScorecard(sc); })
      .catch(() => { if (!cancelled) setScorecard(null); });
    return () => { cancelled = true; };
  }, [customerId]);

  useEffect(() => {
    let cancelled = false;
    setDetail(undefined);
    setItems(null);
    setInvoices(null);
    setMonthly([]);
    setErr('');

    (async () => {
      try {
        const d = await fetchCustomerDetail(customerId, start, end);
        if (cancelled) return;
        setDetail(d);
        if (!d) { setItems([]); setInvoices([]); return; }

        const custName = d.display_name;
        const [pivot, spark, drill] = await Promise.all([
          fetchPivot('item' as Dim, {
            start, end,
            customers: [custName],
          }, 200),
          fetchSparkline('customer' as Dim, [custName], end, {
            start, end,
            customers: [custName],
          }),
          fetchInvoiceLines({
            dim: 'customer',
            dim_label: custName,
            start, end,
            customers: [custName],
            limit: 300,
          }),
        ]);
        if (cancelled) return;
        setItems(pivot ?? []);
        setMonthly(spark ?? []);
        setInvoices(drill ?? []);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();

    return () => { cancelled = true; };
  }, [customerId, start, end]);

  const monthVals = useMemo(() => {
    const keys = trailing12MonthKeys(end);
    const map = new Map<string, number>();
    for (const m of monthly) map.set(m.ym, Number(m.revenue || 0));
    return keys.map((k) => ({ ym: k, value: map.get(k) ?? 0 }));
  }, [monthly, end]);

  function exportInvoicesCsv() {
    if (!invoices || invoices.length === 0 || !detail) return;
    const head = ['Date', 'Doc#', 'Item', 'Qty', 'Unit Price', 'Revenue', 'Est Cost', 'Est Margin'];
    const data = invoices.map((r) => [
      r.txn_date,
      r.doc_number ?? '',
      r.item_name ?? '',
      r.quantity ?? '',
      r.unit_price != null ? Number(r.unit_price).toFixed(2) : '',
      Number(r.revenue ?? 0).toFixed(2),
      r.est_cost != null ? Number(r.est_cost).toFixed(2) : '',
      r.est_margin != null ? Number(r.est_margin).toFixed(2) : '',
    ]);
    downloadCsv(
      `${detail.display_name.replace(/\s+/g, '_')}_invoices_${start}_${end}.csv`,
      toCsv([head, ...data]),
    );
    toast.success('Exported ' + data.length + ' invoice lines');
  }

  function onRangeChange(value: [Dayjs | null, Dayjs | null]) {
    const [s, e] = value;
    if (s && e) {
      setStart(s.format('YYYY-MM-DD'));
      setEnd(e.format('YYYY-MM-DD'));
    }
  }

  async function printScorecard() {
    if (!detail) return;
    let sc: CustomerScorecard | null = scorecard?.qbo_customer_id === customerId ? scorecard : null;
    if (!sc) {
      sc = await fetchCustomerScorecard(customerId, 365);
    }
    if (!sc) {
      toast.warn('No scorecard data available');
      return;
    }
    const w = window.open('', '_blank');
    if (!w) {
      toast.error('Popup blocked. Allow popups for this site.');
      return;
    }

    const itemRows = (items ?? []).slice(0, 10).map((r) => {
      const mp = r.margin_pct != null ? Number(r.margin_pct) : null;
      return `<tr><td>${escapeHtml(r.dim_label)}</td><td style="text-align:right">${
        r.qty != null ? Number(r.qty).toLocaleString() : '-'
      }</td><td style="text-align:right">${fm(r.revenue)}</td><td style="text-align:right">${
        mp != null ? (mp * 100).toFixed(1) + '%' : '-'
      }</td></tr>`;
    }).join('');

    const max = Math.max(...monthVals.map((m) => m.value), 1);
    const bars = monthVals.map((m) => {
      const h = max ? Math.max(2, (m.value / max) * 90) : 2;
      return `<div style="display:inline-block;width:7%;text-align:center;font-size:8px;color:#888"><div style="display:inline-block;width:60%;height:${h}px;background:#0ea5b8;vertical-align:bottom"></div><div>${m.ym.slice(2)}</div></div>`;
    }).join('');
    const futureCount = Number(sc.future_invoice_count ?? 0);
    const futureNote = futureCount > 0
      ? `<div class="note"><strong>Future-dated QBO invoices</strong><span>${futureCount} invoice${futureCount === 1 ? '' : 's'} · ${fm(sc.future_revenue)} · latest ${escapeHtml(sc.future_last_invoice_date ?? '-')}</span></div>`
      : '';

    w.document.write(`<!doctype html><html><head><title>Scorecard — ${escapeHtml(sc.customer_name)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;color:#0a0e17;max-width:780px;margin:24px auto;padding:0 24px}
h1{font-size:22px;margin:0 0 4px;color:#0a0e17;border-bottom:2px solid #0ea5b8;padding-bottom:6px}
h2{font-size:13px;letter-spacing:1px;color:#64748b;margin:18px 0 8px;text-transform:uppercase}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{padding:5px 8px;border-bottom:1px solid #e2e8f0;text-align:left}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:10px 0 18px}
.kpi{border:1px solid #e2e8f0;padding:8px 10px;border-radius:4px}
.kpi .l{font-size:9px;color:#64748b;letter-spacing:1px;text-transform:uppercase}
.kpi .v{font-size:16px;font-weight:700;margin-top:2px}
.kpi .s{font-size:10px;color:#64748b;margin-top:2px}
.bar{height:120px;border-bottom:1px solid #e2e8f0;display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:18px}
.seg{display:inline-block;background:rgba(14,165,184,0.1);color:#0ea5b8;border:1px solid #0ea5b8;border-radius:14px;padding:2px 10px;font-size:10px;font-weight:700;letter-spacing:.5px}
.note{border:1px solid #f59e0b;background:#fffbeb;color:#92400e;border-radius:4px;padding:8px 10px;margin:10px 0;font-size:11px;display:flex;justify-content:space-between;gap:14px}
@media print { body { margin: 0 } }
</style></head><body>
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
  <div><h1>${escapeHtml(sc.customer_name)}</h1>
    <div style="font-size:11px;color:#64748b;margin-top:3px">
      ${escapeHtml(sc.bill_city ?? '')}${sc.bill_city && sc.bill_state ? ', ' : ''}${escapeHtml(sc.bill_state ?? '')}
       · ${escapeHtml(sc.primary_channel ?? 'no channel')}
    </div>
  </div>
  <div>
    <span class="seg">${escapeHtml((sc.rfm_segment ?? 'unscored').toUpperCase())}</span>
    <div style="font-size:10px;color:#64748b;margin-top:4px;text-align:right">
      RFM ${sc.rfm_total ?? '-'}/15
       · R${sc.r_score ?? '-'} F${sc.f_score ?? '-'} M${sc.m_score ?? '-'}
    </div>
  </div>
</div>
${futureNote}
<div class="kpis">
  <div class="kpi"><div class="l">YTD Revenue</div><div class="v">${fm(sc.ytd_revenue)}</div><div class="s">vs LYTD ${fm(sc.prior_ytd_revenue)} · ${deltaText(sc.ytd_revenue_delta_pct)}</div></div>
  <div class="kpi"><div class="l">365d Revenue</div><div class="v">${fm(sc.window_revenue)}</div><div class="s">prior ${fm(sc.prior_window_revenue)} · ${deltaText(sc.window_revenue_delta_pct)}</div></div>
  <div class="kpi"><div class="l">Avg Order Value</div><div class="v">${fm(sc.avg_order_value)}</div><div class="s">recency: ${sc.recency_days != null ? sc.recency_days + 'd' : '-'}</div></div>
  <div class="kpi"><div class="l">Est Margin</div><div class="v">${fm(sc.est_margin)}</div><div class="s">${fp(sc.est_margin_pct)} · costed ${fp(sc.cost_coverage_pct)}</div></div>
  <div class="kpi"><div class="l">AR Risk</div><div class="v">${fm(sc.ar_balance)}</div><div class="s">${fm(sc.ar_overdue)} overdue · ${fm(sc.ar_90_plus)} 90+</div></div>
  <div class="kpi"><div class="l">Top Item Share</div><div class="v">${fp(sc.top_item_share_pct)}</div><div class="s">${escapeHtml(sc.top_item_name ?? 'No item')} · ${fm(sc.top_item_revenue)}</div></div>
</div>
<h2>Trailing-12-Month Revenue</h2>
<div class="bar">${bars}</div>
<h2>Top Items (last 365d)</h2>
<table><thead><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Revenue</th><th style="text-align:right">Margin %</th></tr></thead><tbody>
${itemRows || '<tr><td colspan="4" style="text-align:center;color:#64748b">No items in window</td></tr>'}
</tbody></table>
<div style="margin-top:24px;font-size:9px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:6px">
  Generated ${new Date().toISOString().slice(0, 10)} · BRIX Refractor · Customer first seen ${escapeHtml(sc.first_invoice_date ?? '-')}
</div>
<script>setTimeout(function(){window.print()}, 350);</script>
</body></html>`);
    w.document.close();
  }

  if (detail === undefined) return (
    <div>
      <HeroSkeleton />
      <KpiRowSkeleton count={5} />
    </div>
  );
  if (detail === null) {
    return (
      <div>
        <div className="hero">
          <div>
            <div className="hero-eyebrow">Customer not found</div>
            <h1 className="hero-title">Unknown</h1>
            <div className="hero-meta">
              <a href="#customers">← back to Customers</a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const addr = [detail.bill_addr_line1, detail.bill_addr_city, detail.bill_addr_state, detail.bill_addr_postal]
    .filter(Boolean).join(', ');
  const max = Math.max(...monthVals.map((m) => m.value), 1);
  const sc = scorecard?.qbo_customer_id === customerId ? scorecard : null;
  const segLabel = sc?.rfm_segment ?? health?.rfm_segment ?? '—';
  const rScore = sc?.r_score ?? health?.r_score ?? null;
  const fScore = sc?.f_score ?? health?.f_score ?? null;
  const mScore = sc?.m_score ?? health?.m_score ?? null;
  const rfmTotal = sc?.rfm_total ?? health?.rfm_total ?? null;
  const recencyDays = sc?.recency_days ?? health?.recency_days ?? null;
  const frequency = sc?.frequency ?? health?.frequency ?? null;
  const monetary = sc?.monetary ?? health?.monetary ?? null;
  const ytdDelta = toFinite(sc?.ytd_revenue_delta_pct);
  const windowDelta = toFinite(sc?.window_revenue_delta_pct);
  const marginPct = toFinite(sc?.est_margin_pct ?? detail.current_margin_pct);
  const costCoverage = toFinite(sc?.cost_coverage_pct);
  const topItemShare = toFinite(sc?.top_item_share_pct);
  const arBalance = toFinite(sc?.ar_balance) ?? Number(detail.ar_balance ?? 0);
  const arOverdue = toFinite(sc?.ar_overdue) ?? Number(detail.ar_overdue ?? 0);
  const ar90Plus = toFinite(sc?.ar_90_plus) ?? 0;
  const arAccent = ar90Plus > 0 ? 'var(--rd)' : arOverdue > 0 ? 'var(--am)' : 'var(--gn)';
  const marginAccent = marginPct == null ? undefined : marginPct >= 0.4 ? 'var(--gn)' : marginPct >= 0 ? 'var(--am)' : 'var(--rd)';
  const costAccent = costCoverage == null ? undefined : costCoverage >= 0.95 ? 'var(--gn)' : costCoverage >= 0.8 ? 'var(--am)' : 'var(--rd)';
  const topItemAccent = topItemShare == null ? undefined : topItemShare >= 0.5 ? 'var(--am)' : 'var(--ac)';
  const futureInvoiceCount = Number(sc?.future_invoice_count ?? 0);
  const futureRevenue = Number(sc?.future_revenue ?? 0);

  return (
    <div>
      <div className="hero">
        <div style={{ flex: 1 }}>
          <div
            className="hero-eyebrow"
            style={{ display: 'flex', alignItems: 'center', gap: 12 }}
          >
            <a
              href="#customers"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                color: 'var(--mt)',
                textTransform: 'none',
                letterSpacing: 0,
                fontSize: 11,
              }}
            >
              <ArrowLeft size={12} strokeWidth={2.4} aria-hidden="true" /> Customers
            </a>
            <span style={{ color: 'var(--mt)' }}>·</span>
            <span>Customer · {segLabel.toUpperCase()}</span>
          </div>
          <h1
            className="hero-title"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <span>{detail.display_name}</span>
            {detail.is_sub_customer && <span className="bg bg-p">SUB</span>}
            {!detail.active && <span className="bg bg-p">INACTIVE</span>}
          </h1>
          <div className="hero-meta">
            {addr || '— no address —'}
            {detail.primary_channel ? ` · ${detail.primary_channel}` : ''}
          </div>
        </div>
        <button
          onClick={printScorecard}
          className="tb-btn tb-btn--primary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Printer size={13} strokeWidth={2.4} aria-hidden="true" />
          <span>Print scorecard</span>
        </button>
      </div>

      <div
        className="cd"
        style={{
          padding: '12px 16px',
          marginBottom: 14,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 14,
        }}
      >
        <div>
          <div style={{ fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Channel
          </div>
          <div style={{ fontSize: 13, marginTop: 3 }}>
            {detail.primary_channel ?? '— no channel —'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>Address</div>
          {detail.bill_addr_line1 || detail.bill_addr_city || detail.bill_addr_state || detail.bill_addr_postal ? (
            <div style={{ fontSize: 12, marginTop: 3, lineHeight: 1.45 }}>
              {detail.bill_addr_line1 && <div>{detail.bill_addr_line1}</div>}
              <div>
                {[detail.bill_addr_city, detail.bill_addr_state].filter(Boolean).join(', ')}
                {detail.bill_addr_postal ? ` ${detail.bill_addr_postal}` : ''}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, marginTop: 3, color: 'var(--mt)' }}>— no address —</div>
          )}
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>Contact</div>
          <div style={{ fontSize: 12, marginTop: 3 }}>
            {[detail.email, detail.phone].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>
            QBO Customer Type
          </div>
          <div style={{ fontSize: 12, marginTop: 3 }}>{detail.customer_type_name ?? '— not set in QBO —'}</div>
        </div>
      </div>

      {futureInvoiceCount > 0 && (
        <div
          className="cd"
          style={{
            padding: '10px 14px',
            marginBottom: 14,
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            borderColor: 'rgba(244,180,0,0.45)',
            background: 'rgba(244,180,0,0.08)',
          }}
        >
          <AlertTriangle size={16} strokeWidth={2.3} color="var(--am)" aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 9, color: 'var(--am)', textTransform: 'uppercase', letterSpacing: 1 }}>
              Future-dated QBO invoices
            </div>
            <div style={{ fontSize: 11, color: 'var(--tx2)', marginTop: 2 }}>
              {futureInvoiceCount} invoice{futureInvoiceCount === 1 ? '' : 's'} · {fm(futureRevenue)}
              {sc?.future_last_invoice_date ? ` · latest ${sc.future_last_invoice_date}` : ''}
              {' '}excluded from recency until the invoice date.
            </div>
          </div>
        </div>
      )}

      <div className="gr" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginBottom: 14, gap: 14 }}>
        <KPICard
          title="YTD REVENUE"
          value={fm(sc?.ytd_revenue ?? detail.current_revenue)}
          deltaPct={ytdDelta}
          sub={sc ? `vs LYTD ${fm(sc.prior_ytd_revenue)} · ${detail.current_invoice_count} invoices` : `${detail.current_invoice_count} invoices · ${detail.current_line_count} lines`}
        />
        <KPICard
          title="365D REVENUE"
          value={sc ? fm(sc.window_revenue) : '—'}
          deltaPct={windowDelta}
          sub={sc ? `prior ${fm(sc.prior_window_revenue)} · ${sc.total_invoices ?? 0} invoices` : 'scorecard loading'}
        />
        <KPICard
          title="EST MARGIN"
          value={sc ? fm(sc.est_margin) : detail.current_est_margin != null ? fm(detail.current_est_margin) : '—'}
          accent={marginAccent}
          sub={`${fp(marginPct)} margin · ${sc ? fm(sc.avg_order_value) + ' avg order' : 'current period'}`}
        />
        <KPICard
          title="COST COVERAGE"
          value={costCoverage != null ? fp(costCoverage) : '—'}
          accent={costAccent}
          sub={sc ? `${fm(sc.window_revenue)} revenue checked` : 'scorecard loading'}
        />
        <KPICard
          title="TOP ITEM SHARE"
          value={topItemShare != null ? fp(topItemShare) : '—'}
          accent={topItemAccent}
          sub={sc?.top_item_name ? `${truncate(sc.top_item_name, 34)} · ${fm(sc.top_item_revenue)}` : 'no item in 365d'}
        />
        <KPICard
          title="AR RISK"
          value={fm(arBalance)}
          accent={arAccent}
          sub={
            arOverdue > 0
              ? `${fm(arOverdue)} overdue · ${fm(ar90Plus)} 90+`
              : `${sc?.open_invoice_count ?? 0} open invoices`
          }
        />
        <div className="cd kpi-card">
          <div className="kpi-head">
            <div className="kpi-title">HEALTH (RFM 365D)</div>
          </div>
          <div style={{ marginTop: 6 }}>
            {segLabel !== '—' ? (
              <>
                <SegmentChip segment={segLabel} size="md" />
                <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 6, fontFamily: 'var(--ff-mono)' }}>
                  R{rScore ?? '-'} F{fScore ?? '-'} M{mScore ?? '-'} · {recencyDays != null ? `${recencyDays}d ago` : 'no recency'}
                </div>
              </>
            ) : (
              <span style={{ color: 'var(--mt)', fontSize: 10 }}>no signal</span>
            )}
          </div>
          {segLabel !== '—' && (
            <div className="kpi-sub" style={{ marginTop: 6 }}>
              Score {rfmTotal ?? '-'}/15 · {frequency ?? '-'} invoices · {fm(monetary)}
            </div>
          )}
        </div>
      </div>

      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 14,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 11,
        }}
      >
        <span className="toolbar-label">Period</span>
        <DateRangePicker
          value={[dayjs(start), dayjs(end)]}
          onChange={onRangeChange}
          format="YYYY-MM-DD"
          localeText={{ start: 'From', end: 'To' }}
          slotProps={{
            textField: {
              size: 'small',
              sx: {
                width: 130,
                '& .MuiInputBase-root': {
                  height: 30,
                  fontFamily: 'var(--ff-mono)',
                  fontSize: 12,
                  background: 'var(--ctl-bg)',
                  color: 'var(--tx)',
                },
                '& .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--ctl-bd)' },
                '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--ac)' },
              },
            },
            fieldSeparator: { sx: { color: 'var(--mt)', mx: 0.5 } },
          }}
        />
      </div>

      <div className="gr g2" style={{ marginBottom: 14 }}>
        <div className="cd" style={{ padding: 0 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bd)' }}>
            <div className="ct" style={{ margin: 0 }}>TRAILING-12-MONTH REVENUE</div>
          </div>
          <div style={{ padding: '14px' }}>
            <svg width="100%" height={200} viewBox="0 0 600 200" preserveAspectRatio="none">
              {monthVals.map((m, i) => {
                const x = (i / Math.max(monthVals.length - 1, 1)) * 580 + 10;
                const bw = 580 / monthVals.length - 4;
                const bh = (m.value / max) * 170;
                return (
                  <g key={m.ym}>
                    <rect x={x - bw / 2} y={200 - bh - 16} width={bw} height={Math.max(bh, 1)} fill="var(--ac)" opacity={0.85} rx={2} />
                    <text x={x} y={195} fontSize={8} fill="var(--mt)" textAnchor="middle">
                      {m.ym.slice(2)}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        <div className="cd" style={{ padding: 0 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bd)' }}>
            <div className="ct" style={{ margin: 0 }}>
              TOP ITEMS — {items ? items.length : 0}
            </div>
          </div>
          <DataGridPro
            rows={items ?? []}
            columns={ITEM_COLUMNS}
            getRowId={(r) => r.dim_label}
            loading={items === null}
            density="compact"
            pagination
            disableRowSelectionOnClick
            {...GRID_DEFAULTS}
            pageSizeOptions={[10, 25, 50, { value: -1, label: 'All' }]}
            initialState={{
              pagination: { paginationModel: { pageSize: 10, page: 0 } },
              sorting: { sortModel: [{ field: 'revenue', sort: 'desc' }] },
            }}
            sx={{ ...GRID_SX, height: 340 }}
          />
        </div>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--bd)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div className="ct" style={{ margin: 0 }}>
            RECENT INVOICE LINES — {invoices ? invoices.length : 0}
          </div>
          <button
            onClick={exportInvoicesCsv}
            disabled={!invoices?.length}
            className="tb-btn tb-btn--primary"
          >
            Export CSV
          </button>
        </div>
        {err && <div className="cd" style={{ padding: 14, color: 'var(--rd)' }}>Error: {err}</div>}
        <DataGridPro
          rows={(invoices ?? []).map((r, i): InvoiceGridRow => ({ ...r, _gid: `${r.qbo_invoice_id ?? ''}-${i}` }))}
          columns={INVOICE_COLUMNS}
          getRowId={(r) => r._gid}
          loading={invoices === null}
          density="compact"
          pagination
          disableRowSelectionOnClick
          {...GRID_DEFAULTS}
          pageSizeOptions={[25, 50, 100, { value: -1, label: 'All' }]}
          initialState={{ pagination: { paginationModel: { pageSize: 25, page: 0 } } }}
          sx={{ ...GRID_SX, height: 420 }}
        />
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
      : c === '<' ? '&lt;'
        : c === '>' ? '&gt;'
          : c === '"' ? '&quot;'
            : '&#39;');
}

function toFinite(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function deltaText(v: unknown): string {
  const n = toFinite(v);
  if (n == null) return 'no prior';
  return n >= 0 ? '+' + fp(n) : fp(n);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 3)).trimEnd() + '...';
}
