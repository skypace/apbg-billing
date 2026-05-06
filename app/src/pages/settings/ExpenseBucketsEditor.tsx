import { useEffect, useMemo, useState } from 'react';
import {
  ExpenseBucketType,
  PlAccount,
  fetchExpenseBucketTypes,
  fetchPlAccounts,
  setAccountBucket,
} from '../../lib/settings';
import { fm } from '../../lib/formatters';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';

// Map every P&L expense account to a bucket. Filter: ALL / UNMAPPED / per-bucket.
// Top KPI strip shows YTD total per bucket. Click a bucket card to filter to it.

export function ExpenseBucketsEditor() {
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

  const unmappedCount = (accounts ?? []).filter((r) => !r.bucket_assigned).length;

  function changeBucket(account: string, code: string) {
    setAccountBucket(account, code).then(load);
  }

  if (accounts === null) return <div className="ld">Loading…</div>;

  return (
    <div>
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
              }}
            >
              <div className="ct" style={{ margin: 0 }}>{t.label.toUpperCase()}</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{fm(totals[t.bucket_code] || 0)}</div>
            </div>
          );
        })}
      </div>

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
