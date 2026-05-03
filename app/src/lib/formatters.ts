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
