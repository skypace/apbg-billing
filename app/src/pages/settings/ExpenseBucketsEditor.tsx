import { useEffect, useMemo, useState } from 'react';
import { PrintableTable } from '../../components/PrintableTable';
import {
  AllocationBasis,
  ExpenseBucketType,
  PlAccount,
  ProposedAccountBucket,
  bulkSetAccountBuckets,
  fetchExpenseBucketTypes,
  fetchPlAccounts,
  fetchProposedAccountBuckets,
  setAccountBucket,
  updateBucketType,
} from '../../lib/settings';
import { fm } from '../../lib/formatters';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { useToast } from '../../lib/toast';

// Three-tier editor:
//   1. AUTO-CLASSIFIER — propose bucket assignments based on which items
//      reference each P&L account. Bulk-apply unassigned suggestions.
//   2. OVERHEAD ALLOCATION — toggle which buckets feed Margin Control's
//      overhead engine + pick allocation basis.
//   3. PER-BUCKET KPI STRIP + accounts table — the existing manual layer.

const BASIS_OPTIONS: { id: AllocationBasis; label: string }[] = [
  { id: 'revenue',             label: 'By revenue' },
  { id: 'unit_volume',         label: 'By unit volume' },
  { id: 'sku_equal_share',     label: 'Equal share' },
  { id: 'margin_contribution', label: 'By margin' },
];

const ROLE_BADGE: Record<string, { label: string; color: string }> = {
  operating:     { label: 'OPERATING',  color: 'var(--gn)' },
  balance_sheet: { label: 'B/S',        color: 'var(--mt)' },
  financial:     { label: 'FINANCIAL',  color: 'var(--am)' },
};

export function ExpenseBucketsEditor() {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const ytdStart = new Date().getFullYear() + '-01-01';

  const [accounts, setAccounts] = useState<PlAccount[] | null>(null);
  const [types, setTypes] = useState<ExpenseBucketType[]>([]);
  const [proposals, setProposals] = useState<ProposedAccountBucket[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'unmapped' | string>('all');
  const [applying, setApplying] = useState(false);
  const [proposalFilter, setProposalFilter] = useState<'unassigned' | 'overrides' | 'all'>('unassigned');

  function load() {
    Promise.all([
      fetchPlAccounts(ytdStart, today),
      fetchExpenseBucketTypes(),
      fetchProposedAccountBuckets(ytdStart, today),
    ])
      .then(([accs, ts, props]) => {
        setAccounts(accs ?? []);
        setTypes(ts ?? []);
        setProposals(props ?? []);
      })
      .catch(() => {
        setAccounts([]); setTypes([]); setProposals([]);
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

  const proposalStats = useMemo(() => {
    if (!proposals) return null;
    const stats = { direct: 0, overhead: 0, excluded: 0, unassigned: 0, overrides: 0 };
    for (const p of proposals) {
      if (p.account_role === 'balance_sheet' || p.account_role === 'financial') stats.excluded += p.ytd;
      else if (p.suggested_bucket === 'cogs_material') stats.direct += p.ytd;
      else if (p.suggested_bucket) stats.overhead += p.ytd;
      if (!p.current_bucket && p.suggested_bucket) stats.unassigned += 1;
      if (p.current_bucket && p.suggested_bucket && p.current_bucket !== p.suggested_bucket) stats.overrides += 1;
    }
    return stats;
  }, [proposals]);

  const proposalsVisible = useMemo(() => {
    if (!proposals) return [];
    return proposals.filter((p) => {
      if (proposalFilter === 'unassigned') return !p.current_bucket && p.suggested_bucket;
      if (proposalFilter === 'overrides') return p.current_bucket && p.suggested_bucket && p.current_bucket !== p.suggested_bucket;
      return true;
    });
  }, [proposals, proposalFilter]);

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
    try { await updateBucketType(code, { allocation_basis: basis }); }
    catch (e) { toast.error('Update failed: ' + (e as Error).message); load(); }
  }

  async function applyOne(p: ProposedAccountBucket) {
    if (!p.suggested_bucket) return;
    try {
      await setAccountBucket(p.account_name, p.suggested_bucket);
      toast.success(`Mapped "${p.account_name}" -> ${p.suggested_bucket}`);
      load();
    } catch (e) {
      toast.error('Apply failed: ' + (e as Error).message);
    }
  }

  async function applyAllUnassigned() {
    if (!proposals) return;
    const assignments = proposals
      .filter((p) => !p.current_bucket && p.suggested_bucket)
      .map((p) => ({ account_name: p.account_name, bucket_code: p.suggested_bucket! }));
    if (assignments.length === 0) {
      toast.info('No unassigned accounts with suggestions');
      return;
    }
    if (!confirm(`Apply ${assignments.length} suggested bucket assignments? You can adjust any individually afterward.`)) return;
    setApplying(true);
    try {
      const n = await bulkSetAccountBuckets(assignments);
      toast.success(`Applied ${n} bucket assignments`);
      load();
    } catch (e) {
      toast.error('Bulk apply failed: ' + (e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  if (accounts === null) return <div className="ld">Loading…</div>;

  return (
    <div>
      {/* ===== 1. AUTO-CLASSIFIER ===== */}
      <div className="cd" style={{ padding: '10px 14px', marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <div className="ct" style={{ marginTop: 0, marginBottom: 0 }}>AUTO-CLASSIFY ACCOUNTS</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={load} style={btnSecondary()}>Refresh</button>
            <button
              onClick={applyAllUnassigned}
              disabled={applying || !proposalStats || proposalStats.unassigned === 0}
              style={btnPrimary()}
            >
              {applying ? 'Applying…' : `Apply ${proposalStats?.unassigned ?? 0} unassigned`}
            </button>
          </div>
        </div>

        {proposalStats && (
          <div className="gr" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginBottom: 10 }}>
            <div className="cd" style={{ padding: '8px 10px' }}>
              <div className="ct" style={{ margin: 0 }}>DIRECT COGS</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{fm(proposalStats.direct)}</div>
              <div style={{ fontSize: 10, color: 'var(--mt)' }}>item-tied, in est_cost</div>
            </div>
            <div className="cd" style={{ padding: '8px 10px' }}>
              <div className="ct" style={{ margin: 0 }}>OVERHEAD POTENTIAL</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3, color: 'var(--ac)' }}>{fm(proposalStats.overhead)}</div>
              <div style={{ fontSize: 10, color: 'var(--mt)' }}>allocable across rev rows</div>
            </div>
            <div className="cd" style={{ padding: '8px 10px' }}>
              <div className="ct" style={{ margin: 0 }}>EXCLUDED</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{fm(proposalStats.excluded)}</div>
              <div style={{ fontSize: 10, color: 'var(--mt)' }}>balance sheet / financial</div>
            </div>
            <div className="cd" style={{ padding: '8px 10px' }}>
              <div className="ct" style={{ margin: 0 }}>NEEDS REVIEW</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3, color: proposalStats.unassigned > 0 ? 'var(--am)' : undefined }}>
                {proposalStats.unassigned} new
              </div>
              <div style={{ fontSize: 10, color: 'var(--mt)' }}>{proposalStats.overrides} override conflict{proposalStats.overrides === 1 ? '' : 's'}</div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button
            onClick={() => setProposalFilter('unassigned')}
            style={proposalFilter === 'unassigned' ? btnPrimary() : btnSecondary()}
          >Unassigned ({proposalStats?.unassigned ?? 0})</button>
          <button
            onClick={() => setProposalFilter('overrides')}
            style={proposalFilter === 'overrides' ? btnPrimary() : btnSecondary()}
          >Override Conflicts ({proposalStats?.overrides ?? 0})</button>
          <button
            onClick={() => setProposalFilter('all')}
            style={proposalFilter === 'all' ? btnPrimary() : btnSecondary()}
          >All ({proposals?.length ?? 0})</button>
        </div>

        <div style={{ maxHeight: '38vh', overflow: 'auto' }}>
          <PrintableTable>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th>Account</th>
                  <th style={{ textAlign: 'right' }}>YTD $</th>
                  <th style={{ textAlign: 'center' }}>Items Tied</th>
                  <th>Role</th>
                  <th>Current</th>
                  <th>Suggested</th>
                  <th style={{ width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {proposalsVisible.map((p) => {
                  const role = ROLE_BADGE[p.account_role] ?? { label: p.account_role, color: 'var(--mt)' };
                  const conflict = p.current_bucket && p.suggested_bucket && p.current_bucket !== p.suggested_bucket;
                  return (
                    <tr key={p.account_name}>
                      <td title={p.account_name} style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.account_name}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{fm(p.ytd)}</td>
                      <td style={{ textAlign: 'center', fontSize: 10, color: p.items_as_expense > 0 ? 'var(--ac)' : 'var(--mt)' }}>
                        {p.items_total > 0 ? `${p.items_as_expense}/${p.items_total}` : '—'}
                      </td>
                      <td style={{ fontSize: 9, color: role.color, fontWeight: 600, letterSpacing: 0.4 }}>{role.label}</td>
                      <td style={{ fontSize: 10, color: 'var(--mt)' }}>{p.current_bucket ?? '—'}</td>
                      <td style={{ fontSize: 10, color: conflict ? 'var(--am)' : 'var(--ac)', fontWeight: 600 }}>
                        {p.suggested_bucket ?? '(excluded)'}
                      </td>
                      <td>
                        {p.suggested_bucket && (
                          <button onClick={() => applyOne(p)} style={btnSecondary()} title="Apply suggestion">
                            {conflict ? 'Override' : 'Apply'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {proposalsVisible.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--mt)', padding: '12px 0' }}>Nothing to review.</td></tr>
                )}
              </tbody>
            </table>
          </PrintableTable>
        </div>

        <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 8, lineHeight: 1.4 }}>
          Items Tied shows how many QBO items use this account as their expense / total references. Item-tied accounts get suggested as <strong>cogs_material</strong> because their cost already flows through est_cost on each invoice line — they shouldn't double-count as overhead.
        </div>
      </div>

      {/* ===== 2. OVERHEAD ALLOCATION ===== */}
      <div className="cd" style={{ padding: '10px 14px', marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <div className="ct" style={{ marginTop: 0, marginBottom: 0 }}>OVERHEAD ALLOCATION</div>
          <div style={{ fontSize: 11, color: 'var(--tx2)' }}>
            <strong style={{ color: 'var(--ac)' }}>{fm(allocableTotal)}</strong> YTD allocable across {types.filter((t) => t.is_allocable).length} bucket{types.filter((t) => t.is_allocable).length === 1 ? '' : 's'}
          </div>
        </div>
        <PrintableTable>
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
                      type="checkbox" checked={t.is_allocable}
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
        </PrintableTable>
        <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 8, lineHeight: 1.4 }}>
          Allocable buckets feed Margin Control's overhead engine — totals are sourced from real QBO expense lines in the selected window and distributed across revenue rows by the chosen basis.
          <br />
          Material COGS is intentionally not allocable — it's already counted in each row's est_cost.
        </div>
      </div>

      {/* ===== 3. PER-BUCKET KPI STRIP ===== */}
      <div className="gr" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginBottom: 10 }}>
        {types.map((t) => {
          const on = filter === t.bucket_code;
          return (
            <div key={t.bucket_code} className="cd"
              onClick={() => setFilter(on ? 'all' : t.bucket_code)}
              style={{ padding: '8px 10px', cursor: 'pointer', borderColor: on ? 'var(--ac)' : 'var(--bd)', position: 'relative' }}
            >
              <div className="ct" style={{ margin: 0 }}>{t.label.toUpperCase()}</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{fm(totals[t.bucket_code] || 0)}</div>
              {t.is_allocable && (
                <span style={{ position: 'absolute', top: 6, right: 6, fontSize: 8, letterSpacing: 0.6, color: 'var(--ac)', fontWeight: 700 }}>OH</span>
              )}
            </div>
          );
        })}
      </div>

      {/* ===== 4. ACCOUNTS TABLE ===== */}
      <div className="cd" style={{ padding: 0 }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div className="ct" style={{ margin: 0 }}>
            EXPENSE ACCOUNTS — {visible?.length ?? 0}{filter && filter !== 'all' ? ' / ' + accounts.length : ''}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setFilter(filter === 'unmapped' ? 'all' : 'unmapped')} style={filter === 'unmapped' ? btnPrimary() : btnSecondary()}>
              UNMAPPED ({unmappedCount})
            </button>
            <button onClick={() => setFilter('all')} style={!filter || filter === 'all' ? btnPrimary() : btnSecondary()}>ALL</button>
          </div>
        </div>

        <div style={{ maxHeight: '40vh', overflow: 'auto' }}>
          <PrintableTable>
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
                  <tr key={r.account_name} style={!r.bucket_assigned ? { background: 'rgba(251,191,36,.05)' } : undefined}>
                    <td>{r.account_name}</td>
                    <td style={{ fontSize: 10, color: 'var(--mt)' }}>{r.account_type ?? ''}</td>
                    <td className="mn" style={{ textAlign: 'right' }}>{fm(Math.abs(Number(r.total || 0)))}</td>
                    <td>
                      <select value={r.bucket_code} onChange={(e) => changeBucket(r.account_name, e.target.value)} style={{ ...inp(), width: '100%', maxWidth: 220 }}>
                        {types.map((t) => <option key={t.bucket_code} value={t.bucket_code}>{t.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </PrintableTable>
        </div>
      </div>
    </div>
  );
}
