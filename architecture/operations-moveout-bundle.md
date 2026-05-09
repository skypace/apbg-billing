# Operations moveout bundle

This bundle contains every file needed to lift the fleet/operations features out of `skypace/apbg-billing` and into `alamedapointbg/operations`. Database tables / migrations / edge functions are already applied to the shared Supabase project — only the React/TypeScript code needs to move.

## How to use this

1. **Paste this entire markdown** into a fresh Claude Code session pointed at `alamedapointbg/operations`.
2. Tell that session: *"Apply this moveout bundle to the operations repo. Adapt to the existing stack — if files in section 1 already exist, skip them. Wire the routes per section 5. Don't modify the Supabase project."*
3. The new session's Claude will create / update the files and produce a PR.
4. **After** that PR ships and you've verified Operations + Fleet load correctly in the new home, come back here and I'll open the apbg-billing-side cleanup PR (remove FleetPage / OperationsPage / FleetDriversEditor / FLEET + OPERATIONS nav items).

## Architecture context

- Same Supabase project as apbg-billing (`https://gfsdpwiqzshhexkofiif.supabase.co`).
- All `ops.*` schema tables, views, edge functions, crons are already in place. No DB work needed.
- Auth: existing Supabase Auth session (anon key reads, authenticated writes via RLS).
- Routing: apbg-billing uses hash-based routing (`#fleet`, `#operations`). Adapt to the operations repo's router (Next.js App Router, React Router, etc.).
- Stack assumed: Vite + React 18 + TypeScript. If operations is on Next.js, the page components are still functional — just drop into `app/` directories.

## Section index

1. Shared utilities (skip if operations has equivalents)
   - `src/lib/supabase.ts` — Supabase client
   - `src/lib/rpc.ts` — PostgREST helpers
   - `src/lib/formatters.ts` — currency / percent / number formatters
   - `src/lib/csv.ts` — CSV export helper
   - `src/lib/styles.ts` — inline-style helpers
2. Components
   - `src/components/KPICard.tsx`
   - `src/components/charts/util.ts`
   - `src/components/charts/Tooltip.tsx`
   - `src/components/charts/AreaChart.tsx`
   - `src/components/charts/BarChart.tsx`
3. Domain libraries
   - `src/lib/fleet.ts`
   - `src/lib/kpi.ts`
4. Pages
   - `src/pages/FleetPage.tsx` (Map / Trips / Stops / Reconcile / Drivers / Safety tabs)
   - `src/pages/OperationsPage.tsx` (Delivery / Service / Reman tabs)
   - `src/pages/settings/FleetDriversEditor.tsx`
5. Routing & nav wiring instructions

---

## Section 1 — Shared utilities

### `src/lib/supabase.ts`

```ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';

export const SB_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
export const SB_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';

// Auth client (public schema): used for sign-in, session, JWT.
export const sbAuth: SupabaseClient<Database> = createClient<Database>(
  SB_URL,
  SB_KEY,
  { auth: { persistSession: true, autoRefreshToken: true } },
);

// Returns the user's bearer token if signed in, otherwise the anon key.
export async function _sbToken(): Promise<string> {
  try {
    const s = await sbAuth.auth.getSession();
    return s?.data?.session?.access_token || SB_KEY;
  } catch {
    return SB_KEY;
  }
}
```

### `src/lib/rpc.ts`

```ts
import { SB_URL, SB_KEY, _sbToken } from './supabase';

// Thin wrappers around PostgREST that target the `ops` schema.
// They mirror the helpers from the legacy single-file SPA so page
// migrations stay tight.

export async function sbq<T = unknown>(tbl: string, query = ''): Promise<T[]> {
  const url = SB_URL + '/rest/v1/' + tbl + (query ? '?' + query : '');
  const token = await _sbToken();
  const res = await fetch(url, {
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error('sbq ' + tbl + ' failed: ' + res.status);
  return res.json() as Promise<T[]>;
}

export async function sbrpc<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('sbrpc ' + fn + ' failed: ' + res.status + ' ' + text);
  }
  return res.json() as Promise<T>;
}

export async function sbInsert<T = unknown>(tbl: string, row: T): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/rest/v1/' + tbl, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error('sbInsert ' + tbl + ' failed: ' + res.status);
  return res.json() as Promise<T>;
}

export async function sbUpdate<T = unknown>(
  tbl: string,
  filter: string,
  patch: Partial<T>,
): Promise<T> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/rest/v1/' + tbl + '?' + filter, {
    method: 'PATCH',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('sbUpdate ' + tbl + ' failed: ' + res.status);
  return res.json() as Promise<T>;
}

export async function sbDelete(tbl: string, filter: string): Promise<void> {
  const token = await _sbToken();
  const res = await fetch(SB_URL + '/rest/v1/' + tbl + '?' + filter, {
    method: 'DELETE',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'ops',
    },
  });
  if (!res.ok) throw new Error('sbDelete ' + tbl + ' failed: ' + res.status);
}
```

### `src/lib/formatters.ts`

```ts
// Currency, percent, and date formatters extracted from the legacy
// single-file SPA. Same names so component migrations stay near-1:1.

export function fm(v: unknown): string {
  const n = Number(v ?? 0);
  if (!isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

export function fp(v: unknown): string {
  if (v == null) return '—';
  const n = Number(v);
  if (!isFinite(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}

export function fd(v: unknown): string {
  if (!v) return '—';
  return String(v).slice(0, 10);
}

export function fmtNum(v: unknown, digits = 0): string {
  const n = Number(v ?? 0);
  if (!isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}
```

### `src/lib/csv.ts`

```ts
// Tiny CSV serializer + browser download helper. Used by every page
// that exposes an "Export CSV" button.

function csvEscape(v: unknown): string {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
```

### `src/lib/styles.ts`

```ts
import type { CSSProperties } from 'react';

// Shared inline-style helpers. Mirrors the legacy CSS-var palette
// declared in src/styles/theme.css.

export const inp = (): CSSProperties => ({
  background: 'var(--sf2)',
  color: 'var(--tx)',
  border: '1px solid var(--bd)',
  padding: '4px 8px',
  borderRadius: 4,
  fontSize: 11,
  fontFamily: 'inherit',
});

export const btnPrimary = (): CSSProperties => ({
  background: 'var(--ac)',
  color: 'var(--bg)',
  border: '1px solid var(--ac)',
  padding: '5px 11px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  cursor: 'pointer',
});

export const btnSecondary = (): CSSProperties => ({
  background: 'var(--sf2)',
  color: 'var(--tx)',
  border: '1px solid var(--bd)',
  padding: '5px 11px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0.5,
  cursor: 'pointer',
});

export const btnDanger = (): CSSProperties => ({
  background: 'transparent',
  color: 'var(--rd)',
  border: '1px solid var(--rd)',
  padding: '3px 8px',
  borderRadius: 4,
  fontSize: 10,
  cursor: 'pointer',
});
```

## Section 2 — Components

### `src/components/KPICard.tsx`

```tsx
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
```

### `src/components/charts/util.ts`

```ts
// Shared chart helpers: number-to-pixel scaling, tick generators,
// SVG-friendly currency/percent formatters.

export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const step = niceStep(max / count);
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 0.0001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const norm = raw / base;
  let nice: number;
  if (norm < 1.5) nice = 1;
  else if (norm < 3) nice = 2;
  else if (norm < 7) nice = 5;
  else nice = 10;
  return nice * base;
}

export function fmtCompact(v: number): string {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000) return '$' + (v / 1_000).toFixed(0) + 'k';
  return '$' + v.toFixed(0);
}

export function fmtCount(v: number): string {
  if (!isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export const CHART_COLORS = [
  '#22d3ee',
  '#34d399',
  '#fbbf24',
  '#a78bfa',
  '#f472b6',
  '#60a5fa',
  '#fb923c',
  '#f87171',
  '#4ade80',
  '#fcd34d',
  '#c084fc',
  '#22c55e',
];
```

### `src/components/charts/Tooltip.tsx`

```tsx
import type { ReactNode } from 'react';

interface Props {
  x: number;
  y: number;
  visible: boolean;
  width: number;
  children: ReactNode;
}

// Anchored to chart-relative coords; flipped automatically near right/top
// edges so it never escapes the wrapper. Caller wraps the chart in a
// position:relative container.
export function Tooltip({ x, y, visible, width, children }: Props) {
  if (!visible) return null;
  const flipX = x + 200 > width;
  const left = flipX ? x - 12 : x + 12;
  const transform = flipX ? 'translate(-100%, -100%)' : 'translate(0, -100%)';
  return (
    <div
      style={{
        position: 'absolute',
        left,
        top: y - 4,
        transform,
        background: 'rgba(10, 14, 23, 0.96)',
        border: '1px solid var(--bd2)',
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 11,
        color: 'var(--tx)',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        boxShadow: 'var(--shadow)',
        zIndex: 10,
        backdropFilter: 'blur(6px)',
      }}
    >
      {children}
    </div>
  );
}
```

### `src/components/charts/AreaChart.tsx`

```tsx
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
```

### `src/components/charts/BarChart.tsx`

```tsx
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
```

## Section 3 — Domain libraries

### `src/lib/fleet.ts`

```ts
import { sbq } from './rpc';

// Vehicle metadata (slow-changing — synced hourly with sync-fleetcomplete?mode=vehicles).
export interface FleetVehicle {
  fc_asset_id: string;
  vehicle_name: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  license_plate: string | null;
  vin: string | null;
  status: string | null;
}

// Latest telemetry per vehicle (refreshed every 5 min by the
// fleetcomplete-latest-snapshots cron). One row per vehicle.
export interface FleetLatestSnapshot {
  fc_asset_id: string;
  snapshot_at: string;       // vehicle clock, ISO8601
  fetched_at:  string;       // when the syncer wrote this row
  gps_fix:     boolean | null;
  latitude:    number | null;
  longitude:   number | null;
  heading_deg: number | null;
  speed_kmh:   number | string | null;  // numeric column → may come back as string
  ignition_on: boolean | null;
  fc_driver_id: string | null;
}

// Joined view used by the live-map page. Matches a vehicle to its latest snap.
export interface FleetMapRow extends FleetVehicle {
  snap: FleetLatestSnapshot | null;
}

export async function fetchFleetMapRows(): Promise<FleetMapRow[]> {
  const [vehicles, snaps] = await Promise.all([
    sbq<FleetVehicle>('fleet_vehicles', 'select=fc_asset_id,vehicle_name,make,model,year,license_plate,vin,status'),
    sbq<FleetLatestSnapshot>('fleet_latest_snapshots', 'select=*'),
  ]);
  const byId = new Map<string, FleetLatestSnapshot>();
  for (const s of snaps) byId.set(s.fc_asset_id, s);
  return vehicles.map((v) => ({ ...v, snap: byId.get(v.fc_asset_id) ?? null }));
}

// ---------- drivers ----------

export interface FleetDriver {
  fc_person_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  employee_id: string | null;
  is_user: boolean;
}

export async function fetchFleetDrivers(): Promise<FleetDriver[]> {
  return sbq<FleetDriver>(
    'fleet_drivers',
    'select=fc_person_id,first_name,last_name,email,employee_id,is_user&order=last_name.asc.nullslast,first_name.asc',
  );
}

// ---------- trips ----------

export interface FleetTrip {
  fc_trip_id: string;
  fc_asset_id: string | null;
  fc_driver_id: string | null;
  trip_date: string;
  start_time: string;
  end_time: string;
  distance_miles: number | string | null;
  drive_time_min: number | string | null;
  idle_time_min: number | string | null;
  max_speed_mph: number | string | null;
  avg_speed_mph: number | string | null;
  hard_brakes: number | null;
  hard_accels: number | null;
  speed_violations: number | null;
}

export async function fetchRecentTrips(days = 7): Promise<FleetTrip[]> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  return sbq<FleetTrip>(
    'fleet_trips',
    'select=fc_trip_id,fc_asset_id,fc_driver_id,trip_date,start_time,end_time,distance_miles,drive_time_min,idle_time_min,max_speed_mph,avg_speed_mph,hard_brakes,hard_accels,speed_violations&start_time=gte.' + since + '&order=start_time.desc',
  );
}

// ---------- driver events ----------

export interface FleetDriverEvent {
  id: number;
  fc_asset_id: string;
  fc_driver_id: string | null;
  event_type: string;
  event_at: string;
  speed_kmh: number | string | null;
  latitude: number | null;
  longitude: number | null;
}

export async function fetchRecentDriverEvents(days = 7): Promise<FleetDriverEvent[]> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  return sbq<FleetDriverEvent>(
    'fleet_driver_events',
    'select=id,fc_asset_id,fc_driver_id,event_type,event_at,speed_kmh,latitude,longitude&event_at=gte.' + since + '&order=event_at.desc',
  );
}

// ---------- geofence count ----------

export async function fetchGeofenceCount(): Promise<number> {
  // PostgREST count via Prefer: count=exact; sbq doesn't expose that, so
  // just pull ids and len them. Geofence row count is bounded (≤ few hundred).
  const rows = await sbq<{ fc_geofence_id: string }>('fleet_geofences', 'select=fc_geofence_id');
  return rows.length;
}

// ---------- stop visits (auto-geofence from QBO customers) ----------

export interface FleetStopVisit {
  id: number;
  fc_asset_id: string;
  fc_driver_id: string | null;
  qbo_customer_id: string | null;
  arrival_time: string;
  departure_time: string | null;
  dwell_minutes: number | string | null;
  vehicle_lat: number | null;
  vehicle_lon: number | null;
  distance_m: number | string | null;
}

export interface QboCustomerLite {
  qbo_customer_id: string;
  display_name: string | null;
}

export async function fetchRecentStopVisits(days = 7): Promise<FleetStopVisit[]> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  return sbq<FleetStopVisit>(
    'fleet_stop_visits',
    'select=id,fc_asset_id,fc_driver_id,qbo_customer_id,arrival_time,departure_time,dwell_minutes,vehicle_lat,vehicle_lon,distance_m&arrival_time=gte.' + since + '&order=arrival_time.desc',
  );
}

export async function fetchCustomerNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const filter = 'qbo_customer_id=in.(' + ids.map((s) => '"' + s + '"').join(',') + ')';
  const rows = await sbq<QboCustomerLite>('qbo_customers', 'select=qbo_customer_id,display_name&' + filter);
  for (const r of rows) {
    if (r.qbo_customer_id) out.set(r.qbo_customer_id, r.display_name ?? '');
  }
  return out;
}

export interface GeocodeStats {
  ok: number;
  not_found: number;
  attempted: number;
}

export async function fetchGeocodeStats(): Promise<GeocodeStats> {
  const [ok, nf, att] = await Promise.all([
    sbq<{ qbo_customer_id: string }>('qbo_customers', 'select=qbo_customer_id&geocode_status=eq.ok'),
    sbq<{ qbo_customer_id: string }>('qbo_customers', 'select=qbo_customer_id&geocode_status=eq.not_found'),
    sbq<{ qbo_customer_id: string }>('qbo_customers', 'select=qbo_customer_id&geocoded_at=not.is.null'),
  ]);
  return { ok: ok.length, not_found: nf.length, attempted: att.length };
}

// ---------- billing reconciliation ----------

export interface ReconcileRow {
  qbo_customer_id: string;
  activity_date: string;
  customer_name: string | null;
  visit_count: number | string | null;
  total_dwell_min: number | string | null;
  invoice_amount_pm1: number | string | null;
  invoice_count_pm1: number | string | null;
  flag: 'matched' | 'visit_no_bill' | 'billed_no_visit';
}

export async function fetchReconcileRows(days = 30): Promise<ReconcileRow[]> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return sbq<ReconcileRow>(
    'v_fleet_stop_billing',
    'select=*&activity_date=gte.' + since + '&order=activity_date.desc',
  );
}

// ---------- service-job dwell mismatch ----------

export interface DwellMismatchRow {
  service_job_id: number;
  sf_job_number: string | null;
  job_date: string;
  sf_customer_name: string | null;
  qbo_customer_name: string | null;
  qbo_customer_id: string | null;
  tech_name: string | null;
  sf_duration_min: number | string | null;
  gps_dwell_min: number | string | null;
  gps_visits: number | null;
  delta_min: number | string | null;
  name_match_similarity: number | string | null;
  invoice_amount: number | string | null;
  sf_total: number | string | null;
  flag: 'over_billed' | 'under_billed' | 'matched' | 'no_gps';
}

export async function fetchDwellMismatchRows(): Promise<DwellMismatchRow[]> {
  return sbq<DwellMismatchRow>(
    'v_service_dwell_mismatch',
    'select=*&order=job_date.desc&limit=500',
  );
}
```

### `src/lib/kpi.ts`

```ts
// Typed wrappers for ops.kpi_daily — the per-(date, team_member) rollup
// produced by ops.fn_compute_kpi_daily, which runs nightly at 11:00 UTC.
//
// Direct PostgREST queries; no RPC needed. The table has ~7 active members
// × 30+ days of backfill, so unfiltered scans stay sub-100ms.

import { sbq } from './rpc';

export type Department = 'delivery' | 'service' | 'reman';

export interface KpiDailyRow {
  id: number;
  kpi_date: string;
  team_member_id: number;
  member_name: string | null;
  department: Department;
  entity: string | null;

  // Delivery
  stops_completed: number | null;
  delivery_revenue: number | null;
  delivery_cost: number | null;
  cost_per_stop: number | null;
  revenue_per_stop: number | null;
  margin_per_stop: number | null;
  miles_driven: number | null;
  revenue_per_mile: number | null;

  // Service
  jobs_completed: number | null;
  service_revenue: number | null;
  service_cost: number | null;
  cost_per_job: number | null;
  revenue_per_job: number | null;
  billable_hours: number | null;
  total_hours: number | null;
  utilization_pct: number | null;
  first_fix_pct: number | null;
  avg_response_min: number | null;

  // Reman
  units_completed: number | null;
  reman_revenue: number | null;
  reman_cost: number | null;
  labor_per_unit: number | null;
  parts_per_unit: number | null;
  margin_per_unit: number | null;
  turnaround_days: number | null;

  // GPS-confirmed counts (added 20260509i). Populated for any team_member
  // mapped to a fleet_driver in Settings → Fleet Drivers.
  gps_stops_confirmed: number | null;
  gps_dwell_min_total: number | null;
  gps_match_pct: number | null;

  computed_at: string;
}

// Monthly fuel-cost-per-stop, computed from QBO P&L expense line / stop counts.
// Backed by ops.v_fleet_fuel_cost_monthly.
export interface FuelCostMonthlyRow {
  month: string;
  fuel_expense: number | string;
  sf_stop_count: number;
  gps_stop_count: number;
  gps_matched_count: number;
  fuel_per_stop_sf: number | string | null;
  fuel_per_stop_gps: number | string | null;
  gps_vs_sf_delta_pct: number | string | null;
}

export async function fetchFuelCostMonthly(months = 12): Promise<FuelCostMonthlyRow[]> {
  return sbq<FuelCostMonthlyRow>(
    'v_fleet_fuel_cost_monthly',
    'select=*&order=month.desc&limit=' + months,
  );
}

// Fetch all kpi_daily rows for a department within a date window.
// Returns rows ordered by date ascending so chart consumers can use them
// directly without re-sorting.
export function fetchKpiDaily(opts: {
  department: Department;
  start: string;
  end: string;
}): Promise<KpiDailyRow[]> {
  const params = [
    'select=*',
    'department=eq.' + encodeURIComponent(opts.department),
    'kpi_date=gte.' + opts.start,
    'kpi_date=lte.' + opts.end,
    'order=kpi_date.asc,member_name.asc',
    'limit=5000',
  ].join('&');
  return sbq<KpiDailyRow>('kpi_daily', params);
}

// Aggregate helpers ---------------------------------------------------

export interface DailyAgg {
  kpi_date: string;
  activity: number;       // stops / jobs / units
  revenue: number;
  cost: number;
  margin: number;
}

// Sum across all members for each date — drives the daily activity chart.
export function aggregateByDay(rows: KpiDailyRow[], dept: Department): DailyAgg[] {
  const byDate = new Map<string, DailyAgg>();
  for (const r of rows) {
    const a = byDate.get(r.kpi_date) ?? {
      kpi_date: r.kpi_date,
      activity: 0,
      revenue: 0,
      cost: 0,
      margin: 0,
    };
    if (dept === 'delivery') {
      a.activity += Number(r.stops_completed || 0);
      a.revenue += Number(r.delivery_revenue || 0);
      a.cost += Number(r.delivery_cost || 0);
    } else if (dept === 'service') {
      a.activity += Number(r.jobs_completed || 0);
      a.revenue += Number(r.service_revenue || 0);
      a.cost += Number(r.service_cost || 0);
    } else {
      a.activity += Number(r.units_completed || 0);
      a.revenue += Number(r.reman_revenue || 0);
      a.cost += Number(r.reman_cost || 0);
    }
    a.margin = a.revenue - a.cost;
    byDate.set(r.kpi_date, a);
  }
  return Array.from(byDate.values()).sort((a, b) => a.kpi_date.localeCompare(b.kpi_date));
}

export interface MemberRollup {
  team_member_id: number;
  member_name: string;
  days_active: number;     // days with activity > 0
  activity: number;        // total stops / jobs / units
  revenue: number;
  cost: number;
  margin: number;
  margin_pct: number | null;
  // dept-specific extras (null when not applicable)
  utilization_pct: number | null;   // service: avg billable/total
  first_fix_pct: number | null;     // service: weighted by jobs
  avg_response_min: number | null;  // service: avg
  turnaround_days: number | null;   // reman: avg
}

// Per-member rollup for the breakdown table. Weighted aggregates where
// applicable (utilization, first-fix, turnaround) so members with more
// activity dominate.
export function rollupByMember(rows: KpiDailyRow[], dept: Department): MemberRollup[] {
  const byMember = new Map<number, {
    name: string;
    daysActive: number;
    activity: number;
    revenue: number;
    cost: number;
    billableHours: number;
    totalHours: number;
    firstFixWeight: number;
    firstFixSum: number;
    responseDays: number;
    responseSum: number;
    turnaroundDays: number;
    turnaroundSum: number;
  }>();

  for (const r of rows) {
    let activity = 0;
    let revenue = 0;
    let cost = 0;
    if (dept === 'delivery') {
      activity = Number(r.stops_completed || 0);
      revenue = Number(r.delivery_revenue || 0);
      cost = Number(r.delivery_cost || 0);
    } else if (dept === 'service') {
      activity = Number(r.jobs_completed || 0);
      revenue = Number(r.service_revenue || 0);
      cost = Number(r.service_cost || 0);
    } else {
      activity = Number(r.units_completed || 0);
      revenue = Number(r.reman_revenue || 0);
      cost = Number(r.reman_cost || 0);
    }
    const cur = byMember.get(r.team_member_id) ?? {
      name: r.member_name ?? '(unnamed)',
      daysActive: 0,
      activity: 0,
      revenue: 0,
      cost: 0,
      billableHours: 0,
      totalHours: 0,
      firstFixWeight: 0,
      firstFixSum: 0,
      responseDays: 0,
      responseSum: 0,
      turnaroundDays: 0,
      turnaroundSum: 0,
    };
    cur.activity += activity;
    cur.revenue += revenue;
    cur.cost += cost;
    if (activity > 0) cur.daysActive += 1;
    if (dept === 'service') {
      if (r.billable_hours != null) cur.billableHours += Number(r.billable_hours);
      if (r.total_hours != null) cur.totalHours += Number(r.total_hours);
      if (r.first_fix_pct != null && activity > 0) {
        cur.firstFixSum += Number(r.first_fix_pct) * activity;
        cur.firstFixWeight += activity;
      }
      if (r.avg_response_min != null) {
        cur.responseSum += Number(r.avg_response_min);
        cur.responseDays += 1;
      }
    }
    if (dept === 'reman' && r.turnaround_days != null) {
      cur.turnaroundSum += Number(r.turnaround_days);
      cur.turnaroundDays += 1;
    }
    byMember.set(r.team_member_id, cur);
  }

  return Array.from(byMember.entries()).map(([id, m]) => {
    const margin = m.revenue - m.cost;
    return {
      team_member_id: id,
      member_name: m.name,
      days_active: m.daysActive,
      activity: m.activity,
      revenue: m.revenue,
      cost: m.cost,
      margin,
      margin_pct: m.revenue > 0 ? margin / m.revenue : null,
      utilization_pct: dept === 'service' && m.totalHours > 0
        ? (m.billableHours / m.totalHours) * 100
        : null,
      first_fix_pct: dept === 'service' && m.firstFixWeight > 0
        ? m.firstFixSum / m.firstFixWeight
        : null,
      avg_response_min: dept === 'service' && m.responseDays > 0
        ? m.responseSum / m.responseDays
        : null,
      turnaround_days: dept === 'reman' && m.turnaroundDays > 0
        ? m.turnaroundSum / m.turnaroundDays
        : null,
    };
  }).sort((a, b) => b.activity - a.activity);
}
```

## Section 4 — Pages

### `src/pages/FleetPage.tsx`

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchFleetMapRows,
  fetchFleetDrivers,
  fetchRecentTrips,
  fetchRecentDriverEvents,
  fetchGeofenceCount,
  fetchRecentStopVisits,
  fetchCustomerNames,
  fetchGeocodeStats,
  fetchReconcileRows,
  fetchDwellMismatchRows,
  type FleetMapRow,
  type FleetDriver,
  type FleetTrip,
  type FleetDriverEvent,
  type FleetStopVisit,
  type GeocodeStats,
  type ReconcileRow,
  type DwellMismatchRow,
} from '../lib/fleet';

// Live fleet map.
//
// Reads ops.fleet_latest_snapshots (refreshed every 5 min by the
// fleetcomplete-latest-snapshots cron) joined to ops.fleet_vehicles, plots
// each vehicle as a colored marker on a Leaflet+OpenStreetMap canvas.
//
// Leaflet is loaded from a CDN on first render to avoid pulling a ~60KB
// mapping library into the main bundle. The CDN <link>+<script> survive
// across hash navigations (we don't unmount Leaflet's globals).

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

let leafletLoadPromise: Promise<void> | null = null;
function loadLeaflet(): Promise<void> {
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-leaflet]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      link.setAttribute('data-leaflet', '1');
      document.head.appendChild(link);
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-leaflet]');
    if (existing) {
      if ((window as any).L) return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('leaflet load failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = LEAFLET_JS;
    s.async = true;
    s.setAttribute('data-leaflet', '1');
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('leaflet load failed'));
    document.head.appendChild(s);
  });
  return leafletLoadPromise;
}

const REFRESH_MS = 30_000;            // page-side poll interval
const STALE_MS   = 60 * 60 * 1000;    // gray pin if snapshot older than 1 hour

function pinColor(row: FleetMapRow, now: number): string {
  if (!row.snap || !row.snap.gps_fix) return '#888';
  const t = Date.parse(row.snap.snapshot_at);
  if (isNaN(t) || now - t > STALE_MS)  return '#888';
  if (row.snap.ignition_on)            return '#22aa55';   // driving
  return '#3a78d9';                                         // parked, recent
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = Date.parse(iso);
  if (isNaN(d)) return '—';
  const sec = Math.round((Date.now() - d) / 1000);
  if (sec < 60)        return sec + 's ago';
  if (sec < 3600)      return Math.round(sec / 60) + 'm ago';
  if (sec < 86400)     return Math.round(sec / 3600) + 'h ago';
  return Math.round(sec / 86400) + 'd ago';
}

function vehicleLabel(v: FleetMapRow): string {
  return v.vehicle_name || (v.year ? v.year + ' ' : '') + (v.make || '') + ' ' + (v.model || '') || v.fc_asset_id;
}

type Tab = 'map' | 'trips' | 'stops' | 'reconcile' | 'drivers' | 'safety';

export function FleetPage() {
  const [tab, setTab] = useState<Tab>('map');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 70px)' }}>
      <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--bd)', display: 'flex', gap: 4 }}>
        {(['map', 'trips', 'stops', 'reconcile', 'drivers', 'safety'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: tab === t ? 'var(--ac)' : 'transparent',
              color: tab === t ? 'var(--bg)' : 'var(--tx)',
              border: '1px solid ' + (tab === t ? 'var(--ac)' : 'var(--bd)'),
              padding: '4px 12px',
              borderRadius: 4,
              fontSize: 11,
              fontWeight: tab === t ? 700 : 500,
              letterSpacing: 0.5,
              cursor: 'pointer',
            }}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>
      {tab === 'map'       && <MapTab />}
      {tab === 'trips'     && <TripsTab />}
      {tab === 'stops'     && <StopsTab />}
      {tab === 'reconcile' && <ReconcileTab />}
      {tab === 'drivers'   && <DriversTab />}
      {tab === 'safety'    && <SafetyTab />}
    </div>
  );
}

function MapTab() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<Map<string, any>>(new Map());

  const [rows, setRows] = useState<FleetMapRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState<number | null>(null);

  // Initial map setup once Leaflet is loaded.
  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then(() => {
      if (cancelled || !mapEl.current) return;
      const L = (window as any).L;
      if (mapRef.current) return;
      // Default view: Alameda yard. The first refresh fits to actual data.
      const map = L.map(mapEl.current).setView([37.78, -122.31], 11);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);
      mapRef.current = map;
    }).catch((e) => setErr(String(e)));
    return () => { cancelled = true; };
  }, []);

  // Data fetch + interval poll.
  useEffect(() => {
    let stopped = false;
    async function tick() {
      try {
        const data = await fetchFleetMapRows();
        if (stopped) return;
        setRows(data);
        setLastFetch(Date.now());
        setErr(null);
      } catch (e) {
        if (!stopped) setErr((e as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    }
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  // Re-paint markers whenever rows change AND the map is ready.
  useEffect(() => {
    const map = mapRef.current;
    const L = (window as any).L;
    if (!map || !L || rows.length === 0) return;

    const now = Date.now();
    const seen = new Set<string>();
    const fitBounds: [number, number][] = [];

    for (const row of rows) {
      const lat = row.snap?.latitude;
      const lon = row.snap?.longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number' || lat === 0 || lon === 0) continue;

      seen.add(row.fc_asset_id);
      fitBounds.push([lat, lon]);

      const color = pinColor(row, now);
      const label = vehicleLabel(row);
      const speedMph = row.snap?.speed_kmh != null
        ? (Number(row.snap.speed_kmh) * 0.621371).toFixed(0)
        : null;
      const popup =
        '<div style="font-size:12px;line-height:1.4">' +
        '<div style="font-weight:700;margin-bottom:4px">' + escapeHtml(label) + '</div>' +
        (row.license_plate ? '<div style="color:#666">' + escapeHtml(row.license_plate) + '</div>' : '') +
        '<div>' + (row.snap?.ignition_on ? 'Engine on' : 'Parked') +
            (speedMph ? ' · ' + speedMph + ' mph' : '') + '</div>' +
        '<div style="color:#666;margin-top:3px">' + relTime(row.snap?.snapshot_at) + '</div>' +
        '</div>';

      let marker = markersRef.current.get(row.fc_asset_id);
      if (!marker) {
        const icon = L.divIcon({
          className: 'fleet-pin',
          html:
            '<div style="' +
            'width:18px;height:18px;border-radius:50%;' +
            'background:' + color + ';' +
            'border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.3)' +
            '"></div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        marker = L.marker([lat, lon], { icon }).addTo(map);
        markersRef.current.set(row.fc_asset_id, marker);
      } else {
        marker.setLatLng([lat, lon]);
        marker.setIcon(L.divIcon({
          className: 'fleet-pin',
          html:
            '<div style="' +
            'width:18px;height:18px;border-radius:50%;' +
            'background:' + color + ';' +
            'border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.3)' +
            '"></div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }));
      }
      marker.bindPopup(popup);
    }

    // Drop markers for vehicles that disappeared from the data.
    for (const [id, m] of markersRef.current) {
      if (!seen.has(id)) {
        map.removeLayer(m);
        markersRef.current.delete(id);
      }
    }

    // Fit bounds on first paint with data; afterwards leave the user's view alone.
    if (fitBounds.length > 0 && !(map as any)._fittedOnce) {
      map.fitBounds(fitBounds, { padding: [40, 40], maxZoom: 14 });
      (map as any)._fittedOnce = true;
    }
  }, [rows]);

  const stale = rows.filter((r) => {
    if (!r.snap) return true;
    const t = Date.parse(r.snap.snapshot_at);
    return isNaN(t) || (Date.now() - t > STALE_MS);
  });
  const live  = rows.length - stale.length;

  return (
    <>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--bd)', display: 'flex', alignItems: 'center', gap: 14 }}>
        <Legend />
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 10, color: 'var(--mt)' }}>
          {loading ? 'loading…' :
            err ? <span style={{ color: '#c44' }}>{err}</span> :
            (live + ' live · ' + stale.length + ' stale · refreshed ' + relTime(lastFetch ? new Date(lastFetch).toISOString() : null))}
        </div>
      </div>
      <div ref={mapEl} style={{ flex: 1, background: '#222' }} />
      <SidePanel rows={rows} />
    </>
  );
}

function Legend() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 10, color: 'var(--mt)' }}>
      <Dot c="#22aa55" /> driving
      <Dot c="#3a78d9" /> parked
      <Dot c="#888"   /> stale (&gt;1h)
    </div>
  );
}

function Dot({ c }: { c: string }) {
  return <span style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: c,
    marginLeft: 8, marginRight: 2, verticalAlign: 'middle',
  }} />;
}

function SidePanel({ rows }: { rows: FleetMapRow[] }) {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const ta = a.snap ? Date.parse(a.snap.snapshot_at) : 0;
    const tb = b.snap ? Date.parse(b.snap.snapshot_at) : 0;
    return tb - ta;
  });
  return (
    <div style={{
      borderTop: '1px solid var(--bd)',
      maxHeight: 180,
      overflow: 'auto',
      fontSize: 11,
      background: 'var(--pn)',
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead style={{ position: 'sticky', top: 0, background: 'var(--pn)' }}>
          <tr style={{ color: 'var(--mt)', textAlign: 'left' }}>
            <th style={th}>Vehicle</th>
            <th style={th}>Plate</th>
            <th style={th}>State</th>
            <th style={thR}>Speed</th>
            <th style={thR}>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const t = r.snap ? Date.parse(r.snap.snapshot_at) : NaN;
            const isStale = !r.snap || isNaN(t) || (Date.now() - t > STALE_MS);
            const speedMph = r.snap?.speed_kmh != null
              ? (Number(r.snap.speed_kmh) * 0.621371).toFixed(0)
              : '—';
            return (
              <tr key={r.fc_asset_id} style={{ borderTop: '1px solid var(--bd)' }}>
                <td style={td}>{vehicleLabel(r)}</td>
                <td style={td}>{r.license_plate ?? '—'}</td>
                <td style={td}>
                  <span style={{
                    color: isStale ? '#888'
                      : r.snap?.ignition_on ? '#22aa55' : '#3a78d9',
                  }}>
                    {isStale ? 'stale' : r.snap?.ignition_on ? 'driving' : 'parked'}
                  </span>
                </td>
                <td style={tdR}>{r.snap?.ignition_on ? speedMph + ' mph' : '—'}</td>
                <td style={tdR}>{relTime(r.snap?.snapshot_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const th  = { padding: '4px 10px', fontWeight: 600 } as const;
const thR = { ...th, textAlign: 'right' as const };
const td  = { padding: '4px 10px' } as const;
const tdR = { ...td, textAlign: 'right' as const };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

// ---------- Trips tab ----------
//
// Last-7-days trip list joined to vehicle name and (when available) driver
// name. Sortable by start time desc by default. Displays distance, duration,
// max speed, and harsh-event counts.

function TripsTab() {
  const [trips, setTrips]     = useState<FleetTrip[]>([]);
  const [vehicles, setVeh]    = useState<FleetMapRow[]>([]);
  const [drivers, setDrivers] = useState<FleetDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    Promise.all([fetchRecentTrips(7), fetchFleetMapRows(), fetchFleetDrivers()])
      .then(([t, v, d]) => {
        if (stopped) return;
        setTrips(t); setVeh(v); setDrivers(d);
        setLoading(false);
      })
      .catch((e) => { if (!stopped) { setErr(String(e)); setLoading(false); } });
    return () => { stopped = true; };
  }, []);

  const vehicleById = useMemo(() => {
    const m = new Map<string, FleetMapRow>();
    for (const v of vehicles) m.set(v.fc_asset_id, v);
    return m;
  }, [vehicles]);
  const driverById = useMemo(() => {
    const m = new Map<string, FleetDriver>();
    for (const d of drivers) m.set(d.fc_person_id, d);
    return m;
  }, [drivers]);

  const totals = useMemo(() => {
    let miles = 0, drive = 0, idle = 0, brakes = 0, accels = 0, viol = 0;
    for (const t of trips) {
      miles  += Number(t.distance_miles  ?? 0);
      drive  += Number(t.drive_time_min  ?? 0);
      idle   += Number(t.idle_time_min   ?? 0);
      brakes += t.hard_brakes ?? 0;
      accels += t.hard_accels ?? 0;
      viol   += t.speed_violations ?? 0;
    }
    return { miles, drive, idle, brakes, accels, viol };
  }, [trips]);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
      <div style={{ display: 'flex', gap: 18, marginBottom: 14, fontSize: 11 }}>
        <Stat label="Trips (7d)"     value={String(trips.length)} />
        <Stat label="Miles"          value={totals.miles.toFixed(0)} />
        <Stat label="Drive hours"    value={(totals.drive / 60).toFixed(1)} />
        <Stat label="Idle hours"     value={(totals.idle / 60).toFixed(1)} />
        <Stat label="Hard brakes"    value={String(totals.brakes)} />
        <Stat label="Hard accels"    value={String(totals.accels)} />
        <Stat label="Speed violations" value={String(totals.viol)} />
      </div>
      {loading ? <div style={{ color: 'var(--mt)' }}>loading…</div> :
       err     ? <div style={{ color: '#c44' }}>{err}</div> :
       trips.length === 0 ? <div style={{ color: 'var(--mt)' }}>No trips in the last 7 days.</div> :
       (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ color: 'var(--mt)', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>
              <th style={th}>Date</th>
              <th style={th}>Vehicle</th>
              <th style={th}>Driver</th>
              <th style={th}>Start</th>
              <th style={th}>End</th>
              <th style={thR}>Miles</th>
              <th style={thR}>Drive</th>
              <th style={thR}>Idle</th>
              <th style={thR}>Max</th>
              <th style={thR}>Brakes</th>
              <th style={thR}>Accels</th>
              <th style={thR}>Speed</th>
            </tr>
          </thead>
          <tbody>
            {trips.map((t) => {
              const v = t.fc_asset_id ? vehicleById.get(t.fc_asset_id) : null;
              const d = t.fc_driver_id ? driverById.get(t.fc_driver_id) : null;
              return (
                <tr key={t.fc_trip_id} style={{ borderTop: '1px solid var(--bd)' }}>
                  <td style={td}>{t.trip_date}</td>
                  <td style={td}>{v ? vehicleLabel(v) : (t.fc_asset_id ?? '—').slice(0, 8) + '…'}</td>
                  <td style={td}>{d ? (d.first_name + ' ' + (d.last_name ?? '')) : (t.fc_driver_id ? '(unknown)' : '—')}</td>
                  <td style={td}>{shortTime(t.start_time)}</td>
                  <td style={td}>{shortTime(t.end_time)}</td>
                  <td style={tdR}>{Number(t.distance_miles ?? 0).toFixed(1)}</td>
                  <td style={tdR}>{Math.round(Number(t.drive_time_min ?? 0))}m</td>
                  <td style={tdR}>{Math.round(Number(t.idle_time_min ?? 0))}m</td>
                  <td style={tdR}>{Math.round(Number(t.max_speed_mph ?? 0))} mph</td>
                  <td style={tdR}>{(t.hard_brakes ?? 0) || ''}</td>
                  <td style={tdR}>{(t.hard_accels ?? 0) || ''}</td>
                  <td style={tdR}>{(t.speed_violations ?? 0) || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- Drivers tab ----------

function DriversTab() {
  const [drivers, setDrivers] = useState<FleetDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    fetchFleetDrivers()
      .then((d) => { if (!stopped) { setDrivers(d); setLoading(false); } })
      .catch((e) => { if (!stopped) { setErr(String(e)); setLoading(false); } });
    return () => { stopped = true; };
  }, []);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
      <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--mt)' }}>
        Synced from Unity getPeople (isDriver=true). Refreshed hourly.
      </div>
      {loading ? <div style={{ color: 'var(--mt)' }}>loading…</div> :
       err     ? <div style={{ color: '#c44' }}>{err}</div> :
       drivers.length === 0 ? <div style={{ color: 'var(--mt)' }}>No drivers synced yet.</div> :
       (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ color: 'var(--mt)', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>
              <th style={th}>Name</th>
              <th style={th}>Email</th>
              <th style={th}>Employee ID</th>
              <th style={th}>Portal user</th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((d) => (
              <tr key={d.fc_person_id} style={{ borderTop: '1px solid var(--bd)' }}>
                <td style={td}>{[d.first_name, d.last_name].filter(Boolean).join(' ') || '—'}</td>
                <td style={td}>{d.email ?? '—'}</td>
                <td style={td}>{d.employee_id ?? '—'}</td>
                <td style={td}>{d.is_user ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- Safety tab ----------
//
// Per-driver event counts, last 7 days. Bucketed by event_type. Score is a
// homegrown 0-100 (Powerfleet's official "Safety Score" comes from a wrapped
// report we can't reach yet).

function SafetyTab() {
  const [events, setEvents] = useState<FleetDriverEvent[]>([]);
  const [drivers, setDrivers] = useState<FleetDriver[]>([]);
  const [trips, setTrips] = useState<FleetTrip[]>([]);
  const [vehicles, setVeh] = useState<FleetMapRow[]>([]);
  const [geofenceCount, setGeofenceCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    Promise.all([
      fetchRecentDriverEvents(7),
      fetchFleetDrivers(),
      fetchRecentTrips(7),
      fetchFleetMapRows(),
      fetchGeofenceCount(),
    ])
      .then(([e, d, t, v, g]) => {
        if (stopped) return;
        setEvents(e); setDrivers(d); setTrips(t); setVeh(v); setGeofenceCount(g);
        setLoading(false);
      })
      .catch((e) => { if (!stopped) { setErr(String(e)); setLoading(false); } });
    return () => { stopped = true; };
  }, []);

  // Bucket events per driver/vehicle. driver may be null on the snapshot —
  // those events get bucketed by vehicle (label 'unknown driver').
  const safetyRows = useMemo(() => {
    interface Row {
      key: string;
      label: string;
      vehicleLabel: string | null;
      total: number;
      counts: Record<string, number>;
    }
    const map = new Map<string, Row>();
    for (const ev of events) {
      const key = ev.fc_driver_id || ('vehicle:' + ev.fc_asset_id);
      let row = map.get(key);
      if (!row) {
        const driver = ev.fc_driver_id ? drivers.find((d) => d.fc_person_id === ev.fc_driver_id) : null;
        const vehicle = vehicles.find((v) => v.fc_asset_id === ev.fc_asset_id);
        row = {
          key,
          label: driver
            ? [driver.first_name, driver.last_name].filter(Boolean).join(' ')
            : '(unknown driver)',
          vehicleLabel: vehicle ? vehicleLabel(vehicle) : null,
          total: 0,
          counts: {},
        };
        map.set(key, row);
      }
      row.total += 1;
      row.counts[ev.event_type] = (row.counts[ev.event_type] ?? 0) + 1;
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [events, drivers, vehicles]);

  // Total miles in window (use as denominator for events/100mi).
  const totalMiles = useMemo(() => trips.reduce((s, t) => s + Number(t.distance_miles ?? 0), 0), [trips]);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
      {geofenceCount === 0 && (
        <div style={{
          background: 'var(--pn)', border: '1px solid var(--bd)',
          padding: 10, borderRadius: 4, marginBottom: 14, fontSize: 11, color: 'var(--mt)',
        }}>
          <strong style={{ color: 'var(--tx)' }}>No Unity geofences.</strong>{' '}
          Stop attribution is using auto-geocoded QBO customer addresses instead — see the STOPS tab.
        </div>
      )}
      <div style={{ display: 'flex', gap: 18, marginBottom: 14, fontSize: 11 }}>
        <Stat label="Events (7d)"        value={String(events.length)} />
        <Stat label="Miles (7d)"         value={totalMiles.toFixed(0)} />
        <Stat label="Events / 100 mi"    value={totalMiles > 0 ? (100 * events.length / totalMiles).toFixed(1) : '—'} />
      </div>
      <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--mt)' }}>
        Per-driver event counts (last 7 days). Powerfleet's official "Safety Score" comes from a wrapped report that's currently broken upstream — these raw counts are the substitute.
      </div>
      {loading ? <div style={{ color: 'var(--mt)' }}>loading…</div> :
       err     ? <div style={{ color: '#c44' }}>{err}</div> :
       safetyRows.length === 0 ? <div style={{ color: 'var(--mt)' }}>No driver-behavior events in the last 7 days.</div> :
       (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ color: 'var(--mt)', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>
              <th style={th}>Driver</th>
              <th style={th}>Vehicle (last)</th>
              <th style={thR}>Events</th>
              <th style={thR}>Brake</th>
              <th style={thR}>Accel</th>
              <th style={thR}>Corner</th>
              <th style={thR}>Speed</th>
              <th style={thR}>Tailgate</th>
              <th style={thR}>Coll/Lane</th>
              <th style={thR}>Other</th>
            </tr>
          </thead>
          <tbody>
            {safetyRows.map((r) => {
              const c = r.counts;
              const speed = (c['MAX_SPEED_EXCEEDED'] ?? 0) + (c['SPEED_SIGN_VIOLATION'] ?? 0);
              const collLane = (c['FORWARD_COLLISION'] ?? 0) + (c['COLLISION'] ?? 0) + (c['LANE_DRIFT'] ?? 0) + (c['ROLL_OVER'] ?? 0);
              const known = (c['HARSH_BRAKING'] ?? 0) + (c['HARSH_ACCELERATION'] ?? 0) + (c['HARSH_CORNERING'] ?? 0) + speed + (c['TAILGATING'] ?? 0) + collLane;
              const other = r.total - known;
              return (
                <tr key={r.key} style={{ borderTop: '1px solid var(--bd)' }}>
                  <td style={td}>{r.label}</td>
                  <td style={td}>{r.vehicleLabel ?? '—'}</td>
                  <td style={tdR}>{r.total}</td>
                  <td style={tdR}>{c['HARSH_BRAKING'] || ''}</td>
                  <td style={tdR}>{c['HARSH_ACCELERATION'] || ''}</td>
                  <td style={tdR}>{c['HARSH_CORNERING'] || ''}</td>
                  <td style={tdR}>{speed || ''}</td>
                  <td style={tdR}>{c['TAILGATING'] || ''}</td>
                  <td style={tdR}>{collLane || ''}</td>
                  <td style={tdR}>{other || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: 'var(--mt)', fontSize: 9, letterSpacing: 0.4, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---------- Reconcile tab ----------
//
// Cross-reference of GPS-detected stops vs QBO invoices over the last 30
// days, ±1 day tolerance. The ops.v_fleet_stop_billing view does the join;
// this tab just paints it.
//
// Filter chips at the top let the user focus on one flag class at a time.
// 'billed_no_visit' is the row class that needs explanation: customer was
// billed but no truck arrived (the geocoded pin is wrong, the bill was for
// non-on-site work, OR the truck doing the work isn't on FleetComplete).

type ReconcileFilter = 'all' | 'billed_no_visit' | 'visit_no_bill' | 'matched';
type ReconcileMode   = 'billing' | 'dwell';

function ReconcileTab() {
  const [mode, setMode] = useState<ReconcileMode>('billing');
  const [rows, setRows] = useState<ReconcileRow[]>([]);
  const [dwellRows, setDwellRows] = useState<DwellMismatchRow[]>([]);
  const [filter, setFilter] = useState<ReconcileFilter>('billed_no_visit');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    Promise.all([fetchReconcileRows(30), fetchDwellMismatchRows()])
      .then(([r, d]) => { if (!stopped) { setRows(r); setDwellRows(d); setLoading(false); } })
      .catch((e) => { if (!stopped) { setErr(String(e)); setLoading(false); } });
    return () => { stopped = true; };
  }, []);

  const counts = useMemo(() => {
    const c = { matched: 0, visit_no_bill: 0, billed_no_visit: 0, all: rows.length };
    for (const r of rows) c[r.flag]++;
    return c;
  }, [rows]);

  const filtered = useMemo(() => (
    filter === 'all' ? rows : rows.filter((r) => r.flag === filter)
  ), [rows, filter]);

  const ghostBilledTotal = useMemo(() => (
    rows.filter((r) => r.flag === 'billed_no_visit')
        .reduce((s, r) => s + Number(r.invoice_amount_pm1 ?? 0), 0)
  ), [rows]);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        {(['billing', 'dwell'] as ReconcileMode[]).map((m) => {
          const on = mode === m;
          const label = m === 'billing' ? 'Billing reconciliation' : 'Service-job dwell mismatch';
          return (
            <button key={m} onClick={() => setMode(m)} style={{
              background: on ? 'var(--ac)' : 'transparent',
              color: on ? 'var(--bg)' : 'var(--tx)',
              border: '1px solid ' + (on ? 'var(--ac)' : 'var(--bd)'),
              padding: '4px 12px', borderRadius: 4, fontSize: 11,
              fontWeight: on ? 700 : 500, letterSpacing: 0.4, cursor: 'pointer',
            }}>{label}</button>
          );
        })}
      </div>
      {mode === 'dwell' ? <DwellMismatchPanel rows={dwellRows} loading={loading} err={err} /> : null}
      {mode === 'billing' && (
      <>
      <div style={{
        background: 'var(--pn)', border: '1px solid var(--bd)',
        padding: 10, borderRadius: 4, marginBottom: 14, fontSize: 11, color: 'var(--mt)',
      }}>
        <strong style={{ color: 'var(--tx)' }}>Billing reconciliation.</strong>{' '}
        For each (customer, day) over the last 30 days, this compares GPS-detected stops to QBO invoices within ±1 day. <strong>Billed-no-visit</strong> = invoice landed but no truck went there (ghost stop, off-tracker truck, or stale geocode). <strong>Visit-no-bill</strong> = truck visited but no invoice (missed bill, depot, warranty).
      </div>
      <div style={{ display: 'flex', gap: 18, marginBottom: 14, fontSize: 11 }}>
        <Stat label="Matched"            value={String(counts.matched)} />
        <Stat label="Billed-no-visit"    value={String(counts.billed_no_visit)} />
        <Stat label="Visit-no-bill"      value={String(counts.visit_no_bill)} />
        <Stat label="$ on ghost stops"   value={'$' + ghostBilledTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {(['billed_no_visit', 'visit_no_bill', 'matched', 'all'] as ReconcileFilter[]).map((f) => {
          const on = filter === f;
          const label = f === 'all' ? 'all' : f.replace(/_/g, ' ');
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                background: on ? 'var(--ac)' : 'transparent',
                color: on ? 'var(--bg)' : 'var(--tx)',
                border: '1px solid ' + (on ? 'var(--ac)' : 'var(--bd)'),
                padding: '3px 10px',
                borderRadius: 4,
                fontSize: 10,
                fontWeight: on ? 700 : 500,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      {loading ? <div style={{ color: 'var(--mt)' }}>loading…</div> :
       err     ? <div style={{ color: '#c44' }}>{err}</div> :
       filtered.length === 0 ? (
         <div style={{ color: 'var(--mt)' }}>
           Nothing in this bucket over the last 30 days.
         </div>
       ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ color: 'var(--mt)', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>
              <th style={th}>Date</th>
              <th style={th}>Customer</th>
              <th style={th}>Flag</th>
              <th style={thR}>Visits</th>
              <th style={thR}>Dwell</th>
              <th style={thR}>Invoices ±1d</th>
              <th style={thR}>$ ±1d</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const dwell = Number(r.total_dwell_min ?? 0);
              const dwellLabel = dwell >= 60
                ? Math.floor(dwell / 60) + 'h' + (dwell % 60 > 0 ? ' ' + Math.round(dwell % 60) + 'm' : '')
                : Math.round(dwell) + 'm';
              const flagColor = r.flag === 'matched' ? 'var(--mt)'
                : r.flag === 'billed_no_visit' ? '#d97a3a'
                : '#3a78d9';
              return (
                <tr key={r.qbo_customer_id + ':' + r.activity_date + ':' + i} style={{ borderTop: '1px solid var(--bd)' }}>
                  <td style={td}>{r.activity_date}</td>
                  <td style={td}>{r.customer_name ?? r.qbo_customer_id.slice(0, 8) + '…'}</td>
                  <td style={{ ...td, color: flagColor, textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10 }}>
                    {r.flag.replace(/_/g, ' ')}
                  </td>
                  <td style={tdR}>{r.visit_count ?? 0}</td>
                  <td style={tdR}>{dwell > 0 ? dwellLabel : '—'}</td>
                  <td style={tdR}>{r.invoice_count_pm1 ?? 0}</td>
                  <td style={tdR}>${Number(r.invoice_amount_pm1 ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      </>
      )}
    </div>
  );
}

function DwellMismatchPanel({ rows, loading, err }: { rows: DwellMismatchRow[]; loading: boolean; err: string | null }) {
  type DFilter = 'all' | 'over_billed' | 'under_billed' | 'no_gps' | 'matched';
  const [filter, setFilter] = useState<DFilter>('over_billed');

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length, over_billed: 0, under_billed: 0, matched: 0, no_gps: 0 };
    for (const r of rows) c[r.flag]++;
    return c;
  }, [rows]);

  const filtered = filter === 'all' ? rows : rows.filter((r) => r.flag === filter);

  return (
    <>
      <div style={{
        background: 'var(--pn)', border: '1px solid var(--bd)',
        padding: 10, borderRadius: 4, marginBottom: 14, fontSize: 11, color: 'var(--mt)',
      }}>
        <strong style={{ color: 'var(--tx)' }}>Service-job dwell mismatch.</strong>{' '}
        Compares Service Fusion's reported job duration to GPS dwell time at the same customer on the same day. Customer match via fuzzy name similarity (pg_trgm threshold 0.5). <strong>Over-billed</strong> = SF duration exceeds GPS dwell by &gt;50% (and &gt;30 min). <strong>Under-billed</strong> = SF underreports vs GPS. <strong>No-gps</strong> = no GPS visit found (most rows today, since GPS history just started — backfills as days pass).
      </div>
      <div style={{ display: 'flex', gap: 18, marginBottom: 14, fontSize: 11 }}>
        <Stat label="Total (90d)"   value={String(counts.all)} />
        <Stat label="Over-billed"   value={String(counts.over_billed)} />
        <Stat label="Under-billed"  value={String(counts.under_billed)} />
        <Stat label="No GPS"        value={String(counts.no_gps)} />
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {(['over_billed','under_billed','no_gps','matched','all'] as DFilter[]).map((f) => {
          const on = filter === f;
          return (
            <button key={f} onClick={() => setFilter(f)} style={{
              background: on ? 'var(--ac)' : 'transparent',
              color: on ? 'var(--bg)' : 'var(--tx)',
              border: '1px solid ' + (on ? 'var(--ac)' : 'var(--bd)'),
              padding: '3px 10px', borderRadius: 4, fontSize: 10,
              fontWeight: on ? 700 : 500, letterSpacing: 0.4,
              textTransform: 'uppercase', cursor: 'pointer',
            }}>{f.replace(/_/g, ' ')}</button>
          );
        })}
      </div>
      {loading ? <div style={{ color: 'var(--mt)' }}>loading…</div> :
       err     ? <div style={{ color: '#c44' }}>{err}</div> :
       filtered.length === 0 ? (
         <div style={{ color: 'var(--mt)' }}>Nothing in this bucket.</div>
       ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ color: 'var(--mt)', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>
              <th style={th}>Date</th>
              <th style={th}>Job#</th>
              <th style={th}>Customer (SF → QBO)</th>
              <th style={th}>Tech</th>
              <th style={th}>Flag</th>
              <th style={thR}>SF min</th>
              <th style={thR}>GPS min</th>
              <th style={thR}>Δ min</th>
              <th style={thR}>$ billed</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const flagColor = r.flag === 'over_billed' ? '#d97a3a'
                : r.flag === 'under_billed' ? '#3a78d9'
                : r.flag === 'matched' ? 'var(--mt)'
                : '#888';
              return (
                <tr key={r.service_job_id} style={{ borderTop: '1px solid var(--bd)' }}>
                  <td style={td}>{r.job_date}</td>
                  <td style={td}>{r.sf_job_number ?? '—'}</td>
                  <td style={td}>
                    {r.sf_customer_name}
                    {r.qbo_customer_name && r.qbo_customer_name !== r.sf_customer_name && (
                      <span style={{ color: 'var(--mt)' }}> → {r.qbo_customer_name}</span>
                    )}
                  </td>
                  <td style={td}>{r.tech_name ?? '—'}</td>
                  <td style={{ ...td, color: flagColor, textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10 }}>
                    {r.flag.replace(/_/g, ' ')}
                  </td>
                  <td style={tdR}>{Number(r.sf_duration_min ?? 0).toFixed(0)}</td>
                  <td style={tdR}>{r.gps_dwell_min != null ? Number(r.gps_dwell_min).toFixed(0) : '—'}</td>
                  <td style={tdR}>{r.delta_min != null ? Number(r.delta_min).toFixed(0) : '—'}</td>
                  <td style={tdR}>${Number(r.invoice_amount ?? r.sf_total ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---------- Stops tab ----------
//
// Lists fleet_stop_visits over the last 7 days. Each row is a "vehicle was
// parked here for ≥5 min" event, optionally matched to the nearest QBO
// customer within 200m. Unmatched stops are still useful — they show where
// the trucks stopped that we don't have a customer for (likely depots,
// fuel stations, or accounts not yet billed in the last 90 days).

function StopsTab() {
  const [stops,    setStops]    = useState<FleetStopVisit[]>([]);
  const [vehicles, setVehicles] = useState<FleetMapRow[]>([]);
  const [drivers,  setDrivers]  = useState<FleetDriver[]>([]);
  const [custNames, setCustNames] = useState<Map<string, string>>(new Map());
  const [stats,    setStats]    = useState<GeocodeStats | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [err,      setErr]      = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const [s, v, d, st] = await Promise.all([
          fetchRecentStopVisits(7),
          fetchFleetMapRows(),
          fetchFleetDrivers(),
          fetchGeocodeStats(),
        ]);
        if (stopped) return;
        setStops(s); setVehicles(v); setDrivers(d); setStats(st);

        const ids = Array.from(new Set(s.map((row) => row.qbo_customer_id).filter(Boolean) as string[]));
        if (ids.length > 0) {
          const names = await fetchCustomerNames(ids);
          if (!stopped) setCustNames(names);
        }
        setLoading(false);
      } catch (e) {
        if (!stopped) { setErr(String(e)); setLoading(false); }
      }
    })();
    return () => { stopped = true; };
  }, []);

  const vehicleById = useMemo(() => {
    const m = new Map<string, FleetMapRow>();
    for (const v of vehicles) m.set(v.fc_asset_id, v);
    return m;
  }, [vehicles]);
  const driverById = useMemo(() => {
    const m = new Map<string, FleetDriver>();
    for (const d of drivers) m.set(d.fc_person_id, d);
    return m;
  }, [drivers]);

  const matched = stops.filter((s) => s.qbo_customer_id).length;
  const unmatched = stops.length - matched;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
      <div style={{
        background: 'var(--pn)', border: '1px solid var(--bd)',
        padding: 10, borderRadius: 4, marginBottom: 14, fontSize: 11, color: 'var(--mt)',
      }}>
        Auto-geofencing: each stop's GPS is matched against geocoded QBO customer addresses (200 m radius). Cohort = customers billed in the last 90 days, plus the Alameda depot. Unmatched stops are likely depots, fuel stops, or accounts not yet in the cohort.
      </div>
      <div style={{ display: 'flex', gap: 18, marginBottom: 14, fontSize: 11 }}>
        <Stat label="Stops (7d)"          value={String(stops.length)} />
        <Stat label="Matched to customer" value={String(matched)} />
        <Stat label="Unmatched"           value={String(unmatched)} />
        <Stat label="Geocoded customers"  value={stats ? String(stats.ok) : '—'} />
        <Stat label="Geocode failures"    value={stats ? String(stats.not_found) : '—'} />
      </div>
      {loading ? <div style={{ color: 'var(--mt)' }}>loading…</div> :
       err     ? <div style={{ color: '#c44' }}>{err}</div> :
       stops.length === 0 ? (
         <div style={{ color: 'var(--mt)' }}>
           No stops in the last 7 days yet. The trip cron runs nightly at 02:00 PT — first batch lands tomorrow morning.
         </div>
       ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ color: 'var(--mt)', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>
              <th style={th}>Date</th>
              <th style={th}>Vehicle</th>
              <th style={th}>Driver</th>
              <th style={th}>Customer</th>
              <th style={th}>Arrival</th>
              <th style={th}>Departure</th>
              <th style={thR}>Dwell</th>
              <th style={thR}>Δ from customer</th>
            </tr>
          </thead>
          <tbody>
            {stops.map((s) => {
              const v = vehicleById.get(s.fc_asset_id);
              const d = s.fc_driver_id ? driverById.get(s.fc_driver_id) : null;
              const customerName = s.qbo_customer_id ? custNames.get(s.qbo_customer_id) ?? '(unnamed)' : '(unmatched)';
              const dwellMin = s.dwell_minutes != null ? Math.round(Number(s.dwell_minutes)) : 0;
              const dwellLabel = dwellMin >= 60
                ? Math.floor(dwellMin / 60) + 'h' + (dwellMin % 60 > 0 ? ' ' + (dwellMin % 60) + 'm' : '')
                : dwellMin + 'm';
              const dist = s.distance_m != null ? Math.round(Number(s.distance_m)) : null;
              return (
                <tr key={s.id} style={{ borderTop: '1px solid var(--bd)' }}>
                  <td style={td}>{s.arrival_time.slice(0, 10)}</td>
                  <td style={td}>{v ? vehicleLabel(v) : s.fc_asset_id.slice(0, 8) + '…'}</td>
                  <td style={td}>{d ? [d.first_name, d.last_name].filter(Boolean).join(' ') : '—'}</td>
                  <td style={{
                    ...td,
                    color: s.qbo_customer_id ? 'var(--tx)' : 'var(--mt)',
                    fontWeight: s.qbo_customer_id ? 500 : 400,
                  }}>{customerName}</td>
                  <td style={td}>{shortTime(s.arrival_time)}</td>
                  <td style={td}>{s.departure_time ? shortTime(s.departure_time) : '—'}</td>
                  <td style={tdR}>{dwellLabel}</td>
                  <td style={tdR}>{dist != null ? dist + ' m' : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

### `src/pages/OperationsPage.tsx`

```tsx
import { useEffect, useMemo, useState } from 'react';
import { KPICard } from '../components/KPICard';
import { AreaChart } from '../components/charts/AreaChart';
import { BarChart } from '../components/charts/BarChart';
import { CHART_COLORS } from '../components/charts/util';
import { fm, fp, fmtNum } from '../lib/formatters';
import { btnSecondary, inp } from '../lib/styles';
import { downloadCsv, toCsv } from '../lib/csv';
import {
  Department,
  KpiDailyRow,
  MemberRollup,
  FuelCostMonthlyRow,
  aggregateByDay,
  fetchKpiDaily,
  fetchFuelCostMonthly,
  rollupByMember,
} from '../lib/kpi';

// One page for delivery / service / reman, parameterized by sub-tab.
// Reads ops.kpi_daily directly; the rollup function (fn_compute_kpi_daily)
// runs nightly at 11:00 UTC.

const TABS: { id: Department; label: string }[] = [
  { id: 'delivery', label: 'Delivery' },
  { id: 'service',  label: 'Service' },
  { id: 'reman',    label: 'Reman' },
];

const DEFAULT_WINDOW_DAYS = 30;

export function OperationsPage() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const defaultStart = new Date(today.getTime() - DEFAULT_WINDOW_DAYS * 86400000)
    .toISOString().slice(0, 10);

  const [tab, setTab] = useState<Department>('delivery');
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(todayStr);
  const [rows, setRows] = useState<KpiDailyRow[] | null>(null);
  const [fuelRows, setFuelRows] = useState<FuelCostMonthlyRow[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr('');
    fetchKpiDaily({ department: tab, start, end })
      .then((rs) => { if (!cancelled) setRows(rs); })
      .catch((e) => { if (!cancelled) setErr((e as Error).message); });
    return () => { cancelled = true; };
  }, [tab, start, end]);

  // Fuel cost is a fleet-wide concept; load it once and only show it on the
  // delivery tab where stops-per-month is the natural denominator.
  useEffect(() => {
    if (tab !== 'delivery') return;
    let cancelled = false;
    fetchFuelCostMonthly(6)
      .then((rs) => { if (!cancelled) setFuelRows(rs); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [tab]);

  // GPS-confirmed totals across the visible rows (where set).
  const gpsAgg = useMemo(() => {
    if (!rows) return null;
    let stops = 0, dwell = 0, days = 0, matchSum = 0, matchDays = 0;
    for (const r of rows) {
      if (r.gps_stops_confirmed != null) {
        stops += Number(r.gps_stops_confirmed);
        dwell += Number(r.gps_dwell_min_total ?? 0);
        days += 1;
      }
      if (r.gps_match_pct != null) {
        matchSum += Number(r.gps_match_pct);
        matchDays += 1;
      }
    }
    return { stops, dwell, hasData: days > 0, avgMatchPct: matchDays > 0 ? matchSum / matchDays : null };
  }, [rows]);

  // Latest month's fuel cost per stop — show on the delivery KPI strip.
  const latestFuel = fuelRows?.find((r) => r.fuel_per_stop_sf != null) ?? null;

  const daily = useMemo(() => (rows ? aggregateByDay(rows, tab) : []), [rows, tab]);
  const members = useMemo(() => (rows ? rollupByMember(rows, tab) : []), [rows, tab]);

  const totals = useMemo(() => {
    const activity = daily.reduce((s, d) => s + d.activity, 0);
    const revenue = daily.reduce((s, d) => s + d.revenue, 0);
    const cost = daily.reduce((s, d) => s + d.cost, 0);
    const margin = revenue - cost;
    const days = daily.length || 1;
    return {
      activity,
      revenue,
      cost,
      margin,
      marginPct: revenue > 0 ? margin / revenue : null,
      perDay: activity / days,
      perActivity: activity > 0 ? revenue / activity : null,
      costPerActivity: activity > 0 ? cost / activity : null,
    };
  }, [daily]);

  // Service-only weighted aggregates across the window.
  const serviceAgg = useMemo(() => {
    if (tab !== 'service' || !rows) return null;
    let billable = 0, total = 0, ffWeight = 0, ffSum = 0, respDays = 0, respSum = 0;
    for (const r of rows) {
      if (r.billable_hours != null) billable += Number(r.billable_hours);
      if (r.total_hours != null) total += Number(r.total_hours);
      if (r.first_fix_pct != null && r.jobs_completed && r.jobs_completed > 0) {
        ffSum += Number(r.first_fix_pct) * r.jobs_completed;
        ffWeight += r.jobs_completed;
      }
      if (r.avg_response_min != null) {
        respSum += Number(r.avg_response_min);
        respDays += 1;
      }
    }
    return {
      utilizationPct: total > 0 ? (billable / total) * 100 : null,
      firstFixPct: ffWeight > 0 ? ffSum / ffWeight : null,
      avgResponseMin: respDays > 0 ? respSum / respDays : null,
    };
  }, [tab, rows]);

  const remanAgg = useMemo(() => {
    if (tab !== 'reman' || !rows) return null;
    const turnaround = rows
      .filter((r) => r.turnaround_days != null)
      .map((r) => Number(r.turnaround_days));
    return {
      avgTurnaround: turnaround.length > 0
        ? turnaround.reduce((s, v) => s + v, 0) / turnaround.length
        : null,
    };
  }, [tab, rows]);

  function exportCsv() {
    if (!members.length) return;
    const head = headerForTab(tab);
    const data = members.map((m) => rowForTab(tab, m));
    downloadCsv(`operations_${tab}_${start}_${end}.csv`, toCsv([head, ...data]));
  }

  const activityLabel = tab === 'delivery' ? 'STOPS' : tab === 'service' ? 'JOBS' : 'UNITS';
  const perActivityLabel = tab === 'delivery' ? 'rev/stop' : tab === 'service' ? 'rev/job' : 'rev/unit';

  return (
    <div>
      <div className="pt">
        Operations <span className="bg bg-l">{TABS.find((t) => t.id === tab)?.label.toUpperCase()}</span>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                background: on ? 'var(--ac)' : 'var(--sf2)',
                color: on ? 'var(--bg)' : 'var(--tx)',
                border: '1px solid var(--bd)',
                padding: '6px 12px',
                borderRadius: 4,
                fontSize: 11,
                cursor: 'pointer',
                fontWeight: on ? 700 : 500,
                letterSpacing: 0.5,
              }}
            >
              {t.label.toUpperCase()}
            </button>
          );
        })}
      </div>

      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 10,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 11,
        }}
      >
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>From</span>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} style={inp()} />
        <span style={{ color: 'var(--mt)' }}>to</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} style={inp()} />

        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={exportCsv} disabled={!members.length} style={btnSecondary()}>EXPORT CSV</button>
        </span>
      </div>

      {err ? (
        <div className="cd" style={{ padding: 14, color: 'var(--rd)' }}>Error: {err}</div>
      ) : !rows ? (
        <div className="ld">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="cd" style={{ padding: 14, color: 'var(--mt)' }}>
          No kpi_daily rows in this window. Either nobody in this department has been active, or the
          rollup hasn't backfilled this date range yet.
        </div>
      ) : (
        <>
          <div className="gr g4" style={{ marginBottom: 12 }}>
            <KPICard title={activityLabel} value={fmtNum(totals.activity)} sub={totals.perDay.toFixed(1) + ' / day'} />
            <KPICard title="REVENUE" value={fm(totals.revenue)} sub={totals.perActivity != null ? fm(totals.perActivity) + ' ' + perActivityLabel : '—'} />
            <KPICard
              title="MARGIN"
              value={fm(totals.margin)}
              sub={fp(totals.marginPct)}
              accent={totals.marginPct == null ? undefined : totals.marginPct >= 0.3 ? 'var(--gn)' : totals.marginPct >= 0 ? 'var(--am)' : 'var(--rd)'}
            />
            {tab === 'delivery' && (
              <KPICard
                title="COST / STOP"
                value={totals.costPerActivity != null ? fm(totals.costPerActivity) : '—'}
                sub={fm(totals.cost) + ' total cost'}
              />
            )}
            {tab === 'delivery' && gpsAgg?.hasData && (
              <KPICard
                title="GPS-CONFIRMED"
                value={fmtNum(gpsAgg.stops)}
                sub={
                  totals.activity > 0
                    ? Math.round(100 * gpsAgg.stops / totals.activity) + '% vs SF'
                    : '—'
                }
                accent={
                  totals.activity === 0 ? undefined :
                  gpsAgg.stops / totals.activity >= 0.85 ? 'var(--gn)' :
                  gpsAgg.stops / totals.activity >= 0.6  ? 'var(--am)' : 'var(--rd)'
                }
              />
            )}
            {tab === 'delivery' && latestFuel && (
              <KPICard
                title="FUEL / STOP"
                value={'$' + Number(latestFuel.fuel_per_stop_sf).toFixed(2)}
                sub={latestFuel.month.slice(0, 7) + ' · ' + fm(Number(latestFuel.fuel_expense)) + ' total'}
              />
            )}
            {tab === 'service' && (
              <KPICard
                title="UTILIZATION"
                value={serviceAgg?.utilizationPct != null ? serviceAgg.utilizationPct.toFixed(1) + '%' : '—'}
                sub={serviceAgg?.firstFixPct != null ? serviceAgg.firstFixPct.toFixed(0) + '% first-fix' : '—'}
                accent={serviceAgg?.utilizationPct == null ? undefined : serviceAgg.utilizationPct >= 70 ? 'var(--gn)' : serviceAgg.utilizationPct >= 50 ? 'var(--am)' : 'var(--rd)'}
              />
            )}
            {tab === 'reman' && (
              <KPICard
                title="TURNAROUND"
                value={remanAgg?.avgTurnaround != null ? remanAgg.avgTurnaround.toFixed(1) + ' d' : '—'}
                sub={fm(totals.cost) + ' total cost'}
              />
            )}
          </div>

          <div className="cd" style={{ padding: 8, marginBottom: 12 }}>
            <AreaChart
              labels={daily.map((d) => d.kpi_date.slice(5))}
              series={[
                { name: activityLabel.toLowerCase(), color: CHART_COLORS[0], values: daily.map((d) => d.activity) },
              ]}
              ariaLabel={`${tab} ${activityLabel.toLowerCase()} per day`}
              formatValue={(v) => fmtNum(v)}
            />
          </div>

          <div className="cd" style={{ padding: 8, marginBottom: 12 }}>
            <BarChart
              data={members.slice(0, 12).map((m) => ({
                label: m.member_name,
                value: m.activity,
              }))}
              ariaLabel={`${tab} activity by member`}
              formatValue={(v) => fmtNum(v)}
            />
          </div>

          <div className="cd" style={{ padding: 0 }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
              <div className="ct" style={{ margin: 0 }}>BY MEMBER — {members.length}</div>
            </div>
            <div style={{ maxHeight: '50vh', overflow: 'auto' }}>
              <table>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                  <tr>{headerForTab(tab).map((h, i) => (
                    <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.team_member_id}>
                      {rowForTab(tab, m).map((cell, i) => (
                        <td
                          key={i}
                          className={i === 0 ? '' : 'mn'}
                          style={{
                            textAlign: i === 0 ? 'left' : 'right',
                            fontWeight: i === 0 ? 600 : undefined,
                          }}
                        >
                          {cell as string | number}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function headerForTab(dept: Department): string[] {
  if (dept === 'delivery') {
    return ['Driver', 'Days Active', 'Stops', 'Revenue', 'Cost', 'Margin', 'Margin %', 'Rev/Stop', 'Cost/Stop'];
  }
  if (dept === 'service') {
    return ['Tech', 'Days Active', 'Jobs', 'Revenue', 'Cost', 'Margin', 'Margin %', 'Util %', 'First-Fix %', 'Avg Resp (min)'];
  }
  return ['Tech', 'Days Active', 'Units', 'Revenue', 'Cost', 'Margin', 'Margin %', 'Turnaround (d)'];
}

function rowForTab(dept: Department, m: MemberRollup): (string | number)[] {
  const common = [
    m.member_name,
    m.days_active,
    fmtNum(m.activity),
    fm(m.revenue),
    fm(m.cost),
    fm(m.margin),
    fp(m.margin_pct),
  ];
  if (dept === 'delivery') {
    return [
      ...common,
      m.activity > 0 ? fm(m.revenue / m.activity) : '—',
      m.activity > 0 ? fm(m.cost / m.activity) : '—',
    ];
  }
  if (dept === 'service') {
    return [
      ...common,
      m.utilization_pct != null ? m.utilization_pct.toFixed(1) + '%' : '—',
      m.first_fix_pct != null ? m.first_fix_pct.toFixed(0) + '%' : '—',
      m.avg_response_min != null ? m.avg_response_min.toFixed(0) : '—',
    ];
  }
  return [
    ...common,
    m.turnaround_days != null ? m.turnaround_days.toFixed(1) : '—',
  ];
}
```

### `src/pages/settings/FleetDriversEditor.tsx`

```tsx
import { useEffect, useMemo, useState } from 'react';
import { sbq, sbUpdate } from '../../lib/rpc';

// Settings → Fleet Drivers
// ------------------------
// Manual mapping from Unity FleetComplete drivers (synced into
// ops.fleet_drivers) to the APBG operational roster (ops.team_members).
//
// The link lives on team_members.fleet_driver_id (which is what the
// nightly fn_compute_kpi_daily uses to key GPS counts onto team-member
// rows). The dropdown on each row lets Sky pick the matching team_member
// for a fleet_driver; PostgREST writes team_members.fleet_driver_id
// directly via the column-level UPDATE grant added in 20260509h.

interface FleetDriverRow {
  fc_person_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  employee_id: string | null;
}

interface TeamMemberRow {
  id: number;
  name: string | null;
  department: string | null;
  active: boolean | null;
  fleet_driver_id: string | null;
}

export function FleetDriversEditor() {
  const [drivers, setDrivers] = useState<FleetDriverRow[]>([]);
  const [members, setMembers] = useState<TeamMemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    Promise.all([
      sbq<FleetDriverRow>(
        'fleet_drivers',
        'select=fc_person_id,first_name,last_name,email,employee_id&order=last_name.asc.nullslast,first_name.asc',
      ),
      sbq<TeamMemberRow>(
        'team_members',
        'select=id,name,department,active,fleet_driver_id&order=name.asc',
      ),
    ])
      .then(([d, m]) => { if (!stopped) { setDrivers(d); setMembers(m); setLoading(false); } })
      .catch((e) => { if (!stopped) { setErr(String(e)); setLoading(false); } });
    return () => { stopped = true; };
  }, []);

  // For each fleet_driver, the linked team_member (if any) is the row whose
  // fleet_driver_id equals fc_person_id.
  const linkByFcId = useMemo(() => {
    const m = new Map<string, TeamMemberRow>();
    for (const tm of members) if (tm.fleet_driver_id) m.set(tm.fleet_driver_id, tm);
    return m;
  }, [members]);

  // Sort options: active first, by department, then name.
  const memberOptions = useMemo(() => {
    return [...members].sort((a, b) => {
      const aa = (a.active ? '0' : '1') + ':' + (a.department ?? 'zz') + ':' + (a.name ?? '');
      const bb = (b.active ? '0' : '1') + ':' + (b.department ?? 'zz') + ':' + (b.name ?? '');
      return aa.localeCompare(bb);
    });
  }, [members]);

  async function setLink(fc_person_id: string, newMemberId: number | null) {
    setSaving(fc_person_id);
    setErr(null);
    try {
      // Two writes (sequential is fine — small table):
      // 1. Clear any existing team_member that points to this fc_person_id
      //    (if it's not the new target).
      // 2. Set the new team_member's fleet_driver_id = fc_person_id.
      const prior = linkByFcId.get(fc_person_id);
      if (prior && prior.id !== newMemberId) {
        await sbUpdate<TeamMemberRow>(
          'team_members',
          'id=eq.' + prior.id,
          { fleet_driver_id: null } as Partial<TeamMemberRow>,
        );
      }
      if (newMemberId !== null) {
        await sbUpdate<TeamMemberRow>(
          'team_members',
          'id=eq.' + newMemberId,
          { fleet_driver_id: fc_person_id } as Partial<TeamMemberRow>,
        );
      }
      // Optimistic update: refetch the team_members list so future renders
      // reflect the new state.
      const fresh = await sbq<TeamMemberRow>(
        'team_members',
        'select=id,name,department,active,fleet_driver_id&order=name.asc',
      );
      setMembers(fresh);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(null);
    }
  }

  const linked = drivers.filter((d) => linkByFcId.has(d.fc_person_id)).length;

  return (
    <div>
      <div style={{ marginBottom: 10, fontSize: 12 }}>
        <strong>FLEET DRIVERS</strong>{' '}
        <span style={{ color: 'var(--mt)' }}>
          Map FleetComplete drivers to your APBG team-member roster. The link lives on{' '}
          <code>team_members.fleet_driver_id</code> and powers GPS-confirmed stop counts in <code>kpi_daily</code> and dwell-mismatch flags in the Reconcile tab.
        </span>
      </div>
      {loading ? (
        <div style={{ color: 'var(--mt)' }}>loading…</div>
      ) : err ? (
        <div style={{ color: '#c44' }}>{err}</div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 8 }}>
            {linked} of {drivers.length} mapped
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--mt)', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>
                <th style={th}>FC driver</th>
                <th style={th}>Email</th>
                <th style={th}>Employee ID</th>
                <th style={th}>→ Team member</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => {
                const fcName = [d.first_name, d.last_name].filter(Boolean).join(' ') || d.fc_person_id.slice(0, 8) + '…';
                const isSaving = saving === d.fc_person_id;
                const current = linkByFcId.get(d.fc_person_id);
                return (
                  <tr key={d.fc_person_id} style={{ borderTop: '1px solid var(--bd)' }}>
                    <td style={td}>{fcName}</td>
                    <td style={td}>{d.email ?? '—'}</td>
                    <td style={td}>{d.employee_id ?? '—'}</td>
                    <td style={td}>
                      <select
                        value={current?.id ?? ''}
                        onChange={(e) => setLink(d.fc_person_id, e.target.value ? Number(e.target.value) : null)}
                        disabled={isSaving}
                        style={{
                          background: 'var(--sf2)',
                          color: 'var(--tx)',
                          border: '1px solid var(--bd)',
                          borderRadius: 3,
                          padding: '3px 6px',
                          fontSize: 11,
                          minWidth: 280,
                        }}
                      >
                        <option value="">— unmapped —</option>
                        {memberOptions.map((tm) => (
                          <option key={tm.id} value={tm.id}>
                            {tm.name}
                            {tm.department ? ' · ' + tm.department : ''}
                            {tm.active === false ? ' (inactive)' : ''}
                          </option>
                        ))}
                      </select>
                      {isSaving && <span style={{ marginLeft: 8, color: 'var(--mt)', fontSize: 10 }}>saving…</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const th = { padding: '6px 10px', fontWeight: 600 } as const;
const td = { padding: '6px 10px' } as const;
```


## Section 5 — Routing & nav wiring

The pages above are presentational components. The operations repo needs to:

### 5.1 Routes

Add routes (or hash entries) for:
- `/fleet`     → `<FleetPage />`
- `/operations` → `<OperationsPage />`
- `/settings`   → existing settings shell + new `Fleet Drivers` tab

If operations uses **Next.js App Router**, drop FleetPage/OperationsPage into `app/fleet/page.tsx` and `app/operations/page.tsx` with `'use client'` directives at the top.

If operations uses **React Router**, add:
```tsx
<Route path="/fleet" element={<FleetPage />} />
<Route path="/operations" element={<OperationsPage />} />
```

If operations uses **hash routing like apbg-billing**, add `'fleet'` and `'operations'` to the union type and switch in App.tsx.

### 5.2 Nav

Add two top-level nav items: `FLEET` and `OPERATIONS`. The Fleet pin, Operations dashboard, and the existing Settings page (with the new Fleet Drivers tab) are all that move.

### 5.3 Settings → Fleet Drivers tab

If operations already has a Settings page with tabs, add a `fleet_drivers` tab id and render `<FleetDriversEditor />`. If not, create a minimal Settings page with just this one tab.

### 5.4 Supabase config

`src/lib/supabase.ts` hardcodes the project URL + anon key. **They are the same project** as apbg-billing, so the same values work. If operations already has its own `lib/supabase.ts`, do **not** overwrite — just import the same `sbAuth` / `_sbToken` / `SB_KEY` / `SB_URL` symbols.

### 5.5 PostgREST schema header

All ops queries use the `ops` schema (not `public`). The `sbq` / `sbrpc` helpers in `src/lib/rpc.ts` send `Accept-Profile: ops` and `Content-Profile: ops` headers. If operations has its own equivalent, route the new fleet/kpi queries through whichever helper sends those headers.

### 5.6 Leaflet (FleetPage map)

FleetPage loads Leaflet CSS+JS from CDN at first render via a dynamic `<script>` injection. No npm dep needed; works on any stack.

### 5.7 Cleanup back in apbg-billing

After the operations side ships and is verified, ping back to apbg-billing for the cleanup PR. That removes:
- `app/src/pages/FleetPage.tsx`
- `app/src/pages/OperationsPage.tsx`
- `app/src/pages/settings/FleetDriversEditor.tsx`
- `app/src/lib/fleet.ts`
- The `FLEET` + `OPERATIONS` nav entries in `Layout.tsx`
- The `fleet_drivers` Settings tab
- The `kpi.ts` GPS columns + fuel cost helper (or keep — they're harmless if unused)

The shared lib + components stay (Margin uses them).

