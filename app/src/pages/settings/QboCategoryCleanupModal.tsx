// One-shot cleanup of QBO item categorization.
//
// Flow:
//   1. Preview — count of items to unparent + categories to inactivate.
//   2. Phase A (unparent) — runs in 50-item batches until QBO has zero
//      sub-items left. Each batch is one round-trip to push-qbo-item.
//   3. Phase B (inactivate) — runs in 50-item batches until every QBO
//      Category Item is inactive.
//
// BRIX inventory_settings.category_override is NEVER touched — local
// BRIX categorization survives. After the cleanup, QBO transactions /
// reports / invoices show items as bare names ("Cola 3GAL BIB") with
// no "Beverages:3 Gallon BIB:" prefix.

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, X as XIcon } from 'lucide-react';
import { btnDanger, btnPrimary, btnSecondary } from '../../lib/styles';
import {
  previewQboCategoryCleanup,
  runQboInactivateBatch,
  runQboUnparentBatch,
} from '../../lib/inventory';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Step = 'preview' | 'preview-loaded' | 'unparenting' | 'inactivating' | 'done' | 'error';

interface Progress {
  unparented: number;
  unparent_remaining: number;
  inactivated: number;
  inactivate_remaining: number;
  errors: { id: string; error: string }[];
}

const PHASE_LIMIT = 50;

export function QboCategoryCleanupModal({ open, onClose }: Props) {
  const [step, setStep] = useState<Step>('preview');
  const [preview, setPreview] = useState<{ items: number; categories: number; total: number } | null>(null);
  const [progress, setProgress] = useState<Progress>({
    unparented: 0, unparent_remaining: 0,
    inactivated: 0, inactivate_remaining: 0,
    errors: [],
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!open) return null;

  async function loadPreview() {
    setStep('preview');
    setErrorMsg(null);
    try {
      const p = await previewQboCategoryCleanup();
      setPreview({
        items:      p.items_to_unparent ?? 0,
        categories: p.categories_to_inactivate ?? 0,
        total:      p.categories_total_in_qbo ?? 0,
      });
      setProgress((s) => ({
        ...s,
        unparent_remaining:   p.items_to_unparent ?? 0,
        inactivate_remaining: p.categories_to_inactivate ?? 0,
      }));
      setStep('preview-loaded');
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStep('error');
    }
  }

  async function runCleanup() {
    setStep('unparenting');
    setErrorMsg(null);
    try {
      // Phase A — unparent in batches until remaining hits 0.
      while (true) {
        const r = await runQboUnparentBatch(true, PHASE_LIMIT);
        const updated = (r.summary?.updated ?? 0) + (r.summary?.already_clean ?? 0);
        setProgress((s) => ({
          ...s,
          unparented:         s.unparented + updated,
          unparent_remaining: r.remaining ?? 0,
          errors:             [...s.errors, ...(r.summary?.errors ?? [])],
        }));
        if (!r.ok) throw new Error(r.error || 'unparent phase failed');
        if ((r.remaining ?? 0) === 0) break;
        if (updated === 0 && (r.summary?.errors?.length ?? 0) === 0) {
          // No forward progress and no errors — bail to avoid infinite loop.
          throw new Error('Unparent phase stalled with no progress and no errors. Check the QBO sync log.');
        }
      }

      // Phase B — inactivate categories in batches until remaining hits 0.
      setStep('inactivating');
      while (true) {
        const r = await runQboInactivateBatch(true, PHASE_LIMIT);
        const updated = (r.summary?.updated ?? 0) + (r.summary?.already_inactive ?? 0);
        setProgress((s) => ({
          ...s,
          inactivated:         s.inactivated + updated,
          inactivate_remaining: r.remaining ?? 0,
          errors:              [...s.errors, ...(r.summary?.errors ?? [])],
        }));
        if (!r.ok) throw new Error(r.error || 'inactivate phase failed');
        if ((r.remaining ?? 0) === 0) break;
        if (updated === 0 && (r.summary?.errors?.length ?? 0) === 0) {
          throw new Error('Inactivate phase stalled with no progress and no errors. Check the QBO sync log.');
        }
      }
      setStep('done');
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStep('error');
    }
  }

  const running = step === 'unparenting' || step === 'inactivating';

  return (
    <div
      onClick={running ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '90px 20px 20px', overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
          maxWidth: 640, width: '100%', padding: 20,
          boxShadow: '0 12px 60px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
              QBO Cleanup · One-shot
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 18, color: 'var(--ac)' }}>
              Flatten + inactivate QBO categories
            </h2>
            <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 4 }}>
              Removes the <code>Category:Item</code> prefix from QBO transactions, reports, and invoices.
            </div>
          </div>
          {!running && (
            <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
              <XIcon size={18} />
            </button>
          )}
        </div>

        {step === 'preview' && (
          <div className="cd" style={{ padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <AlertTriangle size={16} color="var(--am)" />
              <div style={{ fontSize: 12, color: 'var(--am)' }}>
                Click <strong>Run Preview</strong> to count what would change — no QBO writes yet.
              </div>
            </div>
            <button onClick={loadPreview} style={btnPrimary()}>Run Preview</button>
          </div>
        )}

        {step === 'preview-loaded' && preview && (
          <div>
            <div className="cd" style={{ padding: 14, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                What this will do
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.55 }}>
                <li><strong style={{ color: 'var(--ac)' }}>{preview.items.toLocaleString()}</strong> item(s) → ParentRef cleared, SubItem set to false in QBO</li>
                <li><strong style={{ color: 'var(--ac)' }}>{preview.categories.toLocaleString()}</strong> active QBO Category item(s) → Active set to false</li>
                <li>{preview.total.toLocaleString()} category records total in QBO (some already inactive)</li>
              </ul>
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--gn)' }}>
                ✓ BRIX local category overrides stay intact. Margin Control still shows your categorization.
              </div>
            </div>

            <div className="cd" style={{ padding: 14, background: 'rgba(220,38,38,0.05)', borderColor: 'var(--rd)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
                <AlertTriangle size={16} color="var(--rd)" style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: 12, color: 'var(--tx)', lineHeight: 1.5 }}>
                  This makes <strong>{preview.items + preview.categories}</strong> writes to your QBO file
                  over the next few minutes. Existing transactions, COGS, balances, and inventory quantities are not affected —
                  only how items render in QBO transaction lines and reports.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button onClick={onClose} style={btnSecondary()}>Cancel</button>
                <button onClick={runCleanup} style={btnDanger()}>Begin Cleanup ({preview.items + preview.categories} writes)</button>
              </div>
            </div>
          </div>
        )}

        {(step === 'unparenting' || step === 'inactivating') && (
          <div className="cd" style={{ padding: 14 }}>
            <div style={{ fontSize: 11, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
              {step === 'unparenting' ? 'Phase 1 of 2 · Unparenting items' : 'Phase 2 of 2 · Inactivating categories'}
            </div>
            <ProgressRow
              label="Items unparented"
              done={progress.unparented}
              remaining={progress.unparent_remaining}
            />
            <ProgressRow
              label="Categories inactivated"
              done={progress.inactivated}
              remaining={progress.inactivate_remaining}
            />
            {progress.errors.length > 0 && (
              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--am)' }}>
                ⚠️ {progress.errors.length} error(s) so far (cleanup continues for the rest).
              </div>
            )}
            <div style={{ marginTop: 10, fontSize: 10, color: 'var(--mt)', fontStyle: 'italic' }}>
              Don't close this dialog — batching {PHASE_LIMIT} items per round-trip.
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="cd" style={{ padding: 14, background: 'rgba(58,167,113,0.06)', borderColor: 'var(--gn)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <CheckCircle2 size={18} color="var(--gn)" />
              <strong style={{ fontSize: 14, color: 'var(--gn)' }}>QBO cleanup complete</strong>
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
              <li>{progress.unparented.toLocaleString()} item(s) unparented</li>
              <li>{progress.inactivated.toLocaleString()} categories inactivated</li>
              {progress.errors.length > 0 && (
                <li style={{ color: 'var(--am)' }}>{progress.errors.length} error(s) — see Supabase sync_log table</li>
              )}
            </ul>
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--mt)' }}>
              Refresh any QBO tab to see the change. BRIX categorization is unaffected.
            </div>
            <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={btnPrimary()}>Close</button>
            </div>
          </div>
        )}

        {step === 'error' && (
          <div className="cd" style={{ padding: 14, background: 'rgba(220,38,38,0.06)', borderColor: 'var(--rd)' }}>
            <div style={{ fontSize: 13, color: 'var(--rd)', marginBottom: 8 }}>
              <strong>Cleanup hit an error</strong>
            </div>
            <div style={{ fontSize: 12, color: 'var(--tx)', fontFamily: 'var(--ff-mono)', marginBottom: 10 }}>
              {errorMsg}
            </div>
            <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 12 }}>
              Progress so far is saved. You can close and re-open this dialog to retry — already-cleaned items will be skipped.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={btnSecondary()}>Close</button>
              <button onClick={() => { setStep('preview'); setProgress({ unparented: 0, unparent_remaining: 0, inactivated: 0, inactivate_remaining: 0, errors: [] }); }} style={btnPrimary()}>
                Restart
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProgressRow({ label, done, remaining }: { label: string; done: number; remaining: number }) {
  const total = done + remaining;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--mt)', marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ fontFamily: 'var(--ff-mono)' }}>{done.toLocaleString()} / {total.toLocaleString()} ({pct}%)</span>
      </div>
      <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: pct + '%', height: '100%', background: 'var(--ac)', transition: 'width 0.3s' }} />
      </div>
    </div>
  );
}
