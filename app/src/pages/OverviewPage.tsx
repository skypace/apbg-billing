import { useEffect, useMemo, useState } from 'react';
import { KPICard } from '../components/KPICard';
import { CustomerLink } from '../components/CustomerLink';
import { AreaChart } from '../components/charts/AreaChart';
import { DonutChart } from '../components/charts/DonutChart';
import { CHART_COLORS } from '../components/charts/util';
import { fm, fp, fmtNum } from '../lib/formatters';
import {
  Dim,
  SalesFilters,
  SalesPivotRow,
  SalesTotals,
  fetchPivot,
  fetchSparkline,
  fetchTotals,
  trailing12MonthKeys,
} from '../lib/sales';
import {
  fetchAnomalies,
  fetchHealthMovers,
  fetchInactiveCustomers,
} from '../lib/reports';
import { fetchInventoryHealth } from '../lib/inventory';

interface MonthRow extends SalesPivotRow { dim_label: string }

export function OverviewPage() {
  const today = new Date();
  const ytdStart = today.getFullYear() + '-01-01';
  const todayStr = today.toISOString().slice(0, 10);
  const priorStart = (today.getFullYear() - 1) + '-01-01';
  const priorEndSameDay = (today.getFullYear() - 1) + todayStr.slice(4);
  const priorYearEnd = (today.getFullYear() - 1) + '-12-31';

  const [totals, setTotals] = useState<SalesTotals | null>(null);
  const [priorTotals, setPriorTotals] = useState<SalesTotals | null>(null);
  const [monthlyCurrent, setMonthlyCurrent] = useState<MonthRow[] | null>(null);
  const [monthlyPrior, setMonthlyPrior] = useState<MonthRow[] | null>(null);
  const [topCategories, setTopCategories] = useState<SalesPivotRow[] | null>(null);
  const [topCustomers, setTopCustomers] = useState<SalesPivotRow[] | null>(null);
  const [customerSparks, setCustomerSparks] = useState<Record<string, number[]>>({});
  const [revenueSpark, setRevenueSpark] = useState<number[] | null>(null);
  const [actions, setActions] = useState<{
    reorderNow: number;
    inactive: number;
    anomalies: number;
    healthMovers: number;
  } | null>(null);

  const filters: SalesFilters = useMemo(
    () => ({ start: ytdStart, end: todayStr, entities: null }),
    [ytdStart, todayStr],
  );
  const priorFilters: SalesFilters = useMemo(
    () => ({ start: priorStart, end: priorEndSameDay, entities: null }),
    [priorStart, priorEndSameDay],
  );

  // KPI totals: current + same-window prior year for delta.
  useEffect(() => {
    Promise.all([fetchTotals(filters), fetchTotals(priorFilters)])
      .then(([cur, prev]) => { setTotals(cur); setPriorTotals(prev); })
      .catch(() => { setTotals(null); setPriorTotals(null); });
  }, [filters, priorFilters]);

  // Monthly trend: current YTD vs prior year (full 12 months).
  useEffect(() => {
    Promise.all([
      fetchPivot('month' as Dim, filters, 24) as Promise<MonthRow[]>,
      fetchPivot('month' as Dim, { ...priorFilters, end: priorYearEnd }, 24) as Promise<MonthRow[]>,
    ]).then(([cur, prev]) => {
      setMonthlyCurrent(cur ?? []);
      setMonthlyPrior(prev ?? []);
    });
  }, [filters, priorFilters, priorYearEnd]);

  // Trailing-12mo revenue sparkline for the headline KPI.
  useEffect(() => {
    fetchSparkline('customer' as Dim, ['__total__'], todayStr, filters)
      .then(() => {/* no-op: sparkline RPC needs labels */})
      .catch(() => {/* ignore */});
    // We use month pivot already loaded for the sparkline microchart instead.
  }, [filters, todayStr]);

  // Top categories (donut).
  useEffect(() => {
    fetchPivot('category' as Dim, filters, 12)
      .then((rs) => setTopCategories((rs ?? []).slice(0, 8)))
      .catch(() => setTopCategories([]));
  }, [filters]);

  // Top customers + their 12-mo sparklines.
  useEffect(() => {
    fetchPivot('customer' as Dim, filters, 10)
      .then(async (rs) => {
        const top = rs ?? [];
        setTopCustomers(top);
        if (top.length === 0) return;
        const labels = top.map((r) => r.dim_label);
        const sparkRows = await fetchSparkline('customer' as Dim, labels, todayStr, filters);
        const keys = trailing12MonthKeys(todayStr);
        const byLabel: Record<string, number[]> = {};
        for (const lb of labels) byLabel[lb] = Array(12).fill(0);
        for (const s of sparkRows) {
          const idx = keys.indexOf(s.ym);
          if (idx >= 0 && byLabel[s.dim_label]) byLabel[s.dim_label][idx] = Number(s.revenue || 0);
        }
        setCustomerSparks(byLabel);
      })
      .catch(() => setTopCustomers([]));
  }, [filters, todayStr]);

  // Action panel counts (parallel; soft-fail individually).
  useEffect(() => {
    Promise.allSettled([
      fetchInventoryHealth({ lookback: 90, managed_only: true }),
      fetchInactiveCustomers({
        current_start: ytdStart,
        current_end: todayStr,
        prior_start: priorStart,
        prior_end: priorYearEnd,
        min_prior_rev: 1000,
        max_current_rev: 0,
        limit: 500,
      }),
      fetchAnomalies({ baseline_months: 6, recent_months: 1, min_baseline: 500, sigma_threshold: 2 }),
      fetchHealthMovers(14),
    ]).then(([inv, inact, anom, hm]) => {
      const reorderNow =
        inv.status === 'fulfilled'
          ? inv.value.filter((r) => r.status === 'reorder_now').length
          : 0;
      const inactive = inact.status === 'fulfilled' ? inact.value.length : 0;
      const anomalies = anom.status === 'fulfilled' ? anom.value.length : 0;
      const healthMovers = hm.status === 'fulfilled' ? hm.value.length : 0;
      setActions({ reorderNow, inactive, anomalies, healthMovers });
    });
  }, [ytdStart, todayStr, priorStart, priorYearEnd]);

  // Build the trailing-12mo sparkline for revenue from the current monthly pivot.
  useEffect(() => {
    if (!monthlyCurrent || !monthlyPrior) return;
    const keys = trailing12MonthKeys(todayStr);
    const byMonth = new Map<string, number>();
    for (const r of monthlyCurrent) byMonth.set(toYm(r.dim_label), Number(r.revenue || 0));
    for (const r of monthlyPrior) {
      const k = toYm(r.dim_label);
      if (!byMonth.has(k)) byMonth.set(k, Number(r.revenue || 0));
    }
    const vals = keys.map((k) => byMonth.get(k) ?? 0);
    setRevenueSpark(vals);
  }, [monthlyCurrent, monthlyPrior, todayStr]);

  const kpiDeltas = useMemo(() => {
    function pct(cur: number | null | undefined, prev: number | null | undefined): number | null {
      if (!cur || !prev || Number(prev) === 0) return null;
      return (Number(cur) - Number(prev)) / Number(prev);
    }
    return {
      revenue: pct(totals?.revenue, priorTotals?.revenue),
      margin: pct(
        totals?.margin_pct != null ? Number(totals.margin_pct) : null,
        priorTotals?.margin_pct != null ? Number(priorTotals.margin_pct) : null,
      ),
      customers: pct(totals?.customer_count, priorTotals?.customer_count),
      aov: pct(
        totals?.invoice_count ? Number(totals.revenue) / Number(totals.invoice_count) : null,
        priorTotals?.invoice_count ? Number(priorTotals.revenue) / Number(priorTotals.invoice_count) : null,
      ),
    };
  }, [totals, priorTotals]);

  const aov = totals && totals.invoice_count > 0 ? Number(totals.revenue) / Number(totals.invoice_count) : 0;

  return (
    <div>
      <div className="pt">
        Overview <span className="bg bg-l">YTD {today.getFullYear()}</span>
      </div>

      {/* KPI row */}
      <div className="gr g4" style={{ marginBottom: 16 }}>
        <KPICard
          title="REVENUE YTD"
          value={totals ? fm(totals.revenue) : '…'}
          deltaPct={kpiDeltas.revenue}
          sparkline={revenueSpark ?? undefined}
          sub={totals ? fmtNum(totals.invoice_count) + ' invoices · vs ' + fm(priorTotals?.revenue ?? 0) + ' prior YTD' : undefined}
        />
        <KPICard
          title="MARGIN %"
          value={totals ? fp(totals.margin_pct) : '…'}
          deltaPct={kpiDeltas.margin}
          sub={totals ? 'on ' + fm(totals.est_margin) + ' margin' : undefined}
        />
        <KPICard
          title="CUSTOMERS"
          value={totals ? fmtNum(totals.customer_count) : '…'}
          deltaPct={kpiDeltas.customers}
          sub={totals ? fmtNum(totals.item_count) + ' items sold' : undefined}
        />
        <KPICard
          title="AVG ORDER VALUE"
          value={totals ? fm(aov) : '…'}
          deltaPct={kpiDeltas.aov}
          sub={totals && totals.cost_coverage_pct != null ? fp(totals.cost_coverage_pct) + ' cost coverage' : undefined}
        />
      </div>

      {/* Action panel */}
      <ActionPanel actions={actions} />

      {/* Trend + Donut */}
      <div className="gr g2" style={{ marginBottom: 16, gap: 14 }}>
        <div className="cd" style={{ padding: 0 }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <div className="ct" style={{ margin: 0 }}>MONTHLY REVENUE</div>
              <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>
                this year vs same months last year
              </div>
            </div>
          </div>
          <div style={{ padding: '14px' }}>
            {monthlyCurrent && monthlyPrior ? (
              <AreaChart
                ariaLabel="Monthly revenue, current vs prior year"
                labels={monthLabels(monthlyCurrent, monthlyPrior)}
                series={[
                  {
                    name: String(today.getFullYear()),
                    color: '#1E40AF',
                    values: alignToMonths(monthlyCurrent, monthlyPrior),
                  },
                  {
                    name: String(today.getFullYear() - 1),
                    color: '#64748B',
                    values: alignToPriorMonths(monthlyCurrent, monthlyPrior),
                  },
                ]}
              />
            ) : (
              <div className="ld">Loading trend…</div>
            )}
          </div>
        </div>

        <div className="cd" style={{ padding: 0 }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <div className="ct" style={{ margin: 0 }}>REVENUE BY CATEGORY</div>
              <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>YTD top 8 categories</div>
            </div>
            <a href="#margin" style={{ fontSize: 10, color: 'var(--mt)' }}>drill →</a>
          </div>
          <div style={{ padding: '14px' }}>
            {topCategories ? (
              <DonutChart
                data={topCategories.map((r, i) => ({
                  label: r.dim_label,
                  value: Number(r.revenue || 0),
                  color: CHART_COLORS[i % CHART_COLORS.length],
                }))}
                centerLabel="Total"
                centerValue={fm(totals?.revenue ?? 0)}
                ariaLabel="Revenue by category"
              />
            ) : (
              <div className="ld">Loading…</div>
            )}
          </div>
        </div>
      </div>

      {/* Top customers */}
      <div className="cd" style={{ padding: 0 }}>
        <div
          style={{
            padding: '12px 14px',
            borderBottom: '1px solid var(--bd)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
          }}
        >
          <div>
            <div className="ct" style={{ margin: 0 }}>TOP CUSTOMERS YTD</div>
            <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>by revenue, with 12-mo trend</div>
          </div>
          <a href="#customers" style={{ fontSize: 10, color: 'var(--mt)' }}>all customers →</a>
        </div>
        {!topCustomers ? (
          <div className="ld">Loading…</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th style={{ textAlign: 'right' }}>Revenue</th>
                <th style={{ textAlign: 'right' }}>Margin %</th>
                <th>Trend (12mo)</th>
              </tr>
            </thead>
            <tbody>
              {topCustomers.map((r) => {
                const mp = r.margin_pct != null ? Number(r.margin_pct) : null;
                const mpColor =
                  mp == null
                    ? 'var(--mt)'
                    : mp >= 0.4
                      ? 'var(--success)'
                      : mp >= 0
                        ? 'var(--warning)'
                        : 'var(--danger)';
                const spark = customerSparks[r.dim_label];
                return (
                  <tr key={r.dim_label}>
                    <td style={{ fontWeight: 600, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.dim_label}>
                      <CustomerLink qboCustomerId={null} name={r.dim_label} />
                    </td>
                    <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fm(r.revenue)}</td>
                    <td className="mn" style={{ textAlign: 'right', color: mpColor }}>{fp(r.margin_pct)}</td>
                    <td style={{ width: 140 }}>{spark && spark.length > 0 ? <RowSpark values={spark} /> : '—'}</td>
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

function ActionPanel({ actions }: { actions: { reorderNow: number; inactive: number; anomalies: number; healthMovers: number } | null }) {
  const items = [
    { id: 'reorder',   label: 'Reorder Now',     count: actions?.reorderNow,   tone: 'var(--danger)',  href: '#inventory' },
    { id: 'inactive',  label: 'Inactive Cust.',  count: actions?.inactive,     tone: 'var(--warning)', href: '#reports' },
    { id: 'anomalies', label: 'Anomalies',       count: actions?.anomalies,    tone: 'var(--info)',    href: '#reports' },
    { id: 'movers',    label: 'Health Movers',   count: actions?.healthMovers, tone: 'var(--ac)',      href: '#reports' },
  ];
  return (
    <div className="gr g4" style={{ marginBottom: 16, gap: 12 }}>
      {items.map((it) => (
        <a
          key={it.id}
          href={it.href}
          style={{
            display: 'block',
            padding: '12px 14px',
            border: '1px solid var(--bd)',
            borderLeft: '3px solid ' + it.tone,
            borderRadius: 'var(--r-md)',
            background: 'var(--sf)',
            textDecoration: 'none',
            color: 'var(--tx)',
            transition: 'background 100ms, border-color 100ms',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--sf2)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--sf)'; }}
        >
          <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: 600 }}>
            {it.label}
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: it.count != null ? it.tone : 'var(--mt)',
              marginTop: 2,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {it.count ?? '…'}
          </div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 2 }}>action needed →</div>
        </a>
      ))}
    </div>
  );
}

function RowSpark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const w = 120;
  const h = 24;
  const stepX = w / Math.max(values.length - 1, 1);
  const points = values
    .map((v, i) => `${i * stepX},${h - (Math.max(0, v) / max) * (h - 2)}`)
    .join(' ');
  const lastIdx = values.length - 1;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline
        points={points}
        fill="none"
        stroke="var(--ac)"
        strokeWidth={1.4}
        opacity={0.85}
      />
      <circle
        cx={lastIdx * stepX}
        cy={h - (Math.max(0, values[lastIdx]) / max) * (h - 2)}
        r={1.8}
        fill="var(--ac)"
      />
    </svg>
  );
}

function toYm(label: string): string {
  // The pivot RPC returns "YYYY-MM-01" for month dim. Trim to YYYY-MM.
  return label.length >= 7 ? label.slice(0, 7) : label;
}

function monthLabels(_cur: MonthRow[], _prev: MonthRow[]): string[] {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
}

function alignToMonths(cur: MonthRow[], _prev: MonthRow[]): number[] {
  const map = new Map<number, number>();
  for (const r of cur) {
    const m = parseInt(toYm(r.dim_label).slice(5, 7), 10);
    if (m >= 1 && m <= 12) map.set(m, Number(r.revenue || 0));
  }
  return Array.from({ length: 12 }, (_, i) => map.get(i + 1) ?? 0);
}

function alignToPriorMonths(_cur: MonthRow[], prev: MonthRow[]): number[] {
  const map = new Map<number, number>();
  for (const r of prev) {
    const m = parseInt(toYm(r.dim_label).slice(5, 7), 10);
    if (m >= 1 && m <= 12) map.set(m, Number(r.revenue || 0));
  }
  return Array.from({ length: 12 }, (_, i) => map.get(i + 1) ?? 0);
}
