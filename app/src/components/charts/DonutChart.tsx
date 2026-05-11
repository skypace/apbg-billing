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

// Legend column width reserved on the right of the chart container.
const LEGEND_WIDTH = 150;

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

  const outerR = Math.max(60, height / 2 - 14);
  const innerR = Math.max(40, outerR - 36);

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      style={{ position: 'relative', width: '100%', height }}
    >
      <PieChart
        height={height}
        margin={{ top: 8, right: LEGEND_WIDTH, bottom: 8, left: 8 }}
        series={[{
          data: seriesData,
          innerRadius: innerR,
          outerRadius: outerR,
          paddingAngle: 2,
          cornerRadius: 3,
          highlightScope: { faded: 'global', highlighted: 'item' },
          // Use a near-zero additionalRadius so hover doesn't shift
          // geometry — we lift via drop-shadow instead.
          faded:       { innerRadius: innerR, additionalRadius: -4, color: 'gray' },
          highlighted: { additionalRadius: 0 },
          valueFormatter: (item: { value: number }) => {
            const pct = ((item.value / total) * 100).toFixed(1);
            return `${formatValue(item.value)} · ${pct}%`;
          },
        }]}
        slotProps={{
          legend: {
            direction: 'column',
            position: { vertical: 'middle', horizontal: 'right' },
            labelStyle: { fill: '#E6EEF7', fontSize: 11 },
            itemMarkWidth: 10,
            itemMarkHeight: 10,
            markGap: 8,
            itemGap: 6,
          },
        }}
        sx={{
          '& .MuiChartsLegend-root':  { fontFamily: 'inherit' },
          '& .MuiChartsLegend-label': { color: 'var(--tx)' },
          '& .MuiChartsTooltip-root': { fontFamily: 'inherit' },
          '& .MuiPieArc-root': {
            stroke: 'var(--bg)',
            strokeWidth: 2,
            filter: 'drop-shadow(0 0 10px rgba(91, 181, 240, 0.18))',
            transition: 'filter 200ms ease',
          },
          '& .MuiPieArc-root:hover': {
            filter: 'drop-shadow(0 0 20px rgba(91, 181, 240, 0.55))',
          },
        }}
      />

      {/* Center label overlay — anchored in the PIE region (excludes the
          legend column on the right) so hover-induced slice growth never
          shifts the label. */}
      {(centerLabel || centerValue) && (
        <div
          style={{
            position: 'absolute',
            top: 0, bottom: 0, left: 0,
            right: LEGEND_WIDTH,
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
                  fontSize: 22,
                  fontWeight: 700,
                  color: 'var(--tx)',
                  fontVariantNumeric: 'tabular-nums',
                  marginTop: 4,
                  textShadow: '0 0 18px rgba(91, 181, 240, 0.35)',
                  whiteSpace: 'nowrap',
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
