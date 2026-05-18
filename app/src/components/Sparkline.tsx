interface Props {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}

// 12-month bar sparkline. Values: oldest → newest.
export function Sparkline({ values, width = 80, height = 22, color = 'var(--ac)' }: Props) {
  if (!values.length) return <span style={{ color: 'var(--mt)' }}>—</span>;
  const max = Math.max(...values, 1);
  const bw = width / values.length;
  return (
    <svg width={width} height={height} preserveAspectRatio="none">
      {values.map((v, i) => {
        const h = max ? Math.max(1, (Math.max(0, v) / max) * (height - 2)) : 1;
        return (
          <rect
            key={i}
            x={i * bw + 1}
            y={height - h}
            width={Math.max(1, bw - 1.5)}
            height={h}
            fill={color}
            opacity={0.85}
          />
        );
      })}
    </svg>
  );
}
