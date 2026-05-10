import { BarChart as MuiBarChart } from '@mui/x-charts/BarChart';
import { CHART_COLORS, fmtCompact } from './util';

export interface BarDatum {
  label: string;
  value: number;
  /** Optional comparison value, e.g. prior period. */
  compareValue?: number | null;
  color?: string;
}

interface Props {
  data: BarDatum[];
  height?: number;
  /** Show prior-period overlay bars? */
  showCompare?: boolean;
  /** Chart label for screen readers. */
  ariaLabel?: string;
  /** Format used in tooltips and tick labels. */
  formatValue?: (v: number) => string;
  /** Click handler on a bar. */
  onSelect?: (datum: BarDatum) => void;
}

export function BarChart({
  data,
  height = 240,
  showCompare = false,
  ariaLabel,
  formatValue = fmtCompact,
  onSelect,
}: Props) {
  if (data.length === 0) return <div className="ld">No data.</div>;

  const labels = data.map((d) => d.label);
  const values = data.map((d) => Number(d.value || 0));
  const priorValues = showCompare ? data.map((d) => Number(d.compareValue ?? 0)) : null;

  // Use the first datum's color as the primary series tint, falling back
  // to the brand cyan so bars always feel "on brand."
  const primaryColor = data[0]?.color ?? CHART_COLORS[0];

  const series: Array<Record<string, unknown>> = [
    {
      data: values,
      label: 'Current',
      color: primaryColor,
      valueFormatter: (v: number | null) => (v == null ? '—' : formatValue(v)),
    },
  ];
  if (priorValues) {
    series.push({
      data: priorValues,
      label: 'Prior',
      color: '#6B8190',
      valueFormatter: (v: number | null) => (v == null ? '—' : formatValue(v)),
    });
  }

  return (
    <div role="img" aria-label={ariaLabel} style={{ width: '100%' }}>
      <MuiBarChart
        height={height}
        margin={{ top: 14, right: 14, bottom: 36, left: 56 }}
        series={series}
        xAxis={[{
          scaleType: 'band',
          data: labels,
          tickLabelStyle: { fontSize: 9, fill: '#9FB3BB' },
        }]}
        yAxis={[{
          valueFormatter: (v: number) => formatValue(v),
          tickLabelStyle: { fontSize: 9, fill: '#9FB3BB' },
        }]}
        slotProps={{
          legend: {
            direction: 'row',
            position: { vertical: 'bottom', horizontal: 'middle' },
            labelStyle: { fill: '#9FB3BB', fontSize: 11 },
            itemMarkWidth: 10,
            itemMarkHeight: 10,
            markGap: 6,
            itemGap: 14,
          },
        }}
        onItemClick={onSelect ? (_e, item) => {
          const idx = (item as { dataIndex?: number }).dataIndex;
          if (idx != null && data[idx]) onSelect(data[idx]);
        } : undefined}
        sx={{
          '& .MuiChartsAxis-line':         { stroke: 'var(--bd)' },
          '& .MuiChartsAxis-tick':         { stroke: 'var(--bd)' },
          '& .MuiChartsGrid-line':         { stroke: 'rgba(255,255,255,0.04)' },
          '& .MuiChartsTooltip-root':      { fontFamily: 'inherit' },
          '& .MuiChartsLegend-root':       { fontFamily: 'inherit' },
          '& .MuiBarElement-root':         { transition: 'opacity 120ms ease' },
          '& .MuiBarElement-root:hover':   { opacity: 0.85 },
        }}
      />
    </div>
  );
}
