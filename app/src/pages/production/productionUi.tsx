// Small presentational pieces shared by the Production tabs — a labelled field,
// a meta cell, a key/value cell, the table cell styles, and the work-order
// stage vocabulary (label + colour), so the Work Orders tab and the Production
// Orders (run) detail print a stage the same way.
import type { CSSProperties, ReactNode } from 'react';
import type { WorkOrderStatus } from '../../lib/production';

export function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const WO_PIPELINE: { status: WorkOrderStatus; label: string; short: string }[] = [
  { status: 'draft',          label: 'Draft',                  short: 'Draft' },
  { status: 'ordered',        label: 'POs issued',             short: 'Ordered' },
  { status: 'at_copacker',    label: 'Materials at co-packer', short: 'At co-packer' },
  { status: 'in_production',  label: 'In production',          short: 'Producing' },
  { status: 'yield_recorded', label: 'Yield recorded',         short: 'Yield' },
  { status: 'in_transit',     label: 'Shipping to us',         short: 'In transit' },
  { status: 'received',       label: 'Received to inventory',  short: 'Received' },
  { status: 'closed',         label: 'Closed',                 short: 'Closed' },
];

export const WO_STATUS_COLOR: Record<string, string> = {
  draft: 'var(--mt)', ordered: 'var(--ac)', at_copacker: 'var(--ac)', in_production: 'var(--am)',
  yield_recorded: 'var(--am)', in_transit: 'var(--ac)', received: 'var(--gn)', closed: 'var(--gn)',
  void: '#64748b', consumed: '#64748b',
};
export const WO_STATUS_LABEL: Record<string, string> = Object.fromEntries(WO_PIPELINE.map((s) => [s.status, s.short]));
WO_STATUS_LABEL.void = 'Void';
WO_STATUS_LABEL.consumed = 'Consumed (legacy)';

export function StageChip({ status, color, label }: { status: string; color?: string; label?: string }) {
  const c = color ?? WO_STATUS_COLOR[status] ?? 'var(--mt)';
  return <span style={{
    background: 'rgba(255,255,255,0.04)', color: c, border: '1px solid ' + c,
    padding: '1px 7px', borderRadius: 12, fontSize: 9, fontWeight: 700, letterSpacing: 0.5, whiteSpace: 'nowrap',
  }}>{(label ?? WO_STATUS_LABEL[status] ?? status).toUpperCase()}</span>;
}

export function Meta({ label, value }: { label: string; value: ReactNode }) {
  return <div>
    <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</div>
    <div style={{ marginTop: 3 }}>{value}</div>
  </div>;
}
export function Kv({ label, value, bold, accent }: { label: string; value: string; bold?: boolean; accent?: boolean }) {
  return <div>
    <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</div>
    <div style={{ marginTop: 3, fontWeight: bold ? 700 : 500, color: accent ? 'var(--ac)' : 'var(--tx)', fontFamily: 'var(--ff-mono)' }}>{value}</div>
  </div>;
}
export function LField({ label, children }: { label: string; children: ReactNode }) {
  return <div>
    <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
    {children}
  </div>;
}

export const cellTh: CSSProperties = { textAlign: 'left', padding: '7px 10px', fontSize: 10, fontWeight: 600,
  letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--mt)' };
export const cellTd: CSSProperties = { padding: '6px 10px', verticalAlign: 'middle' };
export const sectionLabel: CSSProperties = { fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 };
