import { PieChart } from '@mui/x-charts/PieChart';
import { CHART_COLORS, fmtCompact } from './util';

export interface DonutDatum {
  label: string;
  value: number;
  color?: string;
}

interface Props {
  data: DonutDatum[];
  height?: number;
  centerLabel?: string;
  centerValue?: string;
  formatValue?: (v: number) => string;
  ariaLabel?: string;
}

export function DonutChart({
  data,
  height = 240,
  centerLabel,
  centerValue,
  formatValue = fmtCompact,
  ariaLabel,
}: Props) {
  const total = data.reduce((s, d) => s + Math.max(0, Number(d.value || 0)), 0);
  if (total === 0 || data.length === 0) return <div className="ld">No data.</div>;

  const seriesData = data.map((d, i) => ({
    id: d.label + '-' + i,
    value: Math.max(0, Number(d.value || 0)),
    label: d.label,
    color: d.color ?? CHART_COLORS[i % CHART_COLORS.length],
  }));

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      style={{ position: 'relative', width: '100%', height }}
    >
      <PieChart
        height={height}
        margin={{ top: 10, right: 14, bottom: 10, left: 14 }}
        series={[{
          data: seriesData,
          innerRadius: 56,
          outerRadius: Math.min(height / 2 - 10, 110),
          paddingAngle: 1.6,
          cornerRadius: 3,
          highlightScope: { faded: 'global', highlighted: 'item' },
          faded: { innerRadius: 56, additionalRadius: -4, color: 'gray' },
          valueFormatter: (item: { value: number }) => {
            const pct = ((item.value / total) * 100).toFixed(1);
            return `${formatValue(item.value)} · ${pct}%`;
          },
        }]}
        slotProps={{
          legend: {
            direction: 'column',
            position: { vertical: 'middle', horizontal: 'right' },
            labelStyle: { fill: '#E6EEF1', fontSize: 11 },
            itemMarkWidth: 10,
            itemMarkHeight: 10,
            markGap: 6,
            itemGap: 8,
          },
        }}
        sx={{
          '& .MuiChartsLegend-root':     { fontFamily: 'inherit' },
          '& .MuiChartsTooltip-root':    { fontFamily: 'inherit' },
        }}
      />
      {(centerLabel || centerValue) && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            // Center over the donut hole. The pie sits in the left portion
            // of the chart area because legend is positioned on the right;
            // center horizontally on the pie's center, not the full width.
            width: 'calc(100% - 220px)',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            textAlign: 'center',
          }}
        >
          {centerLabel && (
            <div
              style={{
                fontSize: 10,
                color: 'var(--mt)',
                textTransform: 'uppercase',
                letterSpacing: 1.5,
                fontWeight: 600,
              }}
            >
              {centerLabel}
            </div>
          )}
          {centerValue && (
            <div
              style={{
                fontFamily: 'var(--ff-display)',
                fontSize: 20,
                fontWeight: 700,
                color: 'var(--tx)',
                fontVariantNumeric: 'tabular-nums',
                marginTop: 2,
              }}
            >
              {centerValue}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
