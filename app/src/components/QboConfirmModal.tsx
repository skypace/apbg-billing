import { useState } from 'react';
import { btnPrimary, btnDanger, btnSecondary, inp } from '../lib/styles';

// Two-pane "now vs after" preview modal for any QBO writeback.
// Used today by the Items master Active toggle; designed so future
// writebacks (Category ParentRef push, name changes, etc.) can reuse it.

export interface QboField {
  label: string;
  before: string;
  after: string;
  warn?: string;          // optional warning shown beneath the row
}

interface Props {
  open: boolean;
  title: string;
  subtitle?: string;
  fields: QboField[];
  confirmLabel: string;
  confirmDanger?: boolean;
  extra?: React.ReactNode; // e.g. an optional checkbox below the table
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}

export function QboConfirmModal({
  open, title, subtitle, fields, confirmLabel, confirmDanger,
  extra, onCancel, onConfirm, busy,
}: Props) {
  if (!open) return null;
  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--sf)', color: 'var(--tx)', border: '1px solid var(--bd)',
        borderRadius: 8, minWidth: 520, maxWidth: 720, padding: 0,
        boxShadow: '0 18px 64px rgba(0,0,0,0.55)',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bd)' }}>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.3 }}>{title}</div>
          {subtitle && (
            <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 4 }}>{subtitle}</div>
          )}
        </div>

        <div style={{ padding: '14px 18px' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '120px 1fr 1fr',
            rowGap: 4, columnGap: 16, fontSize: 11,
          }}>
            <div style={{ color: 'var(--mt)', fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase' }}>Field</div>
            <div style={{ color: 'var(--mt)', fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase' }}>In QBO now</div>
            <div style={{ color: 'var(--mt)', fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase' }}>After you approve</div>
            {fields.map((f, i) => (
              <div key={i} style={{ display: 'contents' }}>
                <div style={{ color: 'var(--tx2)', alignSelf: 'center' }}>{f.label}</div>
                <div style={{
                  fontFamily: 'var(--ff-mono)', padding: '6px 8px',
                  background: 'rgba(255,255,255,0.03)', borderRadius: 4,
                  fontSize: 11, color: 'var(--tx2)',
                }}>{f.before}</div>
                <div style={{
                  fontFamily: 'var(--ff-mono)', padding: '6px 8px',
                  background: 'rgba(91,181,240,0.10)', borderRadius: 4,
                  fontSize: 11, color: 'var(--ac)', fontWeight: 600,
                }}>{f.after}</div>
                {f.warn && (
                  <div style={{
                    gridColumn: '1 / -1', fontSize: 10, color: 'var(--am)',
                    padding: '2px 8px 6px',
                  }}>⚠ {f.warn}</div>
                )}
              </div>
            ))}
          </div>

          {extra && <div style={{ marginTop: 14 }}>{extra}</div>}
        </div>

        <div style={{
          padding: '12px 18px', borderTop: '1px solid var(--bd)',
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <button onClick={onCancel} disabled={busy} style={btnSecondary()}>Cancel</button>
          <button
            onClick={onConfirm}
            disabled={busy}
            style={confirmDanger ? btnDanger() : btnPrimary()}
          >
            {busy ? 'Pushing…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Tiny helper for the "Strip ' (deleted)' suffix" checkbox we offer
// when reactivating an item.
interface StripCheckProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}
export function StripSuffixCheckbox({ checked, onChange, label }: StripCheckProps) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
      color: 'var(--tx2)', cursor: 'pointer', userSelect: 'none',
      padding: '8px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 4,
    }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
