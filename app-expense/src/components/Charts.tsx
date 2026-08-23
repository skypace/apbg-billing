// Lightweight, dependency-free SVG charts for the Brixpense dashboard.
// Apple-clean: flat fills, rounded caps, generous whitespace, tabular numbers.
// Colors are fixed hues that read on both the light and dark themes.

import { formatCurrency } from '@/lib/utils';

export const CHART_COLORS = [
  '#0071e3', // blue
  '#34c759', // green
  '#ff9f0a', // orange
  '#ff375f', // pink-red
  '#5e5ce6', // indigo
  '#64d2ff', // cyan
  '#bf5af2', // purple
  '#ffd60a', // yellow
];

export interface Slice {
  label: string;
  value: number;
}

/** Roll a long tail of slices into a single "Other" bucket. */
function topWithOther(data: Slice[], max: number): Slice[] {
  const sorted = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= max) return sorted;
  const head = sorted.slice(0, max - 1);
  const tail = sorted.slice(max - 1);
  const other = tail.reduce((s, d) => s + d.value, 0);
  return [...head, { label: 'Other', value: other }];
}

/** Donut chart with a centered total and a legend. */
export function Donut({ data, total }: { data: Slice[]; total: number }) {
  const slices = topWithOther(data, 6);
  const sum = slices.reduce((s, d) => s + d.value, 0) || 1;
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="flex items-center gap-5 flex-wrap">
      <svg viewBox="0 0 140 140" className="h-[140px] w-[140px] shrink-0">
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--bd-light)" strokeWidth="18" />
        {slices.map((s, i) => {
          const frac = s.value / sum;
          const dash = frac * c;
          const el = (
            <circle
              key={s.label}
              cx="70"
              cy="70"
              r={r}
              fill="none"
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth="18"
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
              transform="rotate(-90 70 70)"
            />
          );
          offset += dash;
          return el;
        })}
        <text x="70" y="66" textAnchor="middle" className="fill-foreground" style={{ fontSize: 17, fontWeight: 800 }}>
          {compactCurrency(total)}
        </text>
        <text x="70" y="84" textAnchor="middle" style={{ fontSize: 9, fontWeight: 700, fill: 'var(--mt)', letterSpacing: '0.08em' }}>
          THIS YEAR
        </text>
      </svg>
      <div className="flex-1 min-w-[160px] space-y-1.5">
        {slices.map((s, i) => (
          <div key={s.label} className="flex items-center gap-2 text-sm">
            <span
              className="h-2.5 w-2.5 rounded-full shrink-0"
              style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
            />
            <span className="flex-1 truncate text-foreground" title={s.label}>{s.label}</span>
            <span className="tabular-nums font-semibold text-foreground">{formatCurrency(s.value)}</span>
            <span className="tabular-nums text-xs text-muted-foreground w-9 text-right">
              {Math.round((s.value / sum) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Horizontal bar list — ranked, with value labels. */
export function BarList({ data, max = 6 }: { data: Slice[]; max?: number }) {
  const rows = [...data]
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, max);
  const top = rows.length ? rows[0].value : 1;

  return (
    <div className="space-y-2.5">
      {rows.map((d, i) => (
        <div key={d.label}>
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-sm text-foreground truncate" title={d.label}>{d.label}</span>
            <span className="text-sm font-semibold tabular-nums text-foreground shrink-0">
              {formatCurrency(d.value)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-[var(--bd-light)] overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.max(4, (d.value / top) * 100)}%`,
                background: CHART_COLORS[i % CHART_COLORS.length],
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** $1.2k / $3.4M style for the donut centerpiece. */
function compactCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}
