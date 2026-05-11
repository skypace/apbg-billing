import { useMemo, useRef, useState } from 'react';
import { fmtCompact, niceTicks } from './util';
import { Tooltip } from './Tooltip';

export interface AreaSeries {
  name: string;
  color: string;
  values: number[];
}

interface Props {
  /** X-axis tick labels, one per index. */
  labels: string[];
  series: AreaSeries[];
  height?: number;
  formatValue?: (v: number) => string;
  ariaLabel?: string;
}

// Multi-series filled-area chart. Series share one Y axis. Hover crosshair
// shows the exact value at that x for each series.
export function AreaChart({
  labels,
  series,
  height = 240,
  formatValue = fmtCompact,
  ariaLabel,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const W = 800;
  const padL = 50;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const innerW = W - padL - padR;
  const innerH = height - padT - padB;
  const stepX = innerW / Math.max(labels.length - 1, 1);

  const max = useMemo(() => {
    let m = 0;
    for (const s of series) for (const v of s.values) m = Math.max(m, Number(v || 0));
    return m;
  }, [series]);

  const ticks = useMemo(() => niceTicks(max, 4), [max]);
  const tickMax = ticks[ticks.length - 1] || 1;
  const yFor = (v: number) => padT + innerH - (v / tickMax) * innerH;

  function pointsFor(values: number[]): string {
    return values
      .map((v, i) => `${padL + i * stepX} ${yFor(Number(v || 0))}`)
      .join(' L ');
  }
  function areaFor(values: number[]): string {
    if (values.length === 0) return '';
    const top = values.map((v, i) => `${padL + i * stepX} ${yFor(Number(v || 0))}`).join(' L ');
    const last = padL + (values.length - 1) * stepX;
    return `M ${padL} ${padT + innerH} L ${top} L ${last} ${padT + innerH} Z`;
  }

  if (labels.length === 0 || series.length === 0) {
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
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = (e.clientX - rect.left) * (W / rect.width);
          if (px < padL || px > W - padR) { setHoverX(null); return; }
          const idx = Math.round((px - padL) / stepX);
          setHoverX(Math.max(0, Math.min(labels.length - 1, idx)));
        }}
        onMouseLeave={() => setHoverX(null)}
      >
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.name + i} id={`area-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={s.color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>

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
                style={{ stroke: 'var(--bd)' }}
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

        {/* Areas + lines */}
        {series.map((s, i) => (
          <g key={s.name + i}>
            <path d={areaFor(s.values)} fill={`url(#area-grad-${i})`} />
            <path
              d={`M ${pointsFor(s.values)}`}
              stroke={s.color}
              strokeWidth={1.8}
              fill="none"
            />
          </g>
        ))}

        {/* X labels */}
        {labels.map((lb, i) => {
          if (labels.length > 12 && i % Math.ceil(labels.length / 12) !== 0) return null;
          return (
            <text
              key={lb + i}
              x={padL + i * stepX}
              y={height - 12}
              fontSize="9"
              fill="var(--mt)"
              textAnchor="middle"
              style={{ font: '9px system-ui' }}
            >
              {lb}
            </text>
          );
        })}

        {/* Crosshair */}
        {hoverX != null && (
          <line
            x1={padL + hoverX * stepX}
            x2={padL + hoverX * stepX}
            y1={padT}
            y2={padT + innerH}
            stroke="var(--bd2)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
        {hoverX != null && series.map((s, i) => (
          <circle
            key={'dot-' + i}
            cx={padL + hoverX * stepX}
            cy={yFor(Number(s.values[hoverX] || 0))}
            r={3}
            fill={s.color}
            stroke="var(--bg)"
            strokeWidth={1.5}
          />
        ))}

        {/* Axes */}
        <line x1={padL} x2={padL} y1={padT} y2={padT + innerH} stroke="var(--bd)" />
        <line x1={padL} x2={W - padR} y1={padT + innerH} y2={padT + innerH} stroke="var(--bd)" />
      </svg>

      {hoverX != null && (
        <Tooltip
          x={((padL + hoverX * stepX) / W) * (wrapRef.current?.getBoundingClientRect().width ?? W)}
          y={padT * (height / W)}
          visible
          width={wrapRef.current?.getBoundingClientRect().width ?? W}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{labels[hoverX]}</div>
          {series.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontFamily: 'monospace', fontSize: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block' }} />
              <span style={{ flex: 1 }}>{s.name}</span>
              <span style={{ color: s.color }}>{formatValue(Number(s.values[hoverX] || 0))}</span>
            </div>
          ))}
        </Tooltip>
      )}

      {series.length > 1 && (
        <div style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--mt)', marginTop: 4, paddingLeft: 50 }}>
          {series.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: 'inline-block' }} />
              <span>{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
