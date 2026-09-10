import type { CSSProperties, ReactNode } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';

/**
 * The shared chrome for the customer-master cards on the customer page —
 * Billing, Locations, Contacts, Documents. One copy of the label style, the
 * control style, the button, the note and the fold-away shell, so four cards
 * that sit one above the other cannot drift into four slightly different
 * looks (the 2026-09-09 screenshot found "four sections stacked with no rules
 * between them read as one grey block" — the rule lives here now).
 */

export const lbl: CSSProperties = {
  fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1,
};
export const ctl: CSSProperties = {
  fontSize: 12, padding: '5px 7px', background: 'var(--ctl-bg)', color: 'var(--tx)',
  border: '1px solid var(--ctl-bd)', borderRadius: 4, minWidth: 0, maxWidth: '100%',
  boxSizing: 'border-box',
};
export const btn = (kind: 'primary' | 'ghost' | 'danger' = 'ghost'): CSSProperties => ({
  fontSize: 11, padding: '5px 10px', borderRadius: 4, cursor: 'pointer',
  border: '1px solid ' + (kind === 'danger' ? 'var(--rd)' : 'var(--ctl-bd)'),
  background: kind === 'primary' ? 'var(--ac)' : 'transparent',
  color: kind === 'primary' ? '#fff' : kind === 'danger' ? 'var(--rd)' : 'var(--tx2)',
});
/** A small inline tag — PRIMARY, BILL-TO, "in QuickBooks", EXPIRED. */
export const chip = (tone: 'plain' | 'amber' | 'red' | 'green' | 'accent' = 'plain'): CSSProperties => ({
  fontSize: 9, letterSpacing: 0.6, textTransform: 'uppercase', padding: '1px 6px',
  borderRadius: 3, whiteSpace: 'nowrap',
  border: '1px solid ' + (tone === 'plain' ? 'var(--bd)' : tone === 'amber' ? 'var(--am)'
    : tone === 'red' ? 'var(--rd)' : tone === 'green' ? 'var(--gn)' : 'var(--ac)'),
  color: tone === 'plain' ? 'var(--mt)' : tone === 'amber' ? 'var(--am)'
    : tone === 'red' ? 'var(--rd)' : tone === 'green' ? 'var(--gn)' : 'var(--ac)',
});

export function Note({ tone, children }: { tone: 'amber' | 'red' | 'plain'; children: ReactNode }) {
  const c = tone === 'red' ? 'var(--rd)' : tone === 'amber' ? 'var(--am)' : 'var(--mt)';
  return (
    <div style={{
      display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px',
      borderRadius: 4, marginTop: 8, fontSize: 11, color: 'var(--tx2)',
      border: '1px solid ' + (tone === 'plain' ? 'var(--bd)' : c),
      background: tone === 'plain' ? 'transparent'
        : tone === 'red' ? 'rgba(234,67,53,0.07)' : 'rgba(244,180,0,0.08)',
    }}>
      {tone !== 'plain' && <AlertTriangle size={14} strokeWidth={2.3} color={c} aria-hidden="true" />}
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  );
}

/** A section heading with a rule above it. */
export function Section({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div style={{ marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--bd)' }}>
      <div style={lbl}>{children}</div>
      {hint && <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

/** The "saved here, but…" panel every writer's push_notes render through. */
export function PushNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <Note tone="amber">
      <div style={{ fontWeight: 600, color: 'var(--am)' }}>
        Saved here, but not everything reached the other systems
      </div>
      <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
        {notes.map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </Note>
  );
}

/**
 * The fold-away shell. Collapsed, it must still answer "what is in here" —
 * that is the `summary` — and the summary is hidden once open, where the
 * real content says the same thing two lines lower.
 */
export function CardShell({ title, open, onToggle, summary, children }: {
  title: string;
  open: boolean;
  onToggle: () => void;
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="cd" style={{ padding: '10px 14px', marginBottom: 14 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center',
          gap: 8, width: '100%', boxSizing: 'border-box',
        }}
        aria-expanded={open}
      >
        {open
          ? <ChevronDown size={14} strokeWidth={2.3} color="var(--mt)" aria-hidden="true" />
          : <ChevronRight size={14} strokeWidth={2.3} color="var(--mt)" aria-hidden="true" />}
        <span style={{ ...lbl, color: 'var(--tx2)' }}>{title}</span>
        {!open && (
          <span style={{ fontSize: 10, color: 'var(--mt)', marginLeft: 'auto' }}>{summary}</span>
        )}
      </button>
      {open ? <div style={{ marginTop: 12 }}>{children}</div> : null}
    </div>
  );
}
