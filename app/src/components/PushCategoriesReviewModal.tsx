import { useMemo, useState } from 'react';
import { btnSecondary, btnPrimary, inp } from '../lib/styles';
import { Lock, AlertTriangle, FolderPlus } from 'lucide-react';

// Review modal for the Items master → "Push to QBO" action.
// Shows the full diff (categories that will be created in QBO + every
// item that will be reparented) and requires a password before the
// commit fires. Cancellations are logged by the caller via the
// existing qbo_writeback_log RPC.

export interface CategoryChange {
  qbo_item_id: string;
  item_name: string;
  current_parent: string;   // e.g. category_path or '(none)'
  new_parent: string;       // e.g. category_override
}

interface Props {
  open: boolean;
  busy?: boolean;
  // Configured password the user must type. Source-of-truth lives in
  // VITE_QBO_PUSH_PASSWORD (Netlify env). Defaults to a placeholder
  // when unset so the gate still trips in dev.
  expectedPassword: string;
  // Categories that don't exist in QBO yet — will be CREATED on commit.
  categoriesToCreate: string[];
  // Per-item moves that will be applied.
  changes: CategoryChange[];
  alreadyCorrect: number;
  onCancel: () => void;
  onConfirm: () => void;
}

const MAX_PREVIEW_ROWS = 100;

export function PushCategoriesReviewModal({
  open, busy, expectedPassword, categoriesToCreate, changes, alreadyCorrect, onCancel, onConfirm,
}: Props) {
  const [typed, setTyped] = useState('');

  const passwordOk = typed.length > 0 && typed === expectedPassword;
  const visibleChanges = useMemo(() => changes.slice(0, MAX_PREVIEW_ROWS), [changes]);
  const hiddenCount = Math.max(0, changes.length - MAX_PREVIEW_ROWS);

  if (!open) return null;

  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--sf)', color: 'var(--tx)', border: '1px solid var(--bd)',
        borderRadius: 8, minWidth: 720, maxWidth: 920, maxHeight: '88vh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 18px 64px rgba(0,0,0,0.55)',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bd)' }}>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.3 }}>
            Push category changes to QuickBooks
          </div>
          <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 4 }}>
            Creates any missing QBO Category items, then re-parents each affected item.
            No item names, accounts, or active flags are modified.
          </div>
        </div>

        {/* Summary cards */}
        <div style={{ padding: '12px 18px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <SummaryCard
            label="ITEMS TO REPARENT"
            value={changes.length}
            color={changes.length > 0 ? 'var(--ac)' : 'var(--mt)'}
          />
          <SummaryCard
            label="NEW QBO CATEGORIES"
            value={categoriesToCreate.length}
            color={categoriesToCreate.length > 0 ? 'var(--am)' : 'var(--mt)'}
          />
          <SummaryCard
            label="ALREADY CORRECT"
            value={alreadyCorrect}
            color="var(--mt)"
          />
        </div>

        {/* Categories being created */}
        {categoriesToCreate.length > 0 && (
          <div style={{ padding: '0 18px 12px' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase',
              fontWeight: 600, color: 'var(--am)', marginBottom: 6,
            }}>
              <FolderPlus size={12} />
              These QBO Category items will be created:
            </div>
            <div style={{
              maxHeight: 100, overflow: 'auto', padding: '6px 8px',
              background: 'rgba(255,200,80,0.06)', border: '1px solid rgba(255,200,80,0.18)',
              borderRadius: 4, fontSize: 11, fontFamily: 'var(--ff-mono)', color: 'var(--am)',
            }}>
              {categoriesToCreate.map((c) => <div key={c}>{c}</div>)}
            </div>
          </div>
        )}

        {/* Per-item change list */}
        <div style={{ padding: '0 18px 12px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{
            fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase',
            fontWeight: 600, color: 'var(--mt)', marginBottom: 6,
          }}>
            Item reparenting ({changes.length}{hiddenCount > 0 ? ` — showing first ${MAX_PREVIEW_ROWS}` : ''})
          </div>
          <div style={{
            flex: 1, minHeight: 120, overflow: 'auto',
            border: '1px solid var(--bd)', borderRadius: 4,
          }}>
            <table style={{ width: '100%', fontSize: 11 }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--bd)' }}>Item</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--bd)' }}>Current parent</th>
                  <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--bd)' }}>New parent</th>
                </tr>
              </thead>
              <tbody>
                {visibleChanges.length === 0 ? (
                  <tr><td colSpan={3} style={{ padding: 14, color: 'var(--mt)' }}>No items to reparent.</td></tr>
                ) : visibleChanges.map((c) => (
                  <tr key={c.qbo_item_id}>
                    <td style={{ padding: '4px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      {c.item_name}
                    </td>
                    <td style={{ padding: '4px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)',
                      color: 'var(--tx2)', fontFamily: 'var(--ff-mono)', fontSize: 10 }}>
                      {c.current_parent || '(none)'}
                    </td>
                    <td style={{ padding: '4px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)',
                      color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontSize: 10, fontWeight: 600 }}>
                      {c.new_parent}
                    </td>
                  </tr>
                ))}
                {hiddenCount > 0 && (
                  <tr><td colSpan={3} style={{ padding: '6px 8px', color: 'var(--mt)', fontSize: 10 }}>
                    … and {hiddenCount} more
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Password gate */}
        <div style={{
          padding: '12px 18px', borderTop: '1px solid var(--bd)',
          background: 'rgba(255,200,80,0.04)',
        }}>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 10,
            fontSize: 11, color: 'var(--tx2)',
          }}>
            <Lock size={14} style={{ color: 'var(--am)' }} />
            <span style={{ fontWeight: 600 }}>Confirmation password:</span>
            <input
              type="password"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              placeholder="type to enable Push"
              style={{ ...inp(), flex: 1, fontFamily: 'var(--ff-mono)' }}
            />
            {typed.length > 0 && !passwordOk && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--rd)', fontSize: 10 }}>
                <AlertTriangle size={11} /> no match
              </span>
            )}
            {passwordOk && (
              <span style={{ color: 'var(--gn)', fontSize: 10 }}>✓</span>
            )}
          </label>
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 18px', borderTop: '1px solid var(--bd)',
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <button onClick={onCancel} disabled={busy} style={btnSecondary()}>Cancel</button>
          <button
            onClick={onConfirm}
            disabled={busy || !passwordOk || changes.length + categoriesToCreate.length === 0}
            style={btnPrimary()}
          >
            {busy ? 'Pushing…' : `Push ${changes.length} item${changes.length === 1 ? '' : 's'} to QuickBooks`}
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      padding: '10px 12px', background: 'rgba(255,255,255,0.03)',
      border: '1px solid var(--bd)', borderRadius: 6,
    }}>
      <div style={{
        fontSize: 9, letterSpacing: 1.2, textTransform: 'uppercase',
        color: 'var(--mt)', fontWeight: 600, marginBottom: 4,
      }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--ff-mono)', color }}>
        {value}
      </div>
    </div>
  );
}
