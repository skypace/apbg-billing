import type { SalesPivotRow } from '../lib/sales';
import { fm } from '../lib/formatters';

export type ChartKind = 'none' | 'bar' | 'pie' | 'line';

interface Props {
  kind: ChartKind;
  rows: SalesPivotRow[];
  height?: number;
}

const PALETTE = [
  '#22d3ee', '#34d399', '#fbbf24', '#dc2626', '#a78bfa',
  '#f472b6', '#60a5fa', '#fb923c', '#4ade80', '#f87171',
];

export function PivotChart({ kind, rows, height = 240 }: Props) {
  if (kind === 'none' || rows.length === 0) return null;

  const top = rows.slice().sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 12);
  const max = Math.max(...top.map((r) => Number(r.revenue || 0)), 1);

  if (kind === 'bar') {
    const w = 800;
    const padL = 160;
    const padR = 80;
    const padTB = 14;
    const rowH = (height - padTB * 2) / top.length;
    return (
      <svg width="100%" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="xMidYMid meet">
        {top.map((r, i) => {
          const y = padTB + i * rowH;
          const barW = ((w - padL - padR) * Number(r.revenue || 0)) / max;
          return (
            <g key={r.dim_label}>
              <text x={padL - 8} y={y + rowH / 2 + 3} fontSize="10" fill="#94a3b8" textAnchor="end" style={{ font: '10px system-ui' }}>
                {r.dim_label.length > 24 ? r.dim_label.slice(0, 22) + '…' : r.dim_label}
              </text>
              <rect x={padL} y={y + 2} width={Math.max(barW, 1)} height={rowH - 6} fill={PALETTE[i % PALETTE.length]} opacity={0.85} />
              <text x={padL + barW + 4} y={y + rowH / 2 + 3} fontSize="10" fill="#cbd5e1" style={{ font: '10px system-ui' }}>
                {fm(r.revenue)}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  if (kind === 'pie') {
    const total = top.reduce((s, r) => s + Number(r.revenue || 0), 0) || 1;
    const cx = 130, cy = height / 2, R = Math.min(cy - 10, 100);
    let acc = 0;
    return (
      <svg width="100%" viewBox={`0 0 800 ${height}`} preserveAspectRatio="xMidYMid meet">
        {top.map((r, i) => {
          const v = Number(r.revenue || 0);
          const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
          acc += v;
          const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0);
          const x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
          const path = `M ${cx} ${cy} L ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} Z`;
          return <path key={r.dim_label} d={path} fill={PALETTE[i % PALETTE.length]} opacity={0.9} stroke="#0a0e17" strokeWidth={1} />;
        })}
        {top.map((r, i) => {
          const v = Number(r.revenue || 0);
          const pct = (v / total) * 100;
          return (
            <g key={'lg' + r.dim_label}>
              <rect x={280} y={20 + i * 17} width={10} height={10} fill={PALETTE[i % PALETTE.length]} />
              <text x={296} y={30 + i * 17} fontSize="10" fill="#cbd5e1" style={{ font: '10px system-ui' }}>
                {(r.dim_label.length > 28 ? r.dim_label.slice(0, 26) + '…' : r.dim_label) + '  —  ' + fm(v) + '  (' + pct.toFixed(1) + '%)'}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  // line
  const w = 800, padL = 36, padR = 12, padT = 14, padB = 24;
  const innerW = w - padL - padR, innerH = height - padT - padB;
  const stepX = innerW / Math.max(top.length - 1, 1);
  const points = top.map((r, i) => {
    const x = padL + i * stepX;
    const y = padT + innerH - (Number(r.revenue || 0) / max) * innerH;
    return [x, y] as const;
  });
  const path = points.map(([x, y], i) => (i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`)).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="xMidYMid meet">
      <path d={path} stroke="#22d3ee" strokeWidth={2} fill="none" />
      {points.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={3} fill="#22d3ee" />)}
      {top.map((r, i) => {
        const x = padL + i * stepX;
        return (
          <text key={r.dim_label} x={x} y={height - 6} fontSize="9" fill="#64748b" textAnchor="middle" style={{ font: '9px system-ui' }}>
            {r.dim_label.length > 12 ? r.dim_label.slice(0, 10) + '…' : r.dim_label}
          </text>
        );
      })}
    </svg>
  );
}
