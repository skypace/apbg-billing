interface Props {
  segment: string | null | undefined;
  size?: 'sm' | 'md';
}

const COLOR: Record<string, string> = {
  'Champion': 'var(--gn)',
  'Loyal': '#34d399',
  'New / Potential': 'var(--ac)',
  'At Risk — High Value': 'var(--am)',
  'At Risk': '#fbbf24',
  'Lost / Hibernating': 'var(--rd)',
  'Average': 'var(--mt)',
};

export function SegmentChip({ segment, size = 'sm' }: Props) {
  if (!segment) {
    return <span style={{ color: 'var(--mt)', fontSize: 10 }}>—</span>;
  }
  const color = COLOR[segment] ?? 'var(--mt)';
  return (
    <span
      style={{
        display: 'inline-block',
        background: 'rgba(255,255,255,0.04)',
        color,
        border: '1px solid ' + color,
        padding: size === 'sm' ? '1px 7px' : '2px 10px',
        borderRadius: 12,
        fontSize: size === 'sm' ? 9 : 11,
        fontWeight: 700,
        letterSpacing: 0.5,
        whiteSpace: 'nowrap',
      }}
    >
      {segment.toUpperCase()}
    </span>
  );
}
