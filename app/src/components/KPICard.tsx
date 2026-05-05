import type { ReactNode } from 'react';

interface Props {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Optional delta % vs prior period — drives sentiment coloring + arrow. */
  deltaPct?: number | null;
  /** Optional 12-mo sparkline values for a microchart in the corner. */
  sparkline?: number[];
  /** Override sentiment hue (defaults to deltaPct sign). */
  accent?: string;
  /** Polarity flips the sentiment colors — set 'inverse' for "lower is better"
   *  metrics like AR overdue or stale invoices. */
  polarity?: 'normal' | 'inverse';
  onClick?: () => void;
}

const FMT_PCT = (v: number) => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';

export function KPICard({
  title,
  value,
  sub,
  deltaPct,
  sparkline,
  accent,
  polarity = 'normal',
  onClick,
}: Props) {
  const sentiment =
    deltaPct == null
      ? 'neutral'
      : polarity === 'normal'
        ? deltaPct > 0
          ? 'pos'
          : deltaPct < 0
            ? 'neg'
            : 'neutral'
        : deltaPct > 0
          ? 'neg'
          : deltaPct < 0
            ? 'pos'
            : 'neutral';

  const sentimentColor =
    sentiment === 'pos'
      ? 'var(--success)'
      : sentiment === 'neg'
        ? 'var(--danger)'
        : 'var(--mt)';

  const valueColor = accent ?? undefined;

  // Microchart values (simple bar sparkline, taller for more impact).
  const sparklineSvg = sparkline && sparkline.length > 0 ? renderSparkline(sparkline, sentimentColor) : null;

  return (
    <div
      className="cd"
      onClick={onClick}
      style={{
        position: 'relative',
        padding: '12px 14px 14px',
        cursor: onClick ? 'pointer' : 'default',
        background: 'var(--sf)',
        backgroundImage: 'var(--grad-card)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 4,
        }}
      >
        <div
          style={{
            fontSize: 9,
            color: 'var(--mt)',
            letterSpacing: 1.2,
            textTransform: 'uppercase',
            fontWeight: 600,
          }}
        >
          {title}
        </div>
        {deltaPct != null && (
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: sentimentColor,
              fontFamily: 'monospace',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
            }}
          >
            <span>{deltaPct > 0 ? '▲' : deltaPct < 0 ? '▼' : '◆'}</span>
            <span>{FMT_PCT(deltaPct)}</span>
          </div>
        )}
      </div>

      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: valueColor ?? 'var(--tx)',
          fontVariantNumeric: 'tabular-nums',
          marginBottom: sub ? 4 : 0,
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>

      {sub != null && (
        <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.4 }}>
          {sub}
        </div>
      )}

      {sparklineSvg && (
        <div style={{ marginTop: 8, height: 28 }}>
          {sparklineSvg}
        </div>
      )}
    </div>
  );
}

function renderSparkline(values: number[], color: string) {
  const max = Math.max(1, ...values);
  const w = 100;
  const h = 28;
  const stepX = w / Math.max(values.length - 1, 1);
  const points = values
    .map((v, i) => `${i * stepX},${h - (Math.max(0, v) / max) * (h - 2)}`)
    .join(' ');
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.2}
        opacity={0.85}
        vectorEffect="non-scaling-stroke"
      />
      {values.map((v, i) => {
        if (i !== values.length - 1) return null;
        return (
          <circle
            key={i}
            cx={i * stepX}
            cy={h - (Math.max(0, v) / max) * (h - 2)}
            r={1.6}
            fill={color}
          />
        );
      })}
    </svg>
  );
}
