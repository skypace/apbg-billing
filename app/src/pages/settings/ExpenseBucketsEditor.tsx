import { useEffect, useMemo, useState } from 'react';
import {
  AllocationBasis,
  ExpenseBucketType,
  PlAccount,
  fetchExpenseBucketTypes,
  fetchPlAccounts,
  setAccountBucket,
  updateBucketType,
} from '../../lib/settings';
import { fm } from '../../lib/formatters';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { useToast } from '../../lib/toast';

// Map every P&L expense account to a bucket. Above that, mark which
// buckets are "allocable" — those flow into Margin Control's overhead
// allocation engine (real QBO dollars, not a manual number).

const BASIS_OPTIONS: { id: AllocationBasis; label: string }[] = [
  { id: 'revenue',             label: 'By revenue' },
  { id: 'unit_volume',         label: 'By unit volume' },
  { id: 'sku_equal_share',     label: 'Equal share' },
  { id: 'margin_contribution', label: 'By margin' },
];

export function ExpenseBucketsEditor() {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const ytdStart = new Date().getFullYear() + '-01-01';

  const [accounts, setAccounts] = useState<PlAccount[] | null>(null);
  const [types, setTypes] = useState<ExpenseBucketType[]>([]);
  const [filter, setFilter] = useState<'all' | 'unmapped' | string>('all');

  function load() {
    Promise.all([fetchPlAccounts(ytdStart, today), fetchExpenseBucketTypes()])
      .then(([accs, ts]) => {
        setAccounts(accs ?? []);
        setTypes(ts ?? []);
      })
      .catch(() => {
        setAccounts([]);
        setTypes([]);
      });
  }
  useEffect(load, []);

  const visible = useMemo(() => {
    if (!accounts) return null;
    if (filter === 'unmapped') return accounts.filter((r) => !r.bucket_assigned);
    if (filter && filter !== 'all') return accounts.filter((r) => r.bucket_code === filter);
    return accounts;
  }, [accounts, filter]);

  const totals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of accounts ?? []) {
      out[r.bucket_code] = (out[r.bucket_code] || 0) + Math.abs(Number(r.total || 0));
    }
    return out;
  }, [accounts]);

  const allocableTotal = useMemo(
    () => types.filter((t) => t.is_allocable).reduce((s, t) => s + (totals[t.bucket_code] || 0), 0),
    [types, totals],
  );

  const unmappedCount = (accounts ?? []).filter((r) => !r.bucket_assigned).length;

  function changeBucket(account: string, code: string) {
    setAccountBucket(account, code).then(load);
  }

  async function toggleAllocable(code: string, on: boolean) {
    setTypes((cur) => cur.map((t) => (t.bucket_code === code ? { ...t, is_allocable: on } : t)));
    try {
      await updateBucketType(code, { is_allocable: on });
      toast.success(`${on ? 'Marked' : 'Unmarked'} "${code}" ${on ? 'allocable to overhead' : 'as not allocable'}`);
    } catch (e) {
      toast.error('Update failed: ' + (e as Error).message);
      load();
    }
  }

  async function changeBasis(code: string, basis: AllocationBasis) {
    setTypes((cur) => cur.map((t) => (t.bucket_code === code ? { ...t, allocation_basis: basis } : t)));
    try {
      await updateBucketType(code, { allocation_basis: basis });
    } catch (e) {
      toast.error('Update failed: ' + (e as Error).message);
      load();
    }
  }

  if (accounts === null) return <div className="ld">Loading…</div>;

  return (
    <div>
      {/* ===== OVERHEAD ALLOCATION header — Workstream B ===== */}
      <div className="cd" style={{ padding: '10px 14px', marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <div className="ct" style={{ marginTop: 0, marginBottom: 0 }}>
            OVERHEAD ALLOCATION
          </div>
          <div style={{ fontSize: 11, color: 'var(--tx2)' }}>
            <strong style={{ color: 'var(--ac)' }}>{fm(allocableTotal)}</strong> YTD allocable across {types.filter((t) => t.is_allocable).length} bucket{types.filter((t) => t.is_allocable).length === 1 ? '' : 's'}
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Bucket</th>
              <th style={{ width: 110, textAlign: 'center' }}>Allocable?</th>
              <th style={{ width: 200 }}>Basis</th>
              <th style={{ textAlign: 'right', width: 130 }}>YTD $</th>
            </tr>
          </thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.bucket_code} style={{ opacity: t.is_allocable ? 1 : 0.55 }}>
                <td style={{ fontWeight: 600 }}>{t.label}</td>
                <td style={{ textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={t.is_allocable}
                    onChange={(e) => toggleAllocable(t.bucket_code, e.target.checked)}
                    style={{ accentColor: 'var(--ac)' }}
                  />
                </td>
                <td>
                  <select
                    value={t.allocation_basis}
                    onChange={(e) => changeBasis(t.bucket_code, e.target.value as AllocationBasis)}
                    disabled={!t.is_allocable}
                    style={{ ...inp(), width: '100%', maxWidth: 190 }}
                  >
                    {BASIS_OPTIONS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                  </select>
                </td>
                <td className="mn" style={{ textAlign: 'right', fontWeight: t.is_allocable ? 600 : 400 }}>
                  {fm(totals[t.bucket_code] || 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 8, lineHeight: 1.4 }}>
          Allocable buckets feed Margin Control's overhead engine — totals are sourced from real QBO expense lines in the selected window and distributed across revenue rows by the chosen basis.
          <br />
          Material COGS is intentionally not allocable — it's already counted in each row's est_cost.
        </div>
      </div>

      {/* ===== Existing per-bucket KPI strip ===== */}
      <div className="gr" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginBottom: 10 }}>
        {types.map((t) => {
          const on = filter === t.bucket_code;
          return (
            <div
              key={t.bucket_code}
              className="cd"
              onClick={() => setFilter(on ? 'all' : t.bucket_code)}
              style={{
                padding: '8px 10px',
                cursor: 'pointer',
                borderColor: on ? 'var(--ac)' : 'var(--bd)',
                position: 'relative',
              }}
            >
              <div className="ct" style={{ margin: 0 }}>{t.label.toUpperCase()}</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{fm(totals[t.bucket_code] || 0)}</div>
              {t.is_allocable && (
                <span
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    fontSize: 8,
                    letterSpacing: 0.6,
                    color: 'var(--ac)',
                    fontWeight: 700,
                  }}
                >
                  OH
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* ===== Existing accounts table ===== */}
      <div className="cd" style={{ padding: 0 }}>
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--bd)',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <div className="ct" style={{ margin: 0 }}>
            EXPENSE ACCOUNTS — {visible?.length ?? 0}{filter && filter !== 'all' ? ' / ' + accounts.length : ''}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => setFilter(filter === 'unmapped' ? 'all' : 'unmapped')}
              style={filter === 'unmapped' ? btnPrimary() : btnSecondary()}
            >
              UNMAPPED ({unmappedCount})
            </button>
            <button
              onClick={() => setFilter('all')}
              style={!filter || filter === 'all' ? btnPrimary() : btnSecondary()}
            >
              ALL
            </button>
          </div>
        </div>

        <div style={{ maxHeight: '58vh', overflow: 'auto' }}>
          <table>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th style={{ textAlign: 'right' }}>YTD Total</th>
                <th>Bucket</th>
              </tr>
            </thead>
            <tbody>
              {(visible ?? []).map((r) => (
                <tr
                  key={r.account_name}
                  style={!r.bucket_assigned ? { background: 'rgba(251,191,36,.05)' } : undefined}
                >
                  <td>{r.account_name}</td>
                  <td style={{ fontSize: 10, color: 'var(--mt)' }}>{r.account_type ?? ''}</td>
                  <td className="mn" style={{ textAlign: 'right' }}>{fm(Math.abs(Number(r.total || 0)))}</td>
                  <td>
                    <select
                      value={r.bucket_code}
                      onChange={(e) => changeBucket(r.account_name, e.target.value)}
                      style={{ ...inp(), width: '100%', maxWidth: 220 }}
                    >
                      {types.map((t) => (
                        <option key={t.bucket_code} value={t.bucket_code}>{t.label}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
