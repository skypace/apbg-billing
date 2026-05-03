import { useEffect, useMemo, useState } from 'react';
import { KPICard } from '../components/KPICard';
import { SegmentChip } from '../components/SegmentChip';
import { fm, fp, fmtNum } from '../lib/formatters';
import { btnPrimary, inp } from '../lib/styles';
import { downloadCsv, toCsv } from '../lib/csv';
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

interface Props { customerId: string }

export function CustomerDetailPage({ customerId }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const ytdStart = new Date().getFullYear() + '-01-01';

  const [start, setStart] = useState(ytdStart);
  const [end, setEnd] = useState(today);
  const [detail, setDetail] = useState<CustomerDetail | null | undefined>(undefined);
  const [health, setHealth] = useState<CustomerHealth | null>(null);
  const [items, setItems] = useState<SalesPivotRow[] | null>(null);
  const [monthly, setMonthly] = useState<SparklineRow[]>([]);
  const [invoices, setInvoices] = useState<DrillRow[] | null>(null);
  const [err, setErr] = useState('');

  // Load RFM once.
  useEffect(() => {
    fetchCustomerHealth(365)
      .then((rs) => setHealth(rs.find((h) => h.qbo_customer_id === customerId) ?? null))
      .catch(() => setHealth(null));
  }, [customerId]);

  // Detail + items + monthly + invoices reload whenever window changes.
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

  // Build the trailing-12-month bar chart values.
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
  }

  async function printScorecard() {
    if (!detail) return;
    const sc: CustomerScorecard | null = await fetchCustomerScorecard(customerId, 365);
    if (!sc) return alert('No scorecard data available');
    const w = window.open('', '_blank');
    if (!w) return;

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

    w.document.write(`<!doctype html><html><head><title>Scorecard — ${escapeHtml(sc.customer_name)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;color:#0a0e17;max-width:780px;margin:24px auto;padding:0 24px}
h1{font-size:22px;margin:0 0 4px;color:#0a0e17;border-bottom:2px solid #0ea5b8;padding-bottom:6px}
h2{font-size:13px;letter-spacing:1px;color:#64748b;margin:18px 0 8px;text-transform:uppercase}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{padding:5px 8px;border-bottom:1px solid #e2e8f0;text-align:left}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:10px 0 18px}
.kpi{border:1px solid #e2e8f0;padding:8px 10px;border-radius:4px}
.kpi .l{font-size:9px;color:#64748b;letter-spacing:1px;text-transform:uppercase}
.kpi .v{font-size:16px;font-weight:700;margin-top:2px}
.kpi .s{font-size:10px;color:#64748b;margin-top:2px}
.bar{height:120px;border-bottom:1px solid #e2e8f0;display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:18px}
.seg{display:inline-block;background:rgba(14,165,184,0.1);color:#0ea5b8;border:1px solid #0ea5b8;border-radius:14px;padding:2px 10px;font-size:10px;font-weight:700;letter-spacing:.5px}
@media print { body { margin: 0 } }
</style></head><body>
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
  <div><h1>${escapeHtml(sc.customer_name)}</h1>
    <div style="font-size:11px;color:#64748b;margin-top:3px">
      ${escapeHtml(sc.bill_city ?? '')}${sc.bill_city && sc.bill_state ? ', ' : ''}${escapeHtml(sc.bill_state ?? '')}
       · ${escapeHtml(sc.primary_channel ?? 'no channel')}
       · rep: ${escapeHtml(sc.primary_sales_rep ?? 'unassigned')}
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
<div class="kpis">
  <div class="kpi"><div class="l">YTD Revenue</div><div class="v">${fm(sc.ytd_revenue)}</div><div class="s">${sc.total_invoices ?? 0} invoices · last ${escapeHtml(sc.last_invoice_date ?? '-')}</div></div>
  <div class="kpi"><div class="l">Prior Year</div><div class="v">${fm(sc.prior_year_revenue)}</div><div class="s">365d window</div></div>
  <div class="kpi"><div class="l">Avg Order Value</div><div class="v">${fm(sc.avg_order_value)}</div><div class="s">recency: ${sc.recency_days != null ? sc.recency_days + 'd' : '-'}</div></div>
  <div class="kpi"><div class="l">Est Margin %</div><div class="v">${sc.est_margin_pct != null ? (Number(sc.est_margin_pct) * 100).toFixed(1) + '%' : '—'}</div><div class="s">${fm(sc.est_margin)} margin</div></div>
</div>
<h2>Trailing-12-Month Revenue</h2>
<div class="bar">${bars}</div>
<h2>Top Items (last 365d)</h2>
<table><thead><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Revenue</th><th style="text-align:right">Margin %</th></tr></thead><tbody>
${itemRows || '<tr><td colspan="4" style="text-align:center;color:#64748b">No items in window</td></tr>'}
</tbody></table>
<div style="margin-top:24px;font-size:9px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:6px">
  Generated ${new Date().toISOString().slice(0, 10)} · PACER Margin Dashboard · Customer first seen ${escapeHtml(sc.first_invoice_date ?? '-')}
</div>
<script>setTimeout(function(){window.print()}, 350);</script>
</body></html>`);
    w.document.close();
  }

  if (detail === undefined) return <div className="ld">Loading…</div>;
  if (detail === null) {
    return (
      <div className="cd" style={{ padding: 20 }}>
        <div className="pt">Customer not found</div>
        <a href="#customers" style={{ fontSize: 12 }}>← back to Customers</a>
      </div>
    );
  }

  const addr = [detail.bill_addr_line1, detail.bill_addr_city, detail.bill_addr_state, detail.bill_addr_postal]
    .filter(Boolean).join(', ');
  const max = Math.max(...monthVals.map((m) => m.value), 1);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <a href="#customers" style={{ color: 'var(--mt)', textDecoration: 'none', fontSize: 11 }}>← Customers</a>
        <div className="pt" style={{ margin: 0 }}>
          {detail.display_name}
          {detail.is_sub_customer && <span className="bg bg-p" style={{ marginLeft: 6 }}>SUB</span>}
          {!detail.active && <span className="bg bg-p" style={{ marginLeft: 6 }}>INACTIVE</span>}
        </div>
        <button onClick={printScorecard} style={{ ...btnPrimary(), marginLeft: 'auto' }}>
          PRINT SCORECARD
        </button>
      </div>

      <div
        className="cd"
        style={{
          padding: '12px 14px',
          marginBottom: 12,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 14,
        }}
      >
        <div>
          <div style={{ fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Channel · Sales Rep
          </div>
          <div style={{ fontSize: 13, marginTop: 3 }}>
            {(detail.primary_channel ?? '— no channel —') + ' · ' + (detail.primary_sales_rep ?? '— no rep —')}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>Address</div>
          <div style={{ fontSize: 12, marginTop: 3 }}>{addr || '—'}</div>
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

      <div className="gr" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginBottom: 12, gap: 14 }}>
        <KPICard
          title="YTD REVENUE"
          value={fm(detail.current_revenue)}
          sub={`${detail.current_invoice_count} invoices · ${detail.current_line_count} lines`}
        />
        <KPICard
          title="YTD MARGIN"
          value={detail.current_est_margin != null ? fm(detail.current_est_margin) : '—'}
          accent={
            detail.current_margin_pct != null
              ? (Number(detail.current_margin_pct) >= 0.4 ? 'var(--gn)' : 'var(--am)')
              : undefined
          }
          sub={detail.current_margin_pct != null ? fp(detail.current_margin_pct) : '—'}
        />
        <KPICard
          title="LIFETIME REVENUE"
          value={fm(detail.lifetime_revenue)}
          sub={`${detail.lifetime_invoice_count} invoices · last ${detail.last_invoice_date ?? '—'}`}
        />
        <KPICard
          title="AR BALANCE"
          value={fm(detail.ar_balance)}
          accent={Number(detail.ar_overdue) > 0 ? 'var(--am)' : undefined}
          sub={
            Number(detail.ar_overdue) > 0
              ? `${fm(detail.ar_overdue)} overdue (${detail.ar_overdue_count})`
              : 'no overdue'
          }
        />
        <div className="cd">
          <div className="ct">HEALTH (RFM 365D)</div>
          <div style={{ marginTop: 6, marginLeft: 14 }}>
            {health ? (
              <>
                <SegmentChip segment={health.rfm_segment} size="md" />
                <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 4, fontFamily: 'monospace' }}>
                  R{health.r_score} F{health.f_score} M{health.m_score} · {health.recency_days}d ago
                </div>
              </>
            ) : (
              <span style={{ color: 'var(--mt)', fontSize: 10 }}>no signal</span>
            )}
          </div>
          {health && (
            <div className="cs" style={{ marginTop: 4 }}>
              Score {health.rfm_total}/15 · {health.frequency} invoices · {fm(health.monetary)}
            </div>
          )}
        </div>
      </div>

      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 12,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 11,
        }}
      >
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>Period</span>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} style={inp()} />
        <span style={{ color: 'var(--mt)' }}>to</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} style={inp()} />
      </div>

      <div className="gr g2" style={{ marginBottom: 12 }}>
        <div className="cd" style={{ padding: 0 }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
            <div className="ct" style={{ margin: 0 }}>TRAILING-12-MONTH REVENUE</div>
          </div>
          <div style={{ padding: '12px 14px' }}>
            <svg width="100%" height={200} viewBox="0 0 600 200" preserveAspectRatio="none">
              {monthVals.map((m, i) => {
                const x = (i / Math.max(monthVals.length - 1, 1)) * 580 + 10;
                const bw = 580 / monthVals.length - 4;
                const bh = (m.value / max) * 170;
                return (
                  <g key={m.ym}>
                    <rect x={x - bw / 2} y={200 - bh - 16} width={bw} height={Math.max(bh, 1)} fill="var(--ac)" opacity={0.85} />
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
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
            <div className="ct" style={{ margin: 0 }}>
              TOP ITEMS — {items ? items.length : 0}
            </div>
          </div>
          <div style={{ maxHeight: 240, overflow: 'auto' }}>
            {!items ? (
              <div className="ld">Loading…</div>
            ) : items.length === 0 ? (
              <div className="ld">No purchases in this window.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>Revenue</th>
                    <th style={{ textAlign: 'right' }}>Margin %</th>
                  </tr>
                </thead>
                <tbody>
                  {items.slice(0, 100).map((r) => {
                    const mp = r.margin_pct != null ? Number(r.margin_pct) : null;
                    const mpColor =
                      mp == null
                        ? 'var(--mt)'
                        : mp >= 0.4
                          ? 'var(--gn)'
                          : mp >= 0
                            ? 'var(--am)'
                            : 'var(--rd)';
                    return (
                      <tr key={r.dim_label}>
                        <td
                          style={{
                            maxWidth: 240,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: 11,
                          }}
                        >
                          {r.dim_label}
                        </td>
                        <td className="mn" style={{ textAlign: 'right', fontSize: 11 }}>
                          {r.qty != null ? fmtNum(r.qty) : '-'}
                        </td>
                        <td className="mn" style={{ textAlign: 'right', fontWeight: 600, fontSize: 11 }}>
                          {fm(r.revenue)}
                        </td>
                        <td className="mn" style={{ textAlign: 'right', fontSize: 11, color: mpColor }}>
                          {fp(r.margin_pct)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--bd)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div className="ct" style={{ margin: 0 }}>
            RECENT INVOICE LINES — {invoices ? invoices.length : 0}
          </div>
          <button onClick={exportInvoicesCsv} disabled={!invoices?.length} style={btnPrimary()}>
            EXPORT CSV
          </button>
        </div>
        {err && <div className="cd" style={{ padding: 14, color: 'var(--rd)' }}>Error: {err}</div>}
        {!invoices ? (
          <div className="ld">Loading…</div>
        ) : invoices.length === 0 ? (
          <div className="ld">No invoice lines.</div>
        ) : (
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)' }}>
                <tr>
                  <th>Date</th>
                  <th>Doc#</th>
                  <th>Item</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Price</th>
                  <th style={{ textAlign: 'right' }}>Revenue</th>
                  <th style={{ textAlign: 'right' }}>Margin</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((r, i) => (
                  <tr key={`${r.qbo_invoice_id ?? ''}-${i}`}>
                    <td className="mn" style={{ fontSize: 11 }}>{r.txn_date}</td>
                    <td className="mn" style={{ fontSize: 11, color: 'var(--mt)' }}>{r.doc_number ?? '—'}</td>
                    <td
                      style={{
                        maxWidth: 280,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 11,
                      }}
                    >
                      {r.item_name ?? r.description ?? '—'}
                    </td>
                    <td className="mn" style={{ textAlign: 'right', fontSize: 11 }}>
                      {r.quantity != null ? fmtNum(r.quantity) : '-'}
                    </td>
                    <td className="mn" style={{ textAlign: 'right', fontSize: 11 }}>
                      {r.unit_price != null ? fm(r.unit_price) : '-'}
                    </td>
                    <td className="mn" style={{ textAlign: 'right', fontSize: 11, fontWeight: 600 }}>
                      {fm(r.revenue)}
                    </td>
                    <td className="mn" style={{ textAlign: 'right', fontSize: 11 }}>
                      {r.est_margin != null ? fm(r.est_margin) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
