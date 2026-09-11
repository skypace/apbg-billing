// Replaces window.prompt() for void / delete. Lists what WILL happen and what
// will be refused (with why) before the button is pressed, takes one reason
// for the lot, and never fires on an ineligible row — the server refuses too,
// this just stops a surprise.
import { useState } from 'react';
import { inp, btnPrimary, btnSecondary, btnDanger } from '../lib/styles';

export interface ReasonItem { id: string; number: string; eligible: boolean; why?: string; detail?: string }

export function ReasonDialog({ title, verb, items, needReason = true, note, busy, onCancel, onConfirm }: {
  title: string;
  /** Button label, e.g. "Void 3 work orders" */
  verb: string;
  items: ReasonItem[];
  needReason?: boolean;
  note?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string, ids: string[]) => void;
}) {
  const [reason, setReason] = useState('');
  const eligible = items.filter((i) => i.eligible);
  const blocked = items.filter((i) => !i.eligible);
  const canGo = eligible.length > 0 && (!needReason || reason.trim().length > 0) && !busy;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="cd" style={{ width: 'min(560px, 100%)', padding: 16, border: '1px solid var(--ac)' }} role="dialog" aria-modal="true">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{title}</div>
        {note && <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 10 }}>{note}</div>}
        {eligible.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
              Will be {verbPast(verb)} · {eligible.length}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {eligible.map((i) => (
                <span key={i.id} title={i.detail} style={{ fontFamily: 'var(--ff-mono)', fontSize: 11, padding: '2px 7px',
                  border: '1px solid var(--bd)', borderRadius: 4 }}>{i.number}</span>
              ))}
            </div>
          </div>
        )}
        {blocked.length > 0 && (
          <div style={{ marginBottom: 10, padding: 8, background: 'rgba(239,191,65,0.08)', border: '1px solid rgba(239,191,65,0.30)', borderRadius: 4 }}>
            <div style={{ fontSize: 10, color: 'var(--am)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
              Will be left alone · {blocked.length}
            </div>
            {blocked.map((i) => (
              <div key={i.id} style={{ fontSize: 11 }}>
                <span style={{ fontFamily: 'var(--ff-mono)' }}>{i.number}</span>
                <span style={{ color: 'var(--mt)' }}> — {i.why ?? 'not eligible'}</span>
              </div>
            ))}
          </div>
        )}
        {needReason && (
          <label style={{ display: 'block', fontSize: 10.5, color: 'var(--mt)', marginBottom: 10 }}>
            Reason (recorded on each row)
            <input autoFocus style={{ ...inp(), marginTop: 4 }} value={reason} onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canGo) onConfirm(reason.trim(), eligible.map((i) => i.id)); }} />
          </label>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" style={btnSecondary()} onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" style={eligible.length ? btnDanger() : btnPrimary()} disabled={!canGo}
            onClick={() => onConfirm(reason.trim(), eligible.map((i) => i.id))}>
            {eligible.length === 0 ? 'Nothing to do' : verb}
          </button>
        </div>
      </div>
    </div>
  );
}

function verbPast(v: string): string {
  const w = v.trim().split(/\s+/)[0].toLowerCase();
  if (w === 'void') return 'voided';
  if (w === 'delete') return 'deleted';
  if (w === 'save' || w === 'apply' || w === 'edit') return 'edited';
  return w + 'ed';
}
