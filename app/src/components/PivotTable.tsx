import { useMemo, useState } from 'react';
import type { ComparisonRow, Dim, SalesPivotRow } from '../lib/sales';
import { fm, fp, fmtNum } from '../lib/formatters';
import { Sparkline } from './Sparkline';

type SortKey =
  | 'dim_label'
  | 'line_count'
  | 'qty'
  | 'revenue'
  | 'est_cost'
  | 'est_margin'
  | 'margin_pct'
  | 'prior_revenue'
  | 'delta_revenue'
  | 'delta_pct';

interface Props {
  dim: Dim;
  rows: SalesPivotRow[] | ComparisonRow[];
  showCompare?: boolean;
  sparklines?: Record<string, number[]>;
  onRowClick?: (row: SalesPivotRow) => void;
}

const DIM_HEADER: Record<Dim, string> = {
  category: 'Category',
  item: 'Item',
  customer: 'Customer',
  month: 'Month',
  entity: 'Entity',
  account: 'Account',
  segment: 'Segment',
  channel: 'Channel',
};

function isComparison(r: SalesPivotRow | ComparisonRow): r is ComparisonRow {
  return 'prior_revenue' in r;
}

export function PivotTable({ dim, rows, showCompare, sparklines, onRowClick }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'revenue',
    dir: 'desc',
  });

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sort.key];
      const bv = (b as unknown as Record<string, unknown>)[sort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string' && typeof bv === 'string') {
        return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const an = Number(av), bn = Number(bv);
      return sort.dir === 'asc' ? an - bn : bn - an;
    });
    return out;
  }, [rows, sort]);

  // Grand total across the visible rows. Margin % is recomputed from the
  // summed revenue/cost so it isn't a misleading mean of per-row percentages.
  const totals = useMemo(() => {
    let lineCount = 0;
    let qty = 0;
    let qtyHas = false;
    let revenue = 0;
    let estCost = 0;
    let estCostHas = false;
    let estMargin = 0;
    let estMarginHas = false;
    let priorRevenue = 0;
    let priorHas = false;
    for (const r of rows) {
      lineCount += Number(r.line_count || 0);
      if (r.qty != null) { qty += Number(r.qty); qtyHas = true; }
      revenue += Number(r.revenue || 0);
      if (r.est_cost != null) { estCost += Number(r.est_cost); estCostHas = true; }
      if (r.est_margin != null) { estMargin += Number(r.est_margin); estMarginHas = true; }
      if (isComparison(r) && r.prior_revenue != null) {
        priorRevenue += Number(r.prior_revenue);
        priorHas = true;
      }
    }
    const marginPct = estCostHas && revenue > 0 ? (revenue - estCost) / revenue : null;
    const deltaRev = priorHas ? revenue - priorRevenue : null;
    const deltaPct = priorHas && priorRevenue > 0 ? (revenue - priorRevenue) / priorRevenue : null;
    return {
      lineCount,
      qty: qtyHas ? qty : null,
      revenue,
      estCost: estCostHas ? estCost : null,
      estMargin: estMarginHas ? estMargin : null,
      marginPct,
      priorRevenue: priorHas ? priorRevenue : null,
      deltaRev,
      deltaPct,
    };
  }, [rows]);

  function header(key: SortKey, label: string, align: 'left' | 'right' = 'left') {
    const on = sort.key === key;
    const arrow = on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return (
      <th
        onClick={() =>
          setSort((s) =>
            s.key === key
              ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
              : { key, dir: 'desc' },
          )
        }
        style={{
          textAlign: align,
          cursor: 'pointer',
          userSelect: 'none',
          color: on ? 'var(--ac)' : undefined,
        }}
      >
        {label}
        {arrow}
      </th>
    );
  }

  if (rows.length === 0) {
    return <div className="ld">No matching rows.</div>;
  }

  return (
    <div style={{ maxHeight: '62vh', overflow: 'auto' }}>
      <table>
        <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
          <tr>
            {header('dim_label', DIM_HEADER[dim])}
            {sparklines && <th style={{ width: 90 }}>Trend (12mo)</th>}
            {header('line_count', 'Lines', 'right')}
            {header('qty', 'Qty', 'right')}
            {header('revenue', 'Revenue', 'right')}
            {showCompare && header('prior_revenue', 'Prior Rev', 'right')}
            {showCompare && header('delta_revenue', 'Δ $', 'right')}
            {showCompare && header('delta_pct', 'Δ %', 'right')}
            {header('est_cost', 'Est Cost', 'right')}
            {header('est_margin', 'Est Margin', 'right')}
            {header('margin_pct', 'Margin %', 'right')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const mp = r.margin_pct != null ? Number(r.margin_pct) : null;
            const mpColor =
              mp == null
                ? 'var(--mt)'
                : mp >= 0.4
                  ? 'var(--gn)'
                  : mp >= 0
                    ? 'var(--am)'
                    : 'var(--rd)';
            const cmp = isComparison(r) ? r : null;
            const dPct = cmp?.delta_pct;
            const dRev = cmp?.delta_revenue;
            const deltaColor =
              dRev == null
                ? 'var(--mt)'
                : Number(dRev) > 0
                  ? 'var(--gn)'
                  : Number(dRev) < 0
                    ? 'var(--rd)'
                    : 'var(--mt)';
            return (
              <tr
                key={r.dim_label}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                style={onRowClick ? { cursor: 'pointer' } : undefined}
              >
                <td
                  style={{
                    fontWeight: 600,
                    maxWidth: 320,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={r.dim_label}
                >
                  {r.dim_label}
                </td>
                {sparklines && (
                  <td>
                    <Sparkline values={sparklines[r.dim_label] ?? Array(12).fill(0)} />
                  </td>
                )}
                <td className="mn" style={{ textAlign: 'right' }}>
                  {fmtNum(r.line_count)}
                </td>
                <td className="mn" style={{ textAlign: 'right' }}>
                  {r.qty != null ? fmtNum(r.qty) : '—'}
                </td>
                <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>
                  {fm(r.revenue)}
                </td>
                {showCompare && (
                  <td className="mn" style={{ textAlign: 'right', color: 'var(--mt)' }}>
                    {cmp?.prior_revenue != null ? fm(cmp.prior_revenue) : '—'}
                  </td>
                )}
                {showCompare && (
                  <td className="mn" style={{ textAlign: 'right', color: deltaColor, fontWeight: 600 }}>
                    {dRev == null ? '—' : (Number(dRev) >= 0 ? '+' : '') + fm(dRev)}
                  </td>
                )}
                {showCompare && (
                  <td className="mn" style={{ textAlign: 'right', color: deltaColor, fontWeight: 600 }}>
                    {dPct == null ? '—' : (Number(dPct) >= 0 ? '+' : '') + (Number(dPct) * 100).toFixed(1) + '%'}
                  </td>
                )}
                <td
                  className="mn"
                  style={{ textAlign: 'right', borderLeft: '1px solid var(--bd)' }}
                >
                  {r.est_cost != null ? fm(r.est_cost) : '—'}
                </td>
                <td className="mn" style={{ textAlign: 'right' }}>
                  {r.est_margin != null ? fm(r.est_margin) : '—'}
                </td>
                <td
                  className="mn"
                  style={{ textAlign: 'right', color: mpColor, fontWeight: 600 }}
                >
                  {fp(r.margin_pct)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot
          style={{
            position: 'sticky',
            bottom: 0,
            background: 'var(--sf)',
            borderTop: '2px solid var(--bd)',
            fontWeight: 700,
          }}
        >
          <tr>
            <td>TOTAL ({rows.length})</td>
            {sparklines && <td />}
            <td className="mn" style={{ textAlign: 'right' }}>{fmtNum(totals.lineCount)}</td>
            <td className="mn" style={{ textAlign: 'right' }}>
              {totals.qty != null ? fmtNum(totals.qty) : '—'}
            </td>
            <td className="mn" style={{ textAlign: 'right' }}>{fm(totals.revenue)}</td>
            {showCompare && (
              <td className="mn" style={{ textAlign: 'right', color: 'var(--mt)' }}>
                {totals.priorRevenue != null ? fm(totals.priorRevenue) : '—'}
              </td>
            )}
            {showCompare && (
              <td
                className="mn"
                style={{
                  textAlign: 'right',
                  color: totals.deltaRev == null
                    ? 'var(--mt)'
                    : totals.deltaRev >= 0
                      ? 'var(--gn)'
                      : 'var(--rd)',
                }}
              >
                {totals.deltaRev == null
                  ? '—'
                  : (totals.deltaRev >= 0 ? '+' : '') + fm(totals.deltaRev)}
              </td>
            )}
            {showCompare && (
              <td
                className="mn"
                style={{
                  textAlign: 'right',
                  color: totals.deltaPct == null
                    ? 'var(--mt)'
                    : totals.deltaPct >= 0
                      ? 'var(--gn)'
                      : 'var(--rd)',
                }}
              >
                {totals.deltaPct == null
                  ? '—'
                  : (totals.deltaPct >= 0 ? '+' : '') + (totals.deltaPct * 100).toFixed(1) + '%'}
              </td>
            )}
            <td
              className="mn"
              style={{ textAlign: 'right', borderLeft: '1px solid var(--bd)' }}
            >
              {totals.estCost != null ? fm(totals.estCost) : '—'}
            </td>
            <td className="mn" style={{ textAlign: 'right' }}>
              {totals.estMargin != null ? fm(totals.estMargin) : '—'}
            </td>
            <td
              className="mn"
              style={{
                textAlign: 'right',
                color: totals.marginPct == null
                  ? 'var(--mt)'
                  : totals.marginPct >= 0.4
                    ? 'var(--gn)'
                    : totals.marginPct >= 0
                      ? 'var(--am)'
                      : 'var(--rd)',
              }}
            >
              {fp(totals.marginPct)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
