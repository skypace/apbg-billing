import { useMemo, useRef, useState } from 'react';
import { CHART_COLORS, fmtCompact } from './util';
import { Tooltip } from './Tooltip';

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

// Donut with center value + side legend, hover highlights segment.
export function DonutChart({
  data,
  height = 240,
  centerLabel,
  centerValue,
  formatValue = fmtCompact,
  ariaLabel,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const W = 800;
  const cx = 160;
  const cy = height / 2;
  const Router = Math.min(cy - 10, 110);
  const Rinner = Router - 38;

  const total = useMemo(() => data.reduce((s, d) => s + Math.max(0, Number(d.value || 0)), 0), [data]);

  if (total === 0 || data.length === 0) {
    return <div className="ld">No data.</div>;
  }

  let acc = 0;
  const segments = data.map((d, i) => {
    const v = Math.max(0, Number(d.value || 0));
    const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += v;
    const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + Router * Math.cos(a0);
    const y0 = cy + Router * Math.sin(a0);
    const x1 = cx + Router * Math.cos(a1);
    const y1 = cy + Router * Math.sin(a1);
    const ix0 = cx + Rinner * Math.cos(a0);
    const iy0 = cy + Rinner * Math.sin(a0);
    const ix1 = cx + Rinner * Math.cos(a1);
    const iy1 = cy + Rinner * Math.sin(a1);
    const path = `M ${x0} ${y0} A ${Router} ${Router} 0 ${large} 1 ${x1} ${y1} L ${ix1} ${iy1} A ${Rinner} ${Rinner} 0 ${large} 0 ${ix0} ${iy0} Z`;
    return {
      datum: d,
      path,
      color: d.color ?? CHART_COLORS[i % CHART_COLORS.length],
      pct: v / total,
    };
  });

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel}
      >
        {segments.map((s, i) => (
          <path
            key={s.datum.label + i}
            d={s.path}
            fill={s.color}
            opacity={hover === null || hover === i ? 0.92 : 0.35}
            stroke="var(--bg)"
            strokeWidth={1.5}
            style={{ transition: 'opacity 120ms ease', cursor: 'pointer' }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        {(centerLabel || centerValue) && (
          <>
            {centerLabel && (
              <text
                x={cx}
                y={cy - 8}
                fontSize="10"
                fill="var(--mt)"
                textAnchor="middle"
                style={{ font: '10px system-ui', textTransform: 'uppercase', letterSpacing: '1px' }}
              >
                {centerLabel}
              </text>
            )}
            {centerValue && (
              <text
                x={cx}
                y={cy + 12}
                fontSize="18"
                fill="var(--tx)"
                textAnchor="middle"
                fontWeight={700}
                style={{ font: '700 18px system-ui' }}
              >
                {centerValue}
              </text>
            )}
          </>
        )}

        {/* Legend on the right side of the chart area */}
        {segments.map((s, i) => {
          const ly = 18 + i * 20;
          if (ly > height - 12) return null;
          return (
            <g
              key={'lg' + i}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            >
              <rect x={310} y={ly - 8} width={11} height={11} fill={s.color} rx={2} />
              <text
                x={326}
                y={ly}
                fontSize="11"
                fill="var(--tx)"
                style={{ font: '11px system-ui' }}
              >
                {s.datum.label.length > 36 ? s.datum.label.slice(0, 34) + '…' : s.datum.label}
              </text>
              <text
                x={W - 14}
                y={ly}
                fontSize="11"
                fill="var(--mt)"
                textAnchor="end"
                style={{ font: '11px monospace' }}
              >
                {formatValue(s.datum.value)} · {(s.pct * 100).toFixed(1)}%
              </text>
            </g>
          );
        })}
      </svg>

      {hover != null && (
        <Tooltip
          x={cx * ((wrapRef.current?.getBoundingClientRect().width ?? W) / W)}
          y={cy * (height / height)}
          visible
          width={wrapRef.current?.getBoundingClientRect().width ?? W}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{segments[hover].datum.label}</div>
          <div style={{ color: segments[hover].color, fontFamily: 'monospace' }}>
            {formatValue(segments[hover].datum.value)} · {(segments[hover].pct * 100).toFixed(1)}%
          </div>
        </Tooltip>
      )}
    </div>
  );
}
