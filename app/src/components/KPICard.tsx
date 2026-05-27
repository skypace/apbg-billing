import type { ReactNode } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface Props {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Optional delta % vs prior period — drives sentiment coloring + arrow. */
  deltaPct?: number | null;
  /** Optional 12-mo sparkline values for a microchart at the bottom. */
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
        ? deltaPct > 0 ? 'pos' : deltaPct < 0 ? 'neg' : 'neutral'
        : deltaPct > 0 ? 'neg' : deltaPct < 0 ? 'pos' : 'neutral';

  const sentimentColor =
    sentiment === 'pos' ? 'var(--success)' :
    sentiment === 'neg' ? 'var(--danger)'  :
                          'var(--mt)';

  const sentimentBg =
    sentiment === 'pos' ? 'rgba(0, 200, 150, 0.10)' :
    sentiment === 'neg' ? 'rgba(224, 79, 95, 0.10)' :
                          'rgba(255, 255, 255, 0.04)';

  const TrendIcon = sentiment === 'pos' ? TrendingUp : sentiment === 'neg' ? TrendingDown : Minus;
  const valueColor = accent ?? undefined;

  return (
    <div
      className="kpi-card cd"
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <div className="kpi-head">
        <div className="kpi-title">{title}</div>
        {deltaPct != null && (
          <div
            className="kpi-delta"
            style={{ color: sentimentColor, background: sentimentBg, borderColor: sentimentColor }}
          >
            <TrendIcon size={11} strokeWidth={2.5} />
            <span>{FMT_PCT(deltaPct)}</span>
          </div>
        )}
      </div>

      <div
        className="kpi-value"
        style={{ color: valueColor ?? 'var(--tx)' }}
      >
        {value}
      </div>

      {sub != null && <div className="kpi-sub">{sub}</div>}

      {sparkline && sparkline.length > 0 && (
        <div className="kpi-spark">
          {renderSparkline(sparkline, sentimentColor)}
        </div>
      )}
    </div>
  );
}

function renderSparkline(values: number[], color: string) {
  const max = Math.max(1, ...values);
  const w = 100;
  const h = 32;
  const stepX = w / Math.max(values.length - 1, 1);
  const pad = 2;

  const pointsArr = values.map((v, i) => ({
    x: i * stepX,
    y: h - pad - (Math.max(0, v) / max) * (h - pad * 2),
  }));

  const linePoints = pointsArr.map((p) => `${p.x},${p.y}`).join(' ');
  const areaPath =
    `M ${pointsArr[0].x},${h} ` +
    pointsArr.map((p) => `L ${p.x},${p.y}`).join(' ') +
    ` L ${pointsArr[pointsArr.length - 1].x},${h} Z`;

  // Stable-ish unique gradient id (color hash) so multiple cards on the page
  // don't share the same defs.
  const gid = 'g-' + (color.replace(/[^a-z0-9]/gi, '') || 'c') + '-' + values.length;

  const last = pointsArr[pointsArr.length - 1];

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0"    />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gid})`} stroke="none" />
      <polyline
        points={linePoints}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        opacity={0.95}
      />
      <circle cx={last.x} cy={last.y} r={2} fill={color} />
      <circle cx={last.x} cy={last.y} r={4} fill={color} opacity={0.25} />
    </svg>
  );
}
