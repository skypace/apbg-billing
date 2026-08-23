import { useMemo, useState } from 'react';
import { Loader2, PackageMinus, Trash2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useDistributor } from '@/lib/distributor';
import { useLoad, useItemNames } from '@/lib/hooks';
import { fmtDate, fmtMoney, fmtQty, todayISO } from '@/lib/format';
import { Spinner, ErrorNote, EmptyNote, Chip } from '@/components/ui';
import { ItemSearch } from '@/components/ItemSearch';
import type { CatalogItem, Depletion, DistributorAccount, Settlement } from '@/lib/types';

interface DraftLine {
  qbo_item_id: string;
  name: string;
  cases: number;
}

interface DepData {
  accounts: DistributorAccount[];
  depletions: Depletion[];
  settlements: Settlement[];
}

interface Batch {
  batch_id: string;
  delivered_date: string;
  account_id: string | null;
  reference: string | null;
  rows: Depletion[];
  totalCases: number;
  totalFee: number | null;
  settled: boolean;
}

export default function Depletions() {
  const { distributor } = useDistributor();
  const distId = distributor?.id ?? null;

  const { data, loading, error, reload } = useLoad<DepData>(async () => {
    if (!distId) return { accounts: [], depletions: [], settlements: [] };
    const ac = await supabase
      .from('sub_distributor_accounts')
      .select('id, sub_distributor_id, qbo_customer_id, account_name, chain, is_active')
      .eq('sub_distributor_id', distId)
      .order('account_name');
    if (ac.error) throw new Error(ac.error.message);

    const dp = await supabase
      .from('sub_distributor_depletions')
      .select(
        'id, batch_id, sub_distributor_id, account_id, qbo_item_id, cases, delivered_date, reference, fee_per_case, fee_amount, settlement_id, recorded_by_email, created_at'
      )
      .eq('sub_distributor_id', distId)
      .order('delivered_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(600);
    if (dp.error) throw new Error(dp.error.message);

    const st = await supabase
      .from('sub_distributor_settlements')
      .select(
        'id, sub_distributor_id, period_start, period_end, depletion_count, total_cases, total_fee, status, reference, created_at'
      )
      .eq('sub_distributor_id', distId)
      .order('period_end', { ascending: false })
      .limit(200);
    if (st.error) throw new Error(st.error.message);

    return {
      accounts: (ac.data ?? []) as DistributorAccount[],
      depletions: (dp.data ?? []) as Depletion[],
      settlements: (st.data ?? []) as Settlement[],
    };
  }, [distId]);

  const itemName = useItemNames((data?.depletions ?? []).map((d) => d.qbo_item_id));

  const accounts = data?.accounts ?? [];
  const activeAccounts = accounts.filter((a) => a.is_active);
  const accountName = (id: string | null) =>
    accounts.find((a) => a.id === id)?.account_name ?? (id ? 'Account' : '—');

  // ── Form state ──
  const [accountId, setAccountId] = useState('');
  const [deliveredDate, setDeliveredDate] = useState(todayISO());
  const [reference, setReference] = useState('');
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  function addItem(it: CatalogItem) {
    setDraftLines((ls) => {
      if (ls.some((l) => l.qbo_item_id === it.qbo_item_id)) return ls;
      return [...ls, { qbo_item_id: it.qbo_item_id, name: it.name, cases: 1 }];
    });
  }

  async function submitDepletion() {
    if (!distId) return;
    if (!accountId) {
      setSubmitError('Pick the account you delivered to.');
      return;
    }
    if (draftLines.length === 0 || draftLines.some((l) => !(l.cases > 0))) {
      setSubmitError('Add at least one item, with cases greater than zero.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const { error: err } = await supabase.rpc('fn_distributor_record_depletion', {
      p_sub_distributor_id: distId,
      p_account_id: accountId,
      p_delivered_date: deliveredDate,
      p_lines: draftLines.map((l) => ({ qbo_item_id: l.qbo_item_id, cases: l.cases })),
      p_reference: reference.trim() || null,
    });
    setSubmitting(false);
    if (err) {
      setSubmitError(err.message);
      return;
    }
    setDraftLines([]);
    setReference('');
    setSavedNote(true);
    window.setTimeout(() => setSavedNote(false), 4000);
    reload();
  }

  // ── History grouped by batch ──
  const batches: Batch[] = useMemo(() => {
    const map = new Map<string, Batch>();
    for (const d of data?.depletions ?? []) {
      let b = map.get(d.batch_id);
      if (!b) {
        b = {
          batch_id: d.batch_id,
          delivered_date: d.delivered_date,
          account_id: d.account_id,
          reference: d.reference,
          rows: [],
          totalCases: 0,
          totalFee: null,
          settled: false,
        };
        map.set(d.batch_id, b);
      }
      b.rows.push(d);
      b.totalCases += Number(d.cases || 0);
      if (d.fee_amount !== null && d.fee_amount !== undefined) {
        b.totalFee = (b.totalFee ?? 0) + Number(d.fee_amount);
      }
      if (d.settlement_id) b.settled = true;
    }
    return Array.from(map.values());
  }, [data]);

  const casesThisMonth = useMemo(() => {
    const now = new Date();
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return (data?.depletions ?? [])
      .filter((d) => (d.delivered_date ?? '').startsWith(prefix))
      .reduce((s, d) => s + Number(d.cases || 0), 0);
  }, [data]);

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Depletions</h1>
          <p>
            Record the cases you delivered to your serviced accounts. Each
            recording moves inventory out of your on-hand count
            {distributor?.model === 'consignment'
              ? ' and logs your per-case delivery fee.'
              : '.'}
          </p>
        </div>
        <div className="glass-card stat-card" style={{ minWidth: 200 }}>
          <div className="stat-label"><PackageMinus size={13} /> Cases delivered this month</div>
          <div className="stat-value">{fmtQty(casesThisMonth)}</div>
        </div>
      </div>

      <div className="glass-card">
        <h3 style={{ marginBottom: 12 }}>Record deliveries</h3>
        {activeAccounts.length === 0 ? (
          <EmptyNote>
            No serviced accounts are set up for you yet — contact your Brix
            Beverage rep to add the stores you deliver to.
          </EmptyNote>
        ) : (
          <>
            <div className="form-grid">
              <div className="field-col">
                <label className="fld" htmlFor="dep-account">Account *</label>
                <select
                  id="dep-account"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  <option value="">Select an account…</option>
                  {activeAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.account_name ?? a.qbo_customer_id}
                      {a.chain ? ` · ${a.chain}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-col">
                <label className="fld" htmlFor="dep-date">Delivered date *</label>
                <input
                  id="dep-date"
                  type="date"
                  value={deliveredDate}
                  onChange={(e) => setDeliveredDate(e.target.value)}
                />
              </div>
              <div className="field-col">
                <label className="fld" htmlFor="dep-ref">Your reference (optional)</label>
                <input
                  id="dep-ref"
                  type="text"
                  placeholder="Delivery / invoice #"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <label className="fld">Items delivered</label>
              <ItemSearch onPick={addItem} placeholder="Search items to add…" />
              {draftLines.map((l) => (
                <div key={l.qbo_item_id} className="line-row">
                  <span className="line-name">{l.name}</span>
                  <span className="qty-stepper">
                    <button
                      type="button"
                      onClick={() =>
                        setDraftLines((ls) =>
                          ls.map((x) =>
                            x.qbo_item_id === l.qbo_item_id
                              ? { ...x, cases: Math.max(1, x.cases - 1) }
                              : x
                          )
                        )
                      }
                      aria-label="Decrease"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={1}
                      step="any"
                      value={l.cases}
                      onChange={(e) =>
                        setDraftLines((ls) =>
                          ls.map((x) =>
                            x.qbo_item_id === l.qbo_item_id
                              ? { ...x, cases: Math.max(0, Number(e.target.value)) }
                              : x
                          )
                        )
                      }
                      aria-label={`Cases for ${l.name}`}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setDraftLines((ls) =>
                          ls.map((x) =>
                            x.qbo_item_id === l.qbo_item_id ? { ...x, cases: x.cases + 1 } : x
                          )
                        )
                      }
                      aria-label="Increase"
                    >
                      +
                    </button>
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--mt)' }}>cases</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      setDraftLines((ls) => ls.filter((x) => x.qbo_item_id !== l.qbo_item_id))
                    }
                    aria-label={`Remove ${l.name}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>

            {submitError && <div className="err-note">{submitError}</div>}
            {savedNote && (
              <div className="callout callout-info" style={{ marginBottom: 0 }}>
                <div><strong>Recorded.</strong> Your on-hand inventory has been updated.</div>
              </div>
            )}

            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={submitting || draftLines.length === 0 || !accountId}
                onClick={submitDepletion}
              >
                {submitting ? <Loader2 size={16} className="spin" /> : <PackageMinus size={16} />}
                Record delivery
              </button>
            </div>
          </>
        )}
      </div>

      <div className="glass-card">
        <h3 style={{ marginBottom: 12 }}>Delivery history</h3>
        {batches.length === 0 ? (
          <EmptyNote>No deliveries recorded yet.</EmptyNote>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Account</th>
                  <th>Reference</th>
                  <th>Items</th>
                  <th className="r">Cases</th>
                  {batches.some((b) => b.totalFee !== null) && <th className="r">Delivery fee</th>}
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.batch_id}>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                        {fmtDate(b.delivered_date)}
                        {b.settled && <Chip tone="success">settled</Chip>}
                      </span>
                    </td>
                    <td>{accountName(b.account_id)}</td>
                    <td>{b.reference ?? '—'}</td>
                    <td style={{ maxWidth: 420 }}>
                      {b.rows
                        .map((r) => `${itemName(r.qbo_item_id)} × ${fmtQty(r.cases)}`)
                        .join(' · ')}
                    </td>
                    <td className="r">{fmtQty(b.totalCases)}</td>
                    {batches.some((x) => x.totalFee !== null) && (
                      <td className="r">{b.totalFee === null ? '—' : fmtMoney(b.totalFee)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Read-only: settlements are created by Brix staff from recorded deliveries. */}
      <div className="glass-card">
        <h3 style={{ marginBottom: 6 }}>Settlements</h3>
        <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--tx2)' }}>
          Settlements are what you bill Brix Beverage for delivery fees.
          Generated by Brix from your recorded deliveries.
        </p>
        {(data?.settlements ?? []).length === 0 ? (
          <EmptyNote>No settlements yet.</EmptyNote>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Period</th>
                  <th className="r">Cases</th>
                  <th className="r">Delivery-fee total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(data?.settlements ?? []).map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 700 }}>{s.reference ?? '—'}</td>
                    <td>
                      {fmtDate(s.period_start)} → {fmtDate(s.period_end)}
                    </td>
                    <td className="r">{fmtQty(s.total_cases)}</td>
                    <td className="r">{fmtMoney(s.total_fee)}</td>
                    <td>
                      {s.status === 'void' ? (
                        <Chip tone="danger">Voided</Chip>
                      ) : (
                        <Chip tone="info">Submitted to Brix</Chip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
