// The bar that appears under a grid once rows are ticked. Actions are passed
// in as children so each list decides what it offers; the bar owns the count
// and the clear.
import type { ReactNode } from 'react';

export function BulkActionBar({ count, noun, onClear, children }: {
  count: number; noun: string; onClear: () => void; children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="cd" style={{
      padding: '10px 12px', marginTop: 10, display: 'flex',
      gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 11,
      border: '1px solid var(--ac)',
    }}>
      <span style={{ color: 'var(--mt)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', fontWeight: 600 }}>
        {count} {noun}{count === 1 ? '' : 's'} selected
      </span>
      {children}
      <div style={{ flex: 1 }} />
      <button type="button" className="tb-btn" onClick={onClear}>Clear selection</button>
    </div>
  );
}
