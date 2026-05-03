import { useMemo, useState } from 'react';
import type { ComparisonRow, Dim, SalesPivotRow } from '../lib/sales';
import { fm, fp, fmtNum } from '../lib/formatters';
import { Sparkline } from './Sparkline';

type SortKey =
  | 'dim_label'
  | 'line_count'
  | 'qty'
  | 'revenue'
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
  rep: 'Sales Rep',
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
      </table>
    </div>
  );
}
