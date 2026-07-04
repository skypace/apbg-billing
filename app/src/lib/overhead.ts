// Overhead allocation — fetches active pools for a date window and
// computes per-row overhead $ using each pool's allocation basis.
//
// The math: each pool has a basis (revenue / unit_volume / sku_equal_share /
// margin_contribution). We allocate the pool's prorated total across the rows
// in the current view by that basis. Per-row overhead = sum across all pools.
//
// Blended overhead per unit = row_overhead / row_qty. This is the dynamic the
// CEO asked for — sell more units in the period and the per-unit overhead drops
// because the same pool total spreads further.

import { sbrpc } from './rpc';
import type { SalesPivotRow, SalesTotals } from './sales';

export type OverheadBasis =
  | 'revenue'
  | 'unit_volume'
  | 'sku_equal_share'
  | 'margin_contribution';

export interface OverheadPoolTotal {
  pool_id: number;
  pool_name: string;
  basis: OverheadBasis;
  entity: string | null;
  monthly_amount: number;
  pool_total: number;   // prorated for the window
  months: number;       // decimal months in window
}

export interface OverheadBasisTotals {
  revenue: number;
  unit_volume: number;
  margin_contribution: number;
}

/** Call fn_overhead_total(start, end, entity?) on Supabase. */
export function fetchOverheadPools(
  start: string,
  end: string,
  entity?: string | null,
): Promise<OverheadPoolTotal[]> {
  return sbrpc<OverheadPoolTotal[]>('fn_overhead_total', {
    p_start: start,
    p_end: end,
    p_entity: entity ?? null,
  });
}

/** Sum of prorated pool totals — the company-wide overhead dollars for the window. */
export function totalPoolAmount(pools: OverheadPoolTotal[]): number {
  return pools.reduce((s, p) => s + Number(p.pool_total ?? 0), 0);
}

function positiveFinite(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Denominators based on rows currently visible in Margin. Credits/refunds do
 * not get negative overhead shares or make positive rows over-allocate. */
export function buildOverheadBasisTotals(rows: SalesPivotRow[]): OverheadBasisTotals {
  return rows.reduce<OverheadBasisTotals>((acc, row) => {
    acc.revenue += positiveFinite(row.revenue);
    acc.unit_volume += positiveFinite(row.qty);
    acc.margin_contribution += positiveFinite(row.est_margin);
    return acc;
  }, { revenue: 0, unit_volume: 0, margin_contribution: 0 });
}

/** Per-row overhead allocation. Iterates pools; each pool uses its own basis. */
export function allocateRowOverhead(
  row: SalesPivotRow,
  totals: SalesTotals | null,
  rowCount: number,
  pools: OverheadPoolTotal[],
  basisTotals?: OverheadBasisTotals | null,
): number {
  if (!pools.length || !totals) return 0;
  let total = 0;
  for (const pool of pools) {
    const poolTotal = Number(pool.pool_total ?? 0);
    if (poolTotal === 0) continue;
    let share = 0;
    switch (pool.basis) {
      case 'revenue': {
        const denom = basisTotals?.revenue ?? positiveFinite(totals.revenue);
        share = denom > 0 ? positiveFinite(row.revenue) / denom : 0;
        break;
      }
      case 'unit_volume': {
        const denom = basisTotals?.unit_volume ?? positiveFinite(totals.qty);
        const rowQty = positiveFinite(row.qty);
        share = denom > 0 ? rowQty / denom : 0;
        break;
      }
      case 'sku_equal_share': {
        share = rowCount > 0 ? 1 / rowCount : 0;
        break;
      }
      case 'margin_contribution': {
        const denom = basisTotals?.margin_contribution ?? positiveFinite(totals.est_margin);
        const rowMargin = positiveFinite(row.est_margin);
        share = denom > 0 ? rowMargin / denom : 0;
        break;
      }
    }
    total += poolTotal * share;
  }
  return total;
}

/** Computed fields we attach to each row when overhead pools are active. */
export interface OverheadRowFields {
  _overhead: number;
  _overhead_per_unit: number | null;
  _net_margin: number;
  _net_margin_pct: number | null;
  _unit_net: number | null;
}

/** Build the overhead field set for a single row. */
export function computeOverheadFields(
  row: SalesPivotRow,
  totals: SalesTotals | null,
  rowCount: number,
  pools: OverheadPoolTotal[],
  basisTotals?: OverheadBasisTotals | null,
): OverheadRowFields {
  const overhead = allocateRowOverhead(row, totals, rowCount, pools, basisTotals);
  const qty = row.qty != null ? Number(row.qty) : 0;
  const margin = row.est_margin != null ? Number(row.est_margin) : 0;
  const revenue = Number(row.revenue ?? 0);
  const netMargin = margin - overhead;
  return {
    _overhead: overhead,
    _overhead_per_unit: qty > 0 ? overhead / qty : null,
    _net_margin: netMargin,
    _net_margin_pct: revenue > 0 ? netMargin / revenue : null,
    _unit_net: qty > 0 ? netMargin / qty : null,
  };
}
