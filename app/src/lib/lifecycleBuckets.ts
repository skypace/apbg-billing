// Lifecycle buckets — ONE rule for every production document list.
//
// Mirrors ops.fn_status_bucket (migration 20260903b). v_work_orders and
// v_purchase_orders carry the server's answer as `bucket`; transfers come off
// the bare table, so `rowBucket()` falls back to this copy. Keep the two in
// step: pending = draft · voided = void · closed = closed / consumed (and a
// RECEIVED transfer, which is terminal) · everything else is open — a received
// PO or work order stays OPEN because a click (Close) remains, and that is
// stated on screen rather than assumed.

export type Bucket = 'open' | 'pending' | 'closed' | 'voided';
export type DocKind = 'work_order' | 'purchase_order' | 'transfer' | 'run';

export const BUCKETS: { id: Bucket; label: string }[] = [
  { id: 'open',    label: 'Open' },
  { id: 'pending', label: 'Pending' },
  { id: 'closed',  label: 'Closed' },
  { id: 'voided',  label: 'Voided' },
];

export const BUCKET_HINT: Record<DocKind, Record<Bucket, string>> = {
  work_order: {
    open:    'Ordered through received — a step is still to be taken. A received run stays here until it is closed.',
    pending: 'Drafts: nothing ordered yet. These can be edited freely or deleted.',
    closed:  'Closed runs. Reopen one from its detail if a receipt needs correcting.',
    voided:  'Voided before production started. The reason is on each row.',
  },
  purchase_order: {
    open:    'Open, partly received or fully received but not yet closed.',
    pending: 'Drafts: not yet sent to a vendor. Edit or delete freely.',
    closed:  'Closed — nothing more is expected. Reopen from the detail if a receipt needs correcting.',
    voided:  'Voided. Nothing was received against these.',
  },
  run: {
    open:    'Ordered through received — purchase orders out, production at the co-packer, or the truck on its way. Closes when every work order on it is closed.',
    pending: 'Draft orders: nothing ordered yet. Add or remove flavours freely, or delete.',
    closed:  'Closed runs. Reopen one from its detail if a receipt needs correcting.',
    voided:  'Voided before production started — every work order and purchase order on it went with it. The reason is on each row.',
  },
  transfer: {
    open:    'In transit — shipped, not yet received.',
    pending: 'Drafts: not yet shipped. Edit or delete freely.',
    closed:  'Received — the goods have landed.',
    voided:  'Voided drafts.',
  },
};

/** The rule. Keep identical to ops.fn_status_bucket. */
export function bucketOf(kind: DocKind, status: string): Bucket {
  if (status === 'void') return 'voided';
  if (status === 'draft') return 'pending';
  if (status === 'closed' || status === 'consumed') return 'closed';
  if (kind === 'transfer' && status === 'received') return 'closed';
  return 'open';
}

/** Prefer the server's column when the row carries one. */
export function rowBucket(kind: DocKind, row: { status: string; bucket?: string | null }): Bucket {
  const b = row.bucket;
  if (b === 'open' || b === 'pending' || b === 'closed' || b === 'voided') return b;
  return bucketOf(kind, row.status);
}

export function countBuckets(kind: DocKind, rows: { status: string; bucket?: string | null }[]): Record<Bucket, number> {
  const out: Record<Bucket, number> = { open: 0, pending: 0, closed: 0, voided: 0 };
  for (const r of rows) out[rowBucket(kind, r)]++;
  return out;
}
