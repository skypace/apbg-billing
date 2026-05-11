import { useMemo } from 'react';
import { DataGridPro, type GridColDef } from '@mui/x-data-grid-pro';
import { AlertTriangle } from 'lucide-react';
import type { ComparisonRow, Dim, SalesPivotRow } from '../lib/sales';
import type { MarginColumnDef } from '../lib/marginColumns';
import { fm, fp, fmtNum } from '../lib/formatters';
import { Sparkline } from './Sparkline';

const DIM_HEADER: Record<Dim, string> = {
  category: 'Category',
  item:     'Item',
  customer: 'Customer',
  month:    'Month',
  entity:   'Entity',
  account:  'Account',
  segment:  'Segment',
  channel:  'Channel',
};

interface Props {
  dim: Dim;
  rows: SalesPivotRow[] | ComparisonRow[];
  showCompare?: boolean;
  sparklines?: Record<string, number[]>;
  onRowClick?: (row: SalesPivotRow) => void;
  /** Optional extra columns from the registry — Smart Columns picker output. */
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

// At-risk thresholds — applied to row.delta_pct vs prior period.
// Severe drop: red flag; meaningful drop: amber flag.
function atRiskLevel(deltaPct: number | null | undefined, priorRevenue: number | null | undefined): 'severe' | 'warn' | null {
  if (deltaPct == null || priorRevenue == null) return null;
  // Only flag when prior revenue was material — avoid noise from tiny accounts.
  if (Number(priorRevenue) < 250) return null;
  const d = Number(deltaPct);
  if (d <= -0.5) return 'severe';
  if (d <= -0.2) return 'warn';
  return null;
}

export function MarginGrid({ dim, rows, showCompare, sparklines, onRowClick, extraColumns }: Props) {
  const totalsRow = useMemo(() => {
    let lineCount = 0;
    let qty = 0, qtyHas = false;
    let revenue = 0;
    let estCost = 0, estCostHas = false;
    let estMargin = 0, estMarginHas = false;
    let priorRevenue = 0, priorHas = false;
    for (const r of rows) {
      lineCount += Number(r.line_count || 0);
      if (r.qty != null)        { qty       += Number(r.qty);        qtyHas       = true; }
      revenue   += Number(r.revenue || 0);
      if (r.est_cost   != null) { estCost   += Number(r.est_cost);   estCostHas   = true; }
      if (r.est_margin != null) { estMargin += Number(r.est_margin); estMarginHas = true; }
      if (isComparison(r) && r.prior_revenue != null) {
        priorRevenue += Number(r.prior_revenue);
        priorHas = true;
      }
    }
    const marginPct = estCostHas && revenue > 0 ? (revenue - estCost) / revenue : null;
    const deltaRev  = priorHas ? revenue - priorRevenue : null;
    const deltaPct  = priorHas && priorRevenue > 0 ? (revenue - priorRevenue) / priorRevenue : null;
    return {
      id: '__total__',
      __isTotal: true,
      dim_label: `TOTAL (${rows.length})`,
      line_count:   lineCount,
      qty:          qtyHas        ? qty       : null,
      revenue,
      est_cost:     estCostHas    ? estCost   : null,
      est_margin:   estMarginHas  ? estMargin : null,
      margin_pct:   marginPct,
      prior_revenue: priorHas ? priorRevenue : null,
      delta_revenue: deltaRev,
      delta_pct:     deltaPct,
    };
  }, [rows]);

  const dataRows = useMemo(
    () => rows.map((r, i) => ({ id: r.dim_label + '___' + i, ...r })),
    [rows],
  );

  const columns: GridColDef[] = useMemo(() => {
    const cols: GridColDef[] = [
      {
        field: 'dim_label',
        headerName: DIM_HEADER[dim],
        flex: 2,
        minWidth: 200,
        renderCell: (p) => {
          if (p.row.__isTotal) {
            return (
              <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.value as string}
              </span>
            );
          }
          const risk = showCompare ? atRiskLevel(p.row.delta_pct, p.row.prior_revenue) : null;
          const riskColor = risk === 'severe' ? 'var(--rd)' : risk === 'warn' ? 'var(--am)' : null;
          const tip =
            risk === 'severe' ? 'Severe drop vs prior period' :
            risk === 'warn'   ? 'Down 20%+ vs prior period'   : '';
          return (
            <span
              style={{
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
              title={tip || (p.value as string)}
            >
              {riskColor && (
                <AlertTriangle
                  size={12}
                  strokeWidth={2.4}
                  color={riskColor}
                  aria-label={tip}
                  style={{ flexShrink: 0 }}
                />
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.value as string}</span>
            </span>
          );
        },
      },
    ];

    if (sparklines) {
      cols.push({
        field: 'spark',
        headerName: 'Trend (12mo)',
        width: 110,
        sortable: false,
        filterable: false,
        valueGetter: () => null,
        renderCell: (p) =>
          p.row.__isTotal
            ? null
            : <Sparkline values={sparklines[p.row.dim_label] ?? Array(12).fill(0)} />,
      });
    }

    cols.push(
      {
        field: 'line_count',
        headerName: 'Lines',
        type: 'number',
        width: 88,
        cellClassName: 'mn',
        valueFormatter: (v) => (v != null ? fmtNum(Number(v)) : '—'),
      },
      {
        field: 'qty',
        headerName: 'Qty',
        type: 'number',
        width: 96,
        cellClassName: 'mn',
        valueFormatter: (v) => (v != null ? fmtNum(Number(v)) : '—'),
      },
      {
        field: 'revenue',
        headerName: 'Revenue',
        type: 'number',
        width: 130,
        cellClassName: 'mn',
        renderCell: (p) => (
          <span style={{ fontWeight: p.row.__isTotal ? 700 : 600 }}>{fm(p.value)}</span>
        ),
      },
    );

    if (showCompare) {
      cols.push(
        {
          field: 'prior_revenue',
          headerName: 'Prior Rev',
          type: 'number',
          width: 120,
          cellClassName: 'mn',
          renderCell: (p) => (
            <span style={{ color: 'var(--mt)' }}>{p.value != null ? fm(p.value) : '—'}</span>
          ),
        },
        {
          field: 'delta_revenue',
          headerName: 'Δ $',
          type: 'number',
          width: 110,
          cellClassName: 'mn',
          renderCell: (p) => {
            if (p.value == null) return <span style={{ color: 'var(--mt)' }}>—</span>;
            const v = Number(p.value);
            return (
              <span style={{ color: deltaColor(v), fontWeight: 600 }}>
                {(v >= 0 ? '+' : '') + fm(v)}
              </span>
            );
          },
        },
        {
          field: 'delta_pct',
          headerName: 'Δ %',
          type: 'number',
          width: 100,
          cellClassName: 'mn',
          renderCell: (p) => {
            if (p.value == null) return <span style={{ color: 'var(--mt)' }}>—</span>;
            const v = Number(p.value);
            return (
              <span style={{ color: deltaColor(v), fontWeight: 600 }}>
                {(v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'}
              </span>
            );
          },
        },
      );
    }

    cols.push(
      {
        field: 'est_cost',
        headerName: 'Est Cost',
        type: 'number',
        width: 116,
        cellClassName: 'mn',
        valueFormatter: (v) => (v != null ? fm(v) : '—'),
      },
      {
        field: 'est_margin',
        headerName: 'Est Margin',
        type: 'number',
        width: 116,
        cellClassName: 'mn',
        valueFormatter: (v) => (v != null ? fm(v) : '—'),
      },
      {
        field: 'margin_pct',
        headerName: 'Margin %',
        type: 'number',
        width: 104,
        cellClassName: 'mn',
        renderCell: (p) => (
          <span style={{ color: marginColor(p.value), fontWeight: 600 }}>{fp(p.value)}</span>
        ),
      },
    );

    for (const xc of extraColumns ?? []) {
      cols.push({
        field: 'xc_' + xc.id,
        headerName: xc.label,
        type: 'number',
        width: xc.width,
        cellClassName: 'mn',
        sortable: true,
        valueGetter: xc.compute
          ? (_value, row) => {
              const out = xc.compute!(row as SalesPivotRow & Record<string, unknown>);
              return out as number | string | null;
            }
          : (_value, row) => (xc.enrichmentKey ? (row as Record<string, unknown>)[xc.enrichmentKey] ?? null : null),
        valueFormatter: (v) => (xc.format ? xc.format(v) : v == null ? '—' : String(v)),
      });
    }

    return cols;
  }, [dim, showCompare, sparklines, extraColumns]);

  return (
    <DataGridPro
      rows={dataRows}
      pinnedRows={{ bottom: [totalsRow] }}
      columns={columns}
      density="compact"
      disableRowSelectionOnClick
      pagination
      pageSizeOptions={[10, 20, 40, 60, 100, { value: -1, label: 'All' }]}
      onRowClick={onRowClick
        ? (params) => { if (!params.row.__isTotal) onRowClick(params.row); }
        : undefined}
      initialState={{
        pagination: { paginationModel: { pageSize: 20, page: 0 } },
        pinnedColumns: { left: ['dim_label'] },
        sorting: { sortModel: [{ field: 'revenue', sort: 'desc' }] },
      }}
      sx={{
        height: '62vh',
        border: 'none',
        background: 'transparent',
        color: 'var(--ink)',
        fontFamily: 'inherit',
        fontSize: 12,
        '--DataGrid-rowBorderColor': 'rgba(255,255,255,0.04)',
        '--DataGrid-containerBackground': 'var(--sf)',
        '& .MuiDataGrid-columnHeaders': {
          background: 'var(--sf)',
          borderBottom: '1px solid var(--bd)',
        },
        '& .MuiDataGrid-columnHeader': {
          fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
          fontSize: 10.5, color: 'var(--mt)',
        },
        '& .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within': { outline: 'none' },
        '& .MuiDataGrid-cell': { borderBottom: '1px solid rgba(255,255,255,0.04)', py: 0.5 },
        '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': { outline: 'none' },
        '& .MuiDataGrid-row:hover': { background: 'rgba(91, 181, 240, 0.05)' },
        '& .MuiDataGrid-row.MuiDataGrid-row--pinned, & .MuiDataGrid-pinnedRows': {
          background: 'var(--sf)', fontWeight: 700, borderTop: '2px solid var(--bd)',
        },
        '& .MuiDataGrid-pinnedColumns': { background: 'var(--sf)', boxShadow: '4px 0 12px rgba(0,0,0,0.35)' },
        '& .MuiDataGrid-pinnedColumnHeaders': { background: 'var(--sf)' },
        '& .MuiDataGrid-footerContainer': { borderTop: '1px solid var(--bd)', background: 'var(--sf)', minHeight: 44 },
        '& .MuiTablePagination-root': { color: 'var(--tx)', fontFamily: 'inherit', fontSize: 12 },
        '& .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows': {
          color: 'var(--mt)', fontSize: 11, fontFamily: 'inherit', letterSpacing: 0.3,
        },
        '& .MuiTablePagination-select': {
          color: 'var(--ac)', fontWeight: 700, fontFamily: 'var(--ff-mono)', fontSize: 12,
        },
        '& .MuiTablePagination-actions .MuiIconButton-root': {
          color: 'var(--tx2)',
          '&:hover': { background: 'rgba(91, 181, 240, 0.08)', color: 'var(--ac)' },
          '&.Mui-disabled': { color: 'var(--mt)', opacity: 0.4 },
        },
        '& .MuiDataGrid-overlay': { background: 'var(--sf)', color: 'var(--mt)' },
        '& .mn': { fontFeatureSettings: '"tnum" on, "lnum" on' },
        '& .MuiDataGrid-iconSeparator': { color: 'rgba(255,255,255,0.10)' },
        '& .MuiDataGrid-menuIconButton, & .MuiDataGrid-sortIcon': { color: 'var(--mt)' },
        '& .MuiDataGrid-columnSeparator': { color: 'rgba(255,255,255,0.06)' },
        '& .MuiDataGrid-scrollbar': { background: 'transparent' },
        '& .MuiDataGrid-scrollbar::-webkit-scrollbar': { width: 10, height: 10 },
        '& .MuiDataGrid-scrollbar::-webkit-scrollbar-thumb': { background: 'rgba(91, 181, 240, 0.20)', borderRadius: 6 },
      }}
    />
  );
}
