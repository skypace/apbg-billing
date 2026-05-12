import type { CSSProperties } from 'react';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  radius?: string | number;
  style?: CSSProperties;
}

export function Skeleton({ width = '100%', height = 16, radius = 4, style }: SkeletonProps) {
  return (
    <div
      className="skeleton"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

export function HeroSkeleton() {
  return (
    <div className="hero">
      <div style={{ flex: 1 }}>
        <Skeleton width={140} height={10} radius={4} />
        <div style={{ marginTop: 10 }}>
          <Skeleton width={260} height={36} radius={8} />
        </div>
        <div style={{ marginTop: 10 }}>
          <Skeleton width={200} height={11} />
        </div>
      </div>
      <Skeleton width={160} height={32} radius={999} />
    </div>
  );
}

export function KpiCardSkeleton() {
  return (
    <div className="kpi-card cd">
      <div className="kpi-head">
        <Skeleton width={70} height={9} />
        <Skeleton width={48} height={16} radius={999} />
      </div>
      <div style={{ marginTop: 8, marginBottom: 6 }}>
        <Skeleton width="60%" height={28} radius={6} />
      </div>
      <Skeleton width="80%" height={9} />
      <div style={{ marginTop: 12 }}>
        <Skeleton width="100%" height={32} radius={4} />
      </div>
    </div>
  );
}

export function KpiRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="gr g4" style={{ marginBottom: 18 }}>
      {Array.from({ length: count }).map((_, i) => <KpiCardSkeleton key={i} />)}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} width={`${100 / cols}%`} height={10} radius={3} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton
              key={c}
              width={`${100 / cols}%`}
              height={c === 0 ? 16 : 13}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 240 }: { height?: number }) {
  // Twelve bars at "natural-looking" heights to evoke the real chart.
  const heights = [62, 80, 50, 90, 72, 100, 65, 85, 55, 78, 95, 70];
  return (
    <div style={{ padding: 14 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          height,
        }}
      >
        {heights.map((h, i) => (
          <Skeleton
            key={i}
            width={`${100 / heights.length}%`}
            height={`${h}%`}
            radius={2}
          />
        ))}
      </div>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div>
      <HeroSkeleton />
      <KpiRowSkeleton />
      <div className="cd" style={{ padding: 0 }}>
        <ChartSkeleton />
      </div>
    </div>
  );
}
