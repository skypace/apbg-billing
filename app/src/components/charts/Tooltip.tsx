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
