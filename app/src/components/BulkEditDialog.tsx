// Bulk edit: a few whitelisted fields applied to every selected row. A field
// left untouched is NOT sent (so an empty box does not blank a value on ten
// rows); tick "clear" to blank one deliberately.
import { useState } from 'react';
import { inp, btnPrimary, btnSecondary } from '../lib/styles';

export interface BulkEditField { key: string; label: string; type: 'text' | 'date' | 'textarea' }

export function BulkEditDialog({ title, count, fields, busy, onCancel, onConfirm }: {
  title: string; count: number; fields: BulkEditField[]; busy?: boolean;
  onCancel: () => void;
  onConfirm: (patch: Record<string, string | null>) => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<Record<string, boolean>>({});
  const patch: Record<string, string | null> = {};
  for (const f of fields) {
    if (clear[f.key]) patch[f.key] = null;
    else if ((vals[f.key] ?? '').trim() !== '') patch[f.key] = vals[f.key].trim();
  }
  const n = Object.keys(patch).length;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="cd" style={{ width: 'min(520px, 100%)', padding: 16, border: '1px solid var(--ac)' }} role="dialog" aria-modal="true">
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 12 }}>
          Applies to {count} row{count === 1 ? '' : 's'}. Only the fields you fill in (or tick to clear) are changed.
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          {fields.map((f) => (
            <label key={f.key} style={{ display: 'block', fontSize: 10.5, color: 'var(--mt)' }}>
              <span style={{ display: 'flex', justifyContent: 'space-between' }}>
                {f.label}
                <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input type="checkbox" checked={!!clear[f.key]} onChange={(e) => setClear({ ...clear, [f.key]: e.target.checked })} /> clear
                </span>
              </span>
              {f.type === 'textarea'
                ? <textarea rows={2} style={{ ...inp(), marginTop: 4 }} disabled={!!clear[f.key]} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
                : <input type={f.type} style={{ ...inp(), marginTop: 4 }} disabled={!!clear[f.key]} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button type="button" style={btnSecondary()} onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" style={btnPrimary()} disabled={busy || n === 0} onClick={() => onConfirm(patch)}>
            {n === 0 ? 'Nothing to change' : `Apply to ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}
