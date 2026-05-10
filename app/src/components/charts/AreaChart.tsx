import { LineChart } from '@mui/x-charts/LineChart';
import { fmtCompact } from './util';

export interface AreaSeries {
  name: string;
  color: string;
  values: number[];
}

interface Props {
  labels: string[];
  series: AreaSeries[];
  height?: number;
  formatValue?: (v: number) => string;
  ariaLabel?: string;
}

export function AreaChart({
  labels,
  series,
  height = 240,
  formatValue = fmtCompact,
  ariaLabel,
}: Props) {
  if (labels.length === 0 || series.length === 0) {
    return <div className="ld">No data.</div>;
  }

  const muiSeries = series.map((s) => ({
    data: s.values,
    label: s.name,
    color: s.color,
    area: true,
    showMark: false,
    curve: 'monotoneX' as const,
    valueFormatter: (v: number | null) => (v == null ? '—' : formatValue(v)),
  }));

  return (
    <div role="img" aria-label={ariaLabel} style={{ width: '100%' }}>
      <LineChart
        height={height}
        margin={{ top: 14, right: 14, bottom: 30, left: 56 }}
        series={muiSeries}
        xAxis={[{
          scaleType: 'point',
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
        sx={{
          '& .MuiChartsAxis-line':       { stroke: 'rgba(255,255,255,0.08)' },
          '& .MuiChartsAxis-tick':       { stroke: 'rgba(255,255,255,0.08)' },
          '& .MuiChartsGrid-line':       { stroke: 'rgba(255,255,255,0.04)' },
          '& .MuiAreaElement-root':      {
            fillOpacity: 0.32,
            filter: 'drop-shadow(0 6px 14px rgba(91, 181, 240, 0.20))',
          },
          '& .MuiLineElement-root':      {
            strokeWidth: 2.6,
            filter: 'drop-shadow(0 0 6px rgba(91, 181, 240, 0.45))',
          },
          '& .MuiMarkElement-root':      {
            stroke: 'var(--bg)',
            strokeWidth: 1.5,
            transition: 'r 120ms ease',
          },
          '& .MuiMarkElement-root:hover': { r: 6 },
          '& .MuiChartsTooltip-root':    { fontFamily: 'inherit' },
          '& .MuiChartsLegend-root':     { fontFamily: 'inherit' },
        }}
      />
    </div>
  );
}
