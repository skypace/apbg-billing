import { useMemo } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { AlertTriangle, CircleDollarSign, Info } from 'lucide-react';
import type { ComparisonRow, Dim, SalesPivotRow } from '../lib/sales';
import type { MarginColumnDef } from '../lib/marginColumns';
import { fm, fp, fmtNum } from '../lib/formatters';
import { Sparkline } from './Sparkline';
import { GRID_SX, GRID_DEFAULTS } from '../lib/gridStyles';

const DIM_HEADER: Record<Dim, string> = {
  category: 'Category', item: 'Item', customer: 'Customer', month: 'Month',
  entity: 'Entity', account: 'Account', segment: 'Segment', channel: 'Channel',
  product_family: 'Family', product_type: 'Type',
};

interface Props {
  dim: Dim;
  rows: SalesPivotRow[] | ComparisonRow[];
  showCompare?: boolean;
  sparklines?: Record<string, number[]>;
  onRowClick?: (row: SalesPivotRow) => void;
  onDetailClick?: (row: SalesPivotRow & Record<string, unknown>) => void;
  extraColumns?: MarginColumnDef[];
}

function isComparison(r: SalesPivotRow | ComparisonRow): r is ComparisonRow {
  return 'prior_revenue' in r;
}
function deltaColor(v: number | null | undefined) {
  if (v == null || v === 0) return 'var(--mt)';
  return v > 0 ? 'var(--gn)' : 'var(--rd)';
}
function marginColor(mp: number | null | undefined) {
  if (mp == null) return 'var(--mt)';
  if (mp >= 0.4) return 'var(--gn)';
  if (mp >= 0)   return 'var(--am)';
  return 'var(--rd)';
}
function coverageColor(v: number | null | undefined) {
  if (v == null) return 'var(--mt)';
  if (v >= 0.8) return 'var(--gn)';
  if (v >= 0.5) return 'var(--am)';
  return 'var(--rd)';
}
function confidenceColor(tone: 'good' | 'warn' | 'bad' | 'muted') {
  if (tone === 'good') return 'var(--gn)';
  if (tone === 'warn') return 'var(--am)';
  if (tone === 'bad') return 'var(--rd)';
  return 'var(--mt)';
}
function evaluateMarginConfidence(row: SalesPivotRow | ComparisonRow): { label: string; tone: 'good' | 'warn' | 'bad' | 'muted'; tip: string } {
  const label = String(row.dim_label ?? '').trim().toLowerCase();
  const revenue = Number(row.revenue ?? 0);
  const coverageRaw = row.cost_coverage_pct != null ? Number(row.cost_coverage_pct) : null;
  const coverage = coverageRaw != null && Number.isFinite(coverageRaw) ? coverageRaw : null;
  const marginPct = row.margin_pct != null ? Number(row.margin_pct) : null;
  const estCost = row.est_cost != null ? Number(row.est_cost) : null;
  const estMargin = row.est_margin != null ? Number(row.est_margin) : null;
  const hasCostedMargin =
    estCost != null && Number.isFinite(estCost) &&
    estMargin != null && Number.isFinite(estMargin);

  if (label === '(unspecified)' || label === 'unspecified' || label === '') {
    return { label: 'Unmapped', tone: 'bad', tip: 'This row is grouped as unspecified because a source dimension is missing.' };
  }
  if (Math.abs(revenue) === 0) {
    return { label: 'No revenue', tone: 'muted', tip: 'No revenue in the selected window.' };
  }
  if (coverage != null && coverage < 0.5) {
    return { label: 'Missing cost', tone: 'bad', tip: 'Less than half of this row has item-cost coverage.' };
  }
  if (coverage != null && coverage < 0.8) {
    return { label: 'Cost gap', tone: 'warn', tip: 'Some revenue in this row is missing usable item cost.' };
  }
  if (!hasCostedMargin) {
    return { label: 'Missing cost', tone: 'bad', tip: 'This row has revenue but no usable cost or margin result.' };
  }
  if (revenue > 0 && marginPct != null && marginPct < 0) {
    return { label: 'Loss', tone: 'warn', tip: 'Positive revenue is showing negative estimated margin.' };
  }
  return { label: 'Good', tone: 'good', tip: 'Cost coverage and mapping look usable for this row.' };
}

function evaluateAtRisk(row: Record<string, unknown>): { sev: 'severe' | 'warn'; tip: string } | null {
  const priorRev = row.prior_revenue != null ? Number(row.prior_revenue) : null;
  if (priorRev == null || priorRev < 250) return null;
  const revDeltaPct = row.delta_pct != null ? Number(row.delta_pct) : null;
  const curMargin = row.est_margin != null ? Number(row.est_margin) : null;
  const priMargin = row.prior_margin != null ? Number(row.prior_margin) : null;
  const curRev = Number(row.revenue ?? 0);
  let marginPpDrop: number | null = null;
  if (curMargin != null && priMargin != null && curRev > 0 && priorRev > 0) {
    marginPpDrop = priMargin / priorRev - curMargin / curRev;
  }
  const reasons: string[] = [];
  let sev: 'severe' | 'warn' = 'warn';
  if (revDeltaPct != null && revDeltaPct <= -0.5) { reasons.push(`Revenue down ${(revDeltaPct * -100).toFixed(0)}% vs prior`); sev = 'severe'; }
  else if (revDeltaPct != null && revDeltaPct <= -0.2) { reasons.push(`Revenue down ${(revDeltaPct * -100).toFixed(0)}% vs prior`); }
  if (marginPpDrop != null && marginPpDrop >= 0.10) { reasons.push(`Margin down ${(marginPpDrop * 100).toFixed(1)} pts vs prior`); sev = 'severe'; }
  else if (marginPpDrop != null && marginPpDrop >= 0.05) { reasons.push(`Margin down ${(marginPpDrop * 100).toFixed(1)} pts vs prior`); }
  return reasons.length ? { sev, tip: reasons.join(' · ') } : null;
}

function evaluateArRisk(row: Record<string, unknown>): { sev: 'severe' | 'warn'; tip: string } | null {
  const ar90 = row.ar_90_plus != null ? Number(row.ar_90_plus) : 0;
  const arTotal = row.ar_total != null ? Number(row.ar_total) : 0;
  const oldest = row.days_oldest_overdue != null ? Number(row.days_oldest_overdue) : 0;
  if (ar90 > 0) return { sev: 'severe', tip: `${fm(ar90)} aged 90+ days · ${oldest}d oldest` };
  if (oldest >= 60 && arTotal > 0) return { sev: 'warn', tip: `${oldest}d oldest overdue · ${fm(arTotal)} open AR` };
  return null;
}

export function MarginGrid({
  dim, rows, showCompare, sparklines, onRowClick, onDetailClick, extraColumns,
}: Props) {
  const totalsRow = useMemo(() => {
    let lineCount = 0, qty = 0, qtyHas = false, revenue = 0, estCost = 0, estCostHas = false;
    let estMargin = 0, estMarginHas = false, priorRevenue = 0, priorHas = false;
    let costedRevenue = 0, costedRevenueHas = false, absRevenue = 0, coveredAbsRevenue = 0, coverageHas = false;
    for (const r of rows) {
      lineCount += Number(r.line_count || 0);
      if (r.qty != null) { qty += Number(r.qty); qtyHas = true; }
      const rowRevenue = Number(r.revenue || 0);
      revenue += rowRevenue;
      absRevenue += Math.abs(rowRevenue);
      if (r.est_cost != null) { estCost += Number(r.est_cost); estCostHas = true; }
      if (r.est_margin != null) { estMargin += Number(r.est_margin); estMarginHas = true; }
      if (r.est_cost != null && r.est_margin != null) {
        costedRevenue += Number(r.est_cost) + Number(r.est_margin);
        costedRevenueHas = true;
      }
      if (r.cost_coverage_pct != null && Number.isFinite(Number(r.cost_coverage_pct))) {
        coveredAbsRevenue += Math.abs(rowRevenue) * Number(r.cost_coverage_pct);
        coverageHas = true;
      }
      if (isComparison(r) && r.prior_revenue != null) { priorRevenue += Number(r.prior_revenue); priorHas = true; }
    }
    const marginPct = estMarginHas && costedRevenueHas && costedRevenue !== 0 ? estMargin / costedRevenue : null;
    const costCoveragePct = coverageHas && absRevenue > 0 ? coveredAbsRevenue / absRevenue : null;
    const deltaRev  = priorHas ? revenue - priorRevenue : null;
    const deltaPct  = priorHas && priorRevenue > 0 ? (revenue - priorRevenue) / priorRevenue : null;
    return {
      id: '__total__', __isTotal: true, dim_label: `TOTAL (${rows.length})`,
      line_count: lineCount, qty: qtyHas ? qty : null, revenue,
      est_cost: estCostHas ? estCost : null, est_margin: estMarginHas ? estMargin : null,
      margin_pct: marginPct, cost_coverage_pct: costCoveragePct, prior_revenue: priorHas ? priorRevenue : null,
      delta_revenue: deltaRev, delta_pct: deltaPct,
    };
  }, [rows]);

  const dataRows = useMemo(
    () => rows.map((r, i) => ({ id: r.dim_label + '___' + i, ...r })),
    [rows],
  );

  const columns: GridColDef[] = useMemo(() => {
    const cols: GridColDef[] = [
      {
        field: 'dim_label', headerName: DIM_HEADER[dim], flex: 2, minWidth: 200,
        renderCell: (p) => {
          if (p.row.__isTotal) {
            return <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.value as string}</span>;
          }
          const risk = showCompare ? evaluateAtRisk(p.row as Record<string, unknown>) : null;
          const arRisk = dim === 'customer' ? evaluateArRisk(p.row as Record<string, unknown>) : null;
          const riskColor = risk ? (risk.sev === 'severe' ? 'var(--rd)' : 'var(--am)') : null;
          const arColor = arRisk ? (arRisk.sev === 'severe' ? 'var(--rd)' : 'var(--am)') : null;
          const fullTip = [risk ? `RISK: ${risk.tip}` : '', arRisk ? `AR: ${arRisk.tip}` : ''].filter(Boolean).join(' · ');

          return (
            <span style={{
              fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%',
            }} title={fullTip || (p.value as string)}>
              {riskColor && <AlertTriangle size={12} strokeWidth={2.4} color={riskColor} aria-label={risk?.tip} style={{ flexShrink: 0 }} />}
              {arColor && <CircleDollarSign size={12} strokeWidth={2.4} color={arColor} aria-label={arRisk?.tip} style={{ flexShrink: 0 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{p.value as string}</span>
              {onDetailClick && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDetailClick(p.row as SalesPivotRow & Record<string, unknown>);
                  }}
                  title="Row detail: Waterfall · Price Ladder · What-if"
                  style={{
                    flexShrink: 0, background: 'transparent', border: 'none', cursor: 'pointer',
                    padding: 2, display: 'inline-flex', alignItems: 'center',
                  }}
                  aria-label="Open row detail"
                >
                  <Info size={12} strokeWidth={2.4} color="var(--mt)" />
                </button>
              )}
            </span>
          );
        },
      },
    ];

    if (sparklines) {
      cols.push({
        field: 'spark', headerName: 'Trend (12mo)', width: 110, sortable: false, filterable: false,
        valueGetter: () => null,
        renderCell: (p) => p.row.__isTotal ? null : <Sparkline values={sparklines[p.row.dim_label] ?? Array(12).fill(0)} />,
      });
    }

    cols.push(
      {
        field: 'confidence', headerName: 'Health', width: 116, sortable: false, filterable: false,
        renderCell: (p) => {
          if (p.row.__isTotal) return null;
          const conf = evaluateMarginConfidence(p.row as SalesPivotRow | ComparisonRow);
          const color = confidenceColor(conf.tone);
          return (
            <span
              title={conf.tip}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minWidth: 76, padding: '2px 7px', borderRadius: 4,
                border: '1px solid ' + color, color, fontSize: 10, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: 0,
              }}
            >
              {conf.label}
            </span>
          );
        },
      },
      { field: 'line_count', headerName: 'Lines', type: 'number', width: 88, cellClassName: 'mn',
        valueFormatter: (v) => (v != null ? fmtNum(Number(v)) : '—') },
      { field: 'qty', headerName: 'Qty', type: 'number', width: 96, cellClassName: 'mn',
        valueFormatter: (v) => (v != null ? fmtNum(Number(v)) : '—') },
      { field: 'revenue', headerName: 'Revenue', type: 'number', width: 130, cellClassName: 'mn',
        renderCell: (p) => <span style={{ fontWeight: p.row.__isTotal ? 700 : 600 }}>{fm(p.value)}</span> },
    );

    if (showCompare) {
      cols.push(
        { field: 'prior_revenue', headerName: 'Prior Rev', type: 'number', width: 120, cellClassName: 'mn',
          renderCell: (p) => <span style={{ color: 'var(--mt)' }}>{p.value != null ? fm(p.value) : '—'}</span> },
        { field: 'delta_revenue', headerName: 'Δ $', type: 'number', width: 110, cellClassName: 'mn',
          renderCell: (p) => {
            if (p.value == null) return <span style={{ color: 'var(--mt)' }}>—</span>;
            const v = Number(p.value);
            return <span style={{ color: deltaColor(v), fontWeight: 600 }}>{(v >= 0 ? '+' : '') + fm(v)}</span>;
          } },
        { field: 'delta_pct', headerName: 'Δ %', type: 'number', width: 100, cellClassName: 'mn',
          renderCell: (p) => {
            if (p.value == null) return <span style={{ color: 'var(--mt)' }}>—</span>;
            const v = Number(p.value);
            return <span style={{ color: deltaColor(v), fontWeight: 600 }}>{(v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'}</span>;
          } },
      );
    }

    cols.push(
      { field: 'est_cost', headerName: 'Est Cost', type: 'number', width: 116, cellClassName: 'mn',
        valueFormatter: (v) => (v != null ? fm(v) : '—') },
      { field: 'est_margin', headerName: 'Est Margin', type: 'number', width: 116, cellClassName: 'mn',
        valueFormatter: (v) => (v != null ? fm(v) : '—') },
      { field: 'margin_pct', headerName: 'Margin %', type: 'number', width: 104, cellClassName: 'mn',
        renderCell: (p) => <span style={{ color: marginColor(p.value), fontWeight: 600 }}>{fp(p.value)}</span> },
      { field: 'cost_coverage_pct', headerName: 'Cost Cov', type: 'number', width: 104, cellClassName: 'mn',
        renderCell: (p) => <span style={{ color: coverageColor(p.value), fontWeight: 600 }}>{fp(p.value)}</span> },
    );

    for (const xc of extraColumns ?? []) {
      cols.push({
        field: 'xc_' + xc.id, headerName: xc.label, type: 'number',
        width: xc.width, cellClassName: 'mn', sortable: true,
        valueGetter: xc.compute
          ? (_v, row) => xc.compute!(row as SalesPivotRow & Record<string, unknown>) as number | string | null
          : (_v, row) => (xc.enrichmentKey ? (row as Record<string, unknown>)[xc.enrichmentKey] ?? null : null),
        valueFormatter: (v) => (xc.format ? xc.format(v) : v == null ? '—' : String(v)),
      });
    }

    return cols;
  }, [dim, showCompare, sparklines, extraColumns, onDetailClick]);

  return (
    <DataGridPro
      rows={dataRows}
      pinnedRows={{ bottom: [totalsRow] }}
      columns={columns}
      density="compact"
      disableRowSelectionOnClick
      pagination
      {...GRID_DEFAULTS}
      pageSizeOptions={[10, 20, 40, 60, 100, { value: -1, label: 'All' }]}
      onRowClick={onRowClick ? (params) => { if (!params.row.__isTotal) onRowClick(params.row); } : undefined}
      initialState={{
        pagination: { paginationModel: { pageSize: 20, page: 0 } },
        pinnedColumns: { left: ['dim_label'] },
        sorting: { sortModel: [{ field: 'revenue', sort: 'desc' }] },
      }}
      sx={{
        ...GRID_SX,
        height: '62vh',
        // Bottom totals row — bold, divided from the body.
        '& .MuiDataGrid-row.MuiDataGrid-row--pinned, & .MuiDataGrid-pinnedRows': { background: 'var(--sf)', fontWeight: 700, borderTop: '2px solid var(--bd)' },
        '& .MuiDataGrid-footerContainer': { borderTop: '1px solid var(--bd)', background: 'var(--sf)', minHeight: 44 },
      }}
    />
  );
}
