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
  '#1E40AF',
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
