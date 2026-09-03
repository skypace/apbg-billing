// Open · Pending · Closed · Voided pill row with counts — the one vocabulary
// on every production list (work orders, purchase orders, transfers).
import type { ReactNode } from 'react';
import { BUCKETS, BUCKET_HINT, type Bucket, type DocKind } from '../lib/lifecycleBuckets';

export function StatusBuckets({ kind, value, counts, onChange, children }: {
  kind: DocKind;
  value: Bucket;
  counts: Record<Bucket, number>;
  onChange: (b: Bucket) => void;
  /** Extra controls shown to the right of the pills (a stage select, say). */
  children?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div className="seg" role="tablist" aria-label="Status">
        {BUCKETS.map((b) => (
          <button key={b.id} type="button" role="tab" aria-selected={value === b.id}
            className={'seg-btn' + (value === b.id ? ' seg-btn--active' : '')}
            onClick={() => onChange(b.id)} title={BUCKET_HINT[kind][b.id]}>
            {b.label}
            <span style={{ marginLeft: 6, opacity: 0.75, fontFamily: 'var(--ff-mono)', fontWeight: 500 }}>{counts[b.id]}</span>
          </button>
        ))}
      </div>
      {children}
      <span style={{ fontSize: 10.5, color: 'var(--mt)' }}>{BUCKET_HINT[kind][value]}</span>
    </div>
  );
}
