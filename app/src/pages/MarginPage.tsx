import { useEffect, useState } from 'react';
import { sbrpc } from '../lib/rpc';
import { KPICard } from '../components/KPICard';
import { fm, fp, fmtNum } from '../lib/formatters';

interface Totals {
  revenue: number;
  est_margin: number;
  margin_pct: number | null;
  invoice_count: number;
  customer_count: number;
  cost_coverage_pct: number | null;
}

// Phase 1 of the new app ships with a working YTD totals card row so we
// can prove the data path end-to-end (auth → bearer token → ops RPC →
// typed response). Drill-down pivot, filters, and charts come in
// subsequent migration phases.
export function MarginPage() {
  const [totals, setTotals] = useState<Totals | null>(null);
  const [err, setErr] = useState<string>('');

  useEffect(() => {
    const today = new Date();
    const ytdStart = today.getFullYear() + '-01-01';
    const todayStr = today.toISOString().slice(0, 10);

    sbrpc<Totals[]>('fn_sales_totals', { p_start: ytdStart, p_end: todayStr })
      .then((rows) => setTotals(rows?.[0] || null))
      .catch((e) => setErr(e.message));
  }, []);

  return (
    <div>
      <div className="pt">
        Margin <span className="bg bg-l">YTD</span>{' '}
        <span className="bg bg-p">PHASE 1 PORT</span>
      </div>
      {err && (
        <div className="cd" style={{ padding: 14, color: 'var(--rd)' }}>
          Error: {err}
        </div>
      )}
      {!totals && !err ? (
        <div className="ld">Loading…</div>
      ) : totals ? (
        <div className="gr g4" style={{ marginBottom: 14 }}>
          <KPICard title="REVENUE" value={fm(totals.revenue)} sub="YTD" />
          <KPICard
            title="EST MARGIN"
            value={fm(totals.est_margin)}
            sub={fp(totals.margin_pct)}
          />
          <KPICard
            title="INVOICES"
            value={fmtNum(totals.invoice_count)}
            sub={fmtNum(totals.customer_count) + ' customers'}
          />
          <KPICard
            title="COST COVERAGE"
            value={fp(totals.cost_coverage_pct)}
            sub="% of rev with item-cost data"
            accent={
              Number(totals.cost_coverage_pct ?? 0) >= 0.8
                ? 'var(--gn)'
                : 'var(--am)'
            }
          />
        </div>
      ) : null}
      <div className="cd" style={{ padding: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 6 }}>
          Pivot table, multi-select filters, drill-down, and exports are still
          in the legacy app. Continue using <a href="/sales/">/sales/</a> for
          full Margin Minder workflows until the rest of the migration is done.
        </div>
      </div>
    </div>
  );
}
