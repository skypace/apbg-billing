import { useMemo, useRef, useState } from 'react';
import { CHART_COLORS, fmtCompact, niceTicks } from './util';
import { Tooltip } from './Tooltip';

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
  /** Chart label below; for screen readers. */
  ariaLabel?: string;
  /** Format used in tooltips and tick labels. */
  formatValue?: (v: number) => string;
  /** Click handler on a bar. */
  onSelect?: (datum: BarDatum) => void;
}

// Vertical bar chart with axes, gridlines, hover tooltip, optional
// prior-period overlay. Responsive viewBox so it scales to its
// container.
export function BarChart({
  data,
  height = 240,
  showCompare = false,
  ariaLabel,
  formatValue = fmtCompact,
  onSelect,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);

  const W = 800;
  const padL = 50;
  const padR = 14;
  const padT = 14;
  const padB = 36;
  const innerW = W - padL - padR;
  const innerH = height - padT - padB;

  const max = useMemo(() => {
    let m = 0;
    for (const d of data) {
      m = Math.max(m, Number(d.value || 0));
      if (showCompare && d.compareValue != null) m = Math.max(m, Number(d.compareValue));
    }
    return m;
  }, [data, showCompare]);

  const ticks = useMemo(() => niceTicks(max, 4), [max]);
  const tickMax = ticks[ticks.length - 1] || 1;
  const yFor = (v: number) => padT + innerH - (v / tickMax) * innerH;
  const groupW = innerW / Math.max(data.length, 1);
  const barW = Math.max(2, Math.min(groupW * (showCompare ? 0.36 : 0.62), 56));

  if (data.length === 0) {
    return <div className="ld">No data.</div>;
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel}
      >
        {/* Gridlines + Y ticks */}
        {ticks.map((t) => {
          const y = yFor(t);
          return (
            <g key={t}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke="rgba(255,255,255,0.04)"
                strokeWidth={1}
              />
              <text
                x={padL - 6}
                y={y + 3}
                fontSize="9"
                fill="var(--mt)"
                textAnchor="end"
                style={{ font: '9px system-ui' }}
              >
                {formatValue(t)}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {data.map((d, i) => {
          const cx = padL + groupW * i + groupW / 2;
          const v = Number(d.value || 0);
          const cv = d.compareValue != null ? Number(d.compareValue) : null;
          const h = Math.max(0, (v / tickMax) * innerH);
          const ch = cv != null ? Math.max(0, (cv / tickMax) * innerH) : 0;
          const fill = d.color ?? CHART_COLORS[i % CHART_COLORS.length];
          const isHover = hover?.idx === i;

          return (
            <g
              key={d.label + i}
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onMouseEnter={() => {
                const wrap = wrapRef.current;
                const rect = wrap?.getBoundingClientRect();
                const scaleX = rect ? rect.width / W : 1;
                const scaleY = rect ? rect.height / height : 1;
                setHover({ idx: i, x: cx * scaleX, y: yFor(Math.max(v, cv ?? 0)) * scaleY });
              }}
              onMouseLeave={() => setHover(null)}
              onClick={onSelect ? () => onSelect(d) : undefined}
            >
              {showCompare && cv != null && (
                <rect
                  x={cx - barW + 2}
                  y={padT + innerH - ch}
                  width={barW}
                  height={ch}
                  fill={fill}
                  opacity={isHover ? 0.5 : 0.32}
                  rx={2}
                />
              )}
              <rect
                x={showCompare ? cx + 2 : cx - barW / 2}
                y={padT + innerH - h}
                width={barW}
                height={h}
                fill={fill}
                opacity={isHover ? 1 : 0.88}
                rx={2}
              />
              <text
                x={cx}
                y={height - 18}
                fontSize="9"
                fill="var(--mt)"
                textAnchor="middle"
                style={{ font: '9px system-ui' }}
              >
                {d.label.length > 14 ? d.label.slice(0, 12) + '…' : d.label}
              </text>
              {/* invisible hitbox spans the full group, makes tooltip easy */}
              <rect
                x={padL + groupW * i}
                y={padT}
                width={groupW}
                height={innerH}
                fill="transparent"
              />
            </g>
          );
        })}

        {/* Axes */}
        <line
          x1={padL}
          x2={padL}
          y1={padT}
          y2={padT + innerH}
          stroke="var(--bd)"
          strokeWidth={1}
        />
        <line
          x1={padL}
          x2={W - padR}
          y1={padT + innerH}
          y2={padT + innerH}
          stroke="var(--bd)"
          strokeWidth={1}
        />
      </svg>

      {hover && (
        <Tooltip
          x={hover.x}
          y={hover.y}
          visible
          width={wrapRef.current?.getBoundingClientRect().width ?? W}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{data[hover.idx]?.label}</div>
          <div style={{ color: 'var(--ac)', fontFamily: 'monospace' }}>
            {formatValue(Number(data[hover.idx]?.value || 0))}
          </div>
          {showCompare && data[hover.idx]?.compareValue != null && (
            <div style={{ color: 'var(--mt)', fontFamily: 'monospace', fontSize: 10 }}>
              prior: {formatValue(Number(data[hover.idx]?.compareValue || 0))}
            </div>
          )}
        </Tooltip>
      )}
    </div>
  );
}
