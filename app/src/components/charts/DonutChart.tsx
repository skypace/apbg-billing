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

const LEGEND_HEIGHT = 60;

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

  // Pie geometry — outer ring sized to available area minus legend.
  const pieRoom = height - LEGEND_HEIGHT;
  const outerR  = Math.max(60, pieRoom / 2 - 10);
  const innerR  = Math.max(40, outerR - 36);

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      style={{ position: 'relative', width: '100%', height }}
    >
      <PieChart
        height={height}
        margin={{ top: 8, right: 8, bottom: LEGEND_HEIGHT, left: 8 }}
        series={[{
          data: seriesData,
          innerRadius: innerR,
          outerRadius: outerR,
          paddingAngle: 2.4,
          cornerRadius: 4,
          highlightScope: { faded: 'global', highlighted: 'item' },
          faded:       { innerRadius: innerR, additionalRadius: -10, color: 'gray' },
          highlighted: { additionalRadius: 6 },
          valueFormatter: (item: { value: number }) => {
            const pct = ((item.value / total) * 100).toFixed(1);
            return `${formatValue(item.value)} · ${pct}%`;
          },
        }]}
        slotProps={{
          legend: {
            direction: 'row',
            position: { vertical: 'bottom', horizontal: 'middle' },
            labelStyle: { fill: '#9FB3BB', fontSize: 10.5 },
            itemMarkWidth: 9,
            itemMarkHeight: 9,
            markGap: 5,
            itemGap: 14,
          },
        }}
        sx={{
          '& .MuiChartsLegend-root':  { fontFamily: 'inherit' },
          '& .MuiChartsTooltip-root': { fontFamily: 'inherit' },
          '& .MuiPieArc-root': {
            stroke: 'var(--bg)',
            strokeWidth: 2,
            filter: 'drop-shadow(0 0 12px rgba(91, 181, 240, 0.18))',
            transition: 'filter 200ms ease',
          },
          '& .MuiPieArc-root:hover': {
            filter: 'drop-shadow(0 0 24px rgba(91, 181, 240, 0.50))',
          },
        }}
      />

      {/* Center label overlay — positioned over the pie center,
          which sits in the top half of the container (legend takes the bottom). */}
      {(centerLabel || centerValue) && (
        <div
          style={{
            position: 'absolute',
            top: 0, right: 0, left: 0,
            bottom: LEGEND_HEIGHT,
            display: 'grid',
            placeItems: 'center',
            pointerEvents: 'none',
            textAlign: 'center',
          }}
        >
          <div>
            {centerLabel && (
              <div
                style={{
                  fontSize: 9,
                  color: 'var(--mt)',
                  textTransform: 'uppercase',
                  letterSpacing: 1.5,
                  fontWeight: 700,
                }}
              >
                {centerLabel}
              </div>
            )}
            {centerValue && (
              <div
                style={{
                  fontFamily: 'var(--ff-display)',
                  fontSize: 24,
                  fontWeight: 700,
                  color: 'var(--tx)',
                  fontVariantNumeric: 'tabular-nums',
                  marginTop: 4,
                  textShadow: '0 0 18px rgba(91, 181, 240, 0.35)',
                }}
              >
                {centerValue}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
