import { useMemo } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import type { ComparisonRow, Dim } from '../lib/sales';
import { fm } from '../lib/formatters';

interface Props {
  rows: ComparisonRow[];
  dim: Dim;
  /** Click handler — filters current dim to that label. */
  onSelect?: (label: string) => void;
}

interface Mover {
  label: string;
  current: number;
  prior: number;
  delta: number;
  deltaPct: number | null;
}

function shorten(s: string, n = 22): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function pct(v: number | null): string {
  if (v == null || !isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
}

/** Inline 4-card strip showing the biggest revenue gainer/loser + margin gainer/loser
 *  for the current view. Only renders when comparison data is present. */
export function TopMoversStrip({ rows, dim, onSelect }: Props) {
  const movers = useMemo(() => {
    if (!rows || rows.length === 0) return null;

    // Revenue movers — biggest absolute Δ$ in each direction.
    const revGain: Mover[] = [];
    const revLoss: Mover[] = [];
    // Margin movers — biggest Δ in est_margin (computed as current - prior_margin from ComparisonRow).
    const mgnGain: Mover[] = [];
    const mgnLoss: Mover[] = [];

    for (const r of rows) {
      if (r.delta_revenue == null || r.prior_revenue == null) continue;
      const d = Number(r.delta_revenue);
      const m: Mover = {
        label: r.dim_label,
        current: Number(r.revenue ?? 0),
        prior: Number(r.prior_revenue ?? 0),
        delta: d,
        deltaPct: r.delta_pct != null ? Number(r.delta_pct) : null,
      };
      if (d > 0) revGain.push(m);
      else if (d < 0) revLoss.push(m);

      // Margin movers — compute delta from est_margin vs prior_margin (when both present)
      const curM = r.est_margin != null ? Number(r.est_margin) : null;
      const priM = r.prior_margin != null ? Number(r.prior_margin) : null;
      if (curM != null && priM != null) {
        const md = curM - priM;
        const mp = priM !== 0 ? md / Math.abs(priM) : null;
        const mm: Mover = {
          label: r.dim_label,
          current: curM,
          prior: priM,
          delta: md,
          deltaPct: mp,
        };
        if (md > 0) mgnGain.push(mm);
        else if (md < 0) mgnLoss.push(mm);
      }
    }

    revGain.sort((a, b) => b.delta - a.delta);
    revLoss.sort((a, b) => a.delta - b.delta);
    mgnGain.sort((a, b) => b.delta - a.delta);
    mgnLoss.sort((a, b) => a.delta - b.delta);

    return {
      revGain: revGain[0],
      revLoss: revLoss[0],
      mgnGain: mgnGain[0],
      mgnLoss: mgnLoss[0],
    };
  }, [rows]);

  if (!movers || (!movers.revGain && !movers.revLoss && !movers.mgnGain && !movers.mgnLoss)) {
    return null;
  }

  const dimLabel = dim.charAt(0).toUpperCase() + dim.slice(1);

  return (
    <div className="gr" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', marginBottom: 14, gap: 10 }}>
      <Card mover={movers.revGain} title="TOP REV GAINER"  dim={dimLabel} mode="gain" metric="revenue" onSelect={onSelect} />
      <Card mover={movers.revLoss} title="TOP REV LOSS"    dim={dimLabel} mode="loss" metric="revenue" onSelect={onSelect} />
      <Card mover={movers.mgnGain} title="MARGIN $ GAINER" dim={dimLabel} mode="gain" metric="margin"  onSelect={onSelect} />
      <Card mover={movers.mgnLoss} title="MARGIN $ LOSS"   dim={dimLabel} mode="loss" metric="margin"  onSelect={onSelect} />
    </div>
  );
}

function Card({
  mover,
  title,
  dim,
  mode,
  metric,
  onSelect,
}: {
  mover?: Mover;
  title: string;
  dim: string;
  mode: 'gain' | 'loss';
  metric: 'revenue' | 'margin';
  onSelect?: (label: string) => void;
}) {
  const empty = !mover;
  const Icon = mode === 'gain' ? TrendingUp : TrendingDown;
  const color = mode === 'gain' ? 'var(--gn)' : 'var(--rd)';
  const clickable = !!mover && !!onSelect;

  return (
    <div
      className="cd"
      onClick={clickable ? () => onSelect!(mover!.label) : undefined}
      style={{
        padding: '10px 12px',
        cursor: clickable ? 'pointer' : 'default',
        opacity: empty ? 0.5 : 1,
        borderColor: 'var(--bd)',
        position: 'relative',
        minHeight: 90,
      }}
      title={clickable ? `Click to filter ${dim} to ${mover!.label}` : undefined}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="ct" style={{ margin: 0, color: 'var(--mt)' }}>{title}</div>
        <Icon size={13} strokeWidth={2.4} color={color} aria-hidden="true" />
      </div>
      {empty ? (
        <div style={{ marginTop: 6, color: 'var(--mt)', fontSize: 11 }}>—</div>
      ) : (
        <>
          <div
            style={{
              fontSize: 12, fontWeight: 600, marginTop: 5,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
            title={mover!.label}
          >
            {shorten(mover!.label, 26)}
          </div>
          <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ color, fontWeight: 700, fontSize: 14 }}>
              {(mover!.delta >= 0 ? '+' : '') + fm(mover!.delta)}
            </span>
            <span style={{ color: 'var(--mt)', fontSize: 11 }}>{pct(mover!.deltaPct)}</span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--mt)', marginTop: 4, letterSpacing: 0.4, textTransform: 'uppercase' }}>
            {metric} · {dim}
          </div>
        </>
      )}
    </div>
  );
}
