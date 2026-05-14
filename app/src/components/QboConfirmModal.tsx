import { useEffect, useState } from 'react';
import { btnPrimary, btnDanger, btnSecondary, inp } from '../lib/styles';
import { sbAuth } from '../lib/supabase';

// Two-pane "now vs after" preview modal for any QBO writeback.
// Used today by the Items master Active toggle; designed so future
// writebacks (Category ParentRef push, name changes, etc.) can reuse it.
//
// Optionally gated behind a password re-auth (set requirePassword=true).
// Verifies the user's password against Supabase auth using the session
// email — same credentials as the login screen. Confirm stays disabled
// until the password verifies. Same security as logging in fresh.

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
  requirePassword?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}

export function QboConfirmModal({
  open, title, subtitle, fields, confirmLabel, confirmDanger,
  extra, requirePassword, onCancel, onConfirm, busy,
}: Props) {
  const [password, setPassword] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setVerifying(false);
      setVerified(false);
      setPwError(null);
    }
  }, [open]);

  async function verifyPassword() {
    if (!password) { setPwError('Enter your password.'); return; }
    setVerifying(true);
    setPwError(null);
    try {
      const { data: sessionData } = await sbAuth.auth.getSession();
      const email = sessionData.session?.user.email;
      if (!email) throw new Error('No active session. Sign in again.');
      const { error } = await sbAuth.auth.signInWithPassword({ email, password });
      if (error) throw error;
      setVerified(true);
    } catch (e) {
      setVerified(false);
      setPwError(e instanceof Error ? e.message : 'Verification failed.');
    } finally {
      setVerifying(false);
    }
  }

  if (!open) return null;
  const gated = !!requirePassword && !verified;
  return (
    <div onClick={busy ? undefined : onCancel} style={{
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
                  fontSize: 11, color: 'var(--tx2)', whiteSpace: 'pre-wrap',
                }}>{f.before}</div>
                <div style={{
                  fontFamily: 'var(--ff-mono)', padding: '6px 8px',
                  background: 'rgba(91,181,240,0.10)', borderRadius: 4,
                  fontSize: 11, color: 'var(--ac)', fontWeight: 600, whiteSpace: 'pre-wrap',
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

          {requirePassword && (
            <div style={{
              marginTop: 16, padding: '12px 14px',
              background: verified ? 'rgba(40,167,69,0.08)' : 'rgba(255,193,7,0.06)',
              border: '1px solid ' + (verified ? 'var(--gn)' : 'var(--am)'),
              borderRadius: 4,
            }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
                color: verified ? 'var(--gn)' : 'var(--am)', marginBottom: 8,
              }}>
                {verified ? '✓ Identity verified' : 'Admin password required'}
              </div>
              {!verified && (
                <>
                  <div style={{ fontSize: 11, color: 'var(--tx2)', marginBottom: 8 }}>
                    This action pushes changes into QuickBooks. Enter your Supabase admin password to confirm.
                  </div>
                  <form
                    onSubmit={(e) => { e.preventDefault(); if (!verifying) verifyPassword(); }}
                    style={{ display: 'flex', gap: 8 }}
                  >
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); setPwError(null); }}
                      placeholder="Admin password"
                      autoFocus
                      style={{ ...inp(), flex: 1 }}
                      disabled={verifying}
                    />
                    <button
                      type="submit"
                      disabled={verifying || !password}
                      style={btnSecondary()}
                    >
                      {verifying ? 'Verifying…' : 'Verify'}
                    </button>
                  </form>
                  {pwError && (
                    <div style={{ fontSize: 10, color: 'var(--rd)', marginTop: 6 }}>{pwError}</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div style={{
          padding: '12px 18px', borderTop: '1px solid var(--bd)',
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <button onClick={onCancel} disabled={busy} style={btnSecondary()}>No, cancel</button>
          <button
            onClick={onConfirm}
            disabled={busy || gated}
            style={confirmDanger ? btnDanger() : btnPrimary()}
            title={gated ? 'Verify your password first' : undefined}
          >
            {busy ? 'Pushing…' : (gated ? 'Locked — verify password' : 'Yes, ' + confirmLabel)}
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
