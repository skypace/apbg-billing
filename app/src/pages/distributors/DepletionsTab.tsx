import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  SettlementCreateResult,
  SubDistributor,
  SubDistributorAccount,
  SubDistributorDepletion,
  SubDistributorSettlement,
  createSettlement,
  fetchDepletions,
  fetchDistributorAccounts,
  fetchSettlements,
  voidSettlement,
} from '../../lib/subDistributors';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';
import { Chip, errMsg, LField, Modal, rpcErrMsg, Td, Th } from './common';

interface Props {
  dist: SubDistributor;
  itemNameById: Map<string, string>;
}

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Previous calendar month as [start, end] ISO dates. */
function previousMonthRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: iso(start), end: iso(end) };
}

export function DistributorDepletionsTab({ dist, itemNameById }: Props) {
  const toast = useToast();
  const [rows, setRows] = useState<SubDistributorDepletion[] | null>(null);
  const [accounts, setAccounts] = useState<SubDistributorAccount[] | null>(null);
  const [settlements, setSettlements] = useState<SubDistributorSettlement[] | null>(null);
  const [month, setMonth] = useState(''); // 'YYYY-MM' or '' = all recent

  function reloadDepletions() {
    setRows(null);
    fetchDepletions(dist.id, month || null)
      .then(setRows)
      .catch((e) => { setRows([]); toast.error(errMsg(e)); });
  }

  function reloadSettlements() {
    setSettlements(null);
    fetchSettlements(dist.id).then(setSettlements).catch(() => setSettlements([]));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reloadDepletions, [dist.id, month]);

  useEffect(() => {
    reloadSettlements();
    setAccounts(null);
    fetchDistributorAccounts(dist.id).then(setAccounts).catch(() => setAccounts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dist.id]);

  const accountNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts ?? []) m.set(a.id, a.account_name ?? a.qbo_customer_id);
    return m;
  }, [accounts]);

  const totals = useMemo(() => {
    let cases = 0, unsettledFees = 0;
    for (const r of rows ?? []) {
      cases += Number(r.cases);
      if (!r.settlement_id) unsettledFees += Number(r.fee_amount ?? 0);
    }
    return { cases, unsettledFees };
  }, [rows]);

  function onSettlementChanged() {
    reloadSettlements();
    reloadDepletions();
  }

  return (
    <div>
      <SettlementsSection
        dist={dist}
        settlements={settlements}
        onChanged={onSettlementChanged}
      />

      <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.8, textTransform: 'uppercase', margin: '20px 0 8px' }}>
        Depletions
      </div>

      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="toolbar-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="toolbar-label" style={{ fontSize: 10, color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Month
          </span>
          <input type="month" style={inp()} value={month} onChange={(e) => setMonth(e.target.value)} />
          {month && (
            <button onClick={() => setMonth('')} style={{
              background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ac)', fontSize: 10.5,
            }}>Show all recent</button>
          )}
          <div className="toolbar-spacer" style={{ flex: 1 }} />
          <span style={{ color: 'var(--mt)', fontSize: 11 }}>
            {rows === null ? 'Loading…'
              : <>Loaded: <strong style={{ color: 'var(--tx)' }}>{fmtNum(totals.cases)}</strong> cases
                {' · '}un-settled fees <strong style={{ color: 'var(--tx)' }}>{fmtUsd(totals.unsettledFees)}</strong></>}
          </span>
        </div>
      </div>

      <div className="cd" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--sf)', borderBottom: '1px solid var(--bd)' }}>
              <Th>Delivered</Th>
              <Th>Account</Th>
              <Th>Item</Th>
              <Th style={{ textAlign: 'right' }}>Cases</Th>
              <Th style={{ textAlign: 'right' }}>Fee/case</Th>
              <Th style={{ textAlign: 'right' }}>Fee</Th>
              <Th>Reference</Th>
              <Th>Recorded by</Th>
            </tr>
          </thead>
          <tbody>
            {rows !== null && rows.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 14, color: 'var(--mt)', textAlign: 'center' }}>
                No depletions {month ? 'in this month' : 'recorded yet'}.
              </td></tr>
            )}
            {(rows ?? []).map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <Td>
                  {r.delivered_date}
                  {r.settlement_id && (
                    <span style={{ marginLeft: 6 }}><Chip label="settled" color="var(--gn)" /></span>
                  )}
                </Td>
                <Td><span style={{ fontWeight: 600 }}>
                  {r.account_id ? (accountNameById.get(r.account_id) ?? '…') : '—'}
                </span></Td>
                <Td>{itemNameById.get(r.qbo_item_id) ?? r.qbo_item_id}</Td>
                <Td style={{ textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(r.cases)}</Td>
                <Td style={{ textAlign: 'right', fontFamily: 'var(--ff-mono)', color: 'var(--mt)' }}>
                  {r.fee_per_case == null ? '—' : `$${Number(r.fee_per_case).toFixed(2)}`}
                </Td>
                <Td style={{ textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>
                  {r.fee_amount == null ? '—' : `$${Number(r.fee_amount).toFixed(2)}`}
                </Td>
                <Td><span style={{ color: 'var(--mt)' }}>{r.reference ?? '—'}</span></Td>
                <Td><span style={{ color: 'var(--mt)', fontSize: 10.5 }}>{r.recorded_by_email ?? '—'}</span></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Settlements ───────────────────────────────────────────────────────────

const SETTLEMENT_STATUS_COLOR: Record<string, string> = {
  open: 'var(--gn)',
  void: '#64748b',
};

function SettlementsSection({ dist, settlements, onChanged }: {
  dist: SubDistributor;
  settlements: SubDistributorSettlement[] | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const prev = useMemo(previousMonthRange, []);
  const [generating, setGenerating] = useState(false);
  const [start, setStart] = useState(prev.start);
  const [end, setEnd] = useState(prev.end);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SettlementCreateResult | null>(null);
  const [voiding, setVoiding] = useState<SubDistributorSettlement | null>(null);

  async function generate() {
    if (!start || !end) return;
    setBusy(true);
    try {
      const res = await createSettlement(dist.id, start, end, notes.trim() || null);
      setResult(res);
      setGenerating(false);
      setNotes('');
      toast.success(`Settlement ${res.reference} created`);
      onChanged();
    } catch (e) {
      // RPC errors are actionable ("link the QBO vendor first…") — verbatim.
      toast.error(rpcErrMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.8, textTransform: 'uppercase' }}>
          Settlements — the delivery fees they bill us
        </span>
        <div style={{ flex: 1 }} />
        {!generating && (
          <button onClick={() => { setResult(null); setGenerating(true); }} style={btnPrimary()}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Generate settlement
          </button>
        )}
      </div>

      {generating && (
        <div className="cd" style={{ padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 10 }}>
            Sweeps every un-settled fee-carrying depletion in the period into one settlement and creates
            the bill in Brixpense (nothing posts to QuickBooks until a human posts it there).
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <LField label="Period start">
              <input type="date" style={inp()} value={start} onChange={(e) => setStart(e.target.value)} />
            </LField>
            <LField label="Period end">
              <input type="date" style={inp()} value={end} onChange={(e) => setEnd(e.target.value)} />
            </LField>
            <div style={{ flex: '1 1 220px' }}>
              <LField label="Notes (optional)">
                <input style={{ ...inp(), width: '100%' }} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </LField>
            </div>
            <button onClick={() => setGenerating(false)} style={btnSecondary()}>Cancel</button>
            <button onClick={generate} disabled={busy || !start || !end} style={btnPrimary()}>
              {busy ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="cd" style={{
          padding: 12, marginBottom: 12,
          border: '1px solid var(--gn)', background: 'rgba(52,199,123,0.05)',
        }}>
          <div style={{ fontSize: 12, marginBottom: 4 }}>
            Settlement <code style={{ fontFamily: 'var(--ff-mono)', color: 'var(--ac)' }}>{result.reference}</code> created
            — {fmtNum(result.depletions)} depletion{result.depletions === 1 ? '' : 's'}, {fmtNum(result.total_cases)} cases,
            total fee <strong>{fmtUsd(Number(result.total_fee))}</strong> · vendor {result.vendor}.
          </div>
          <div style={{ fontSize: 11, color: 'var(--mt)' }}>
            Bill created in Brixpense — post it to QuickBooks from there:{' '}
            <a href="https://alamedapointbg.com/expense/" target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--ac)' }}>alamedapointbg.com/expense</a>
          </div>
        </div>
      )}

      <div className="cd" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--sf)', borderBottom: '1px solid var(--bd)' }}>
              <Th>Reference</Th>
              <Th>Period</Th>
              <Th style={{ textAlign: 'right' }}>Depletions</Th>
              <Th style={{ textAlign: 'right' }}>Cases</Th>
              <Th style={{ textAlign: 'right' }}>Total fee</Th>
              <Th>Status</Th>
              <Th>Created</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {settlements === null && (
              <tr><td colSpan={8} style={{ padding: 12, color: 'var(--mt)', textAlign: 'center' }}>Loading…</td></tr>
            )}
            {settlements !== null && settlements.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 12, color: 'var(--mt)', textAlign: 'center' }}>
                No settlements yet.
              </td></tr>
            )}
            {(settlements ?? []).map((s) => (
              <tr key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: s.status === 'void' ? 0.6 : 1 }}>
                <Td><code style={{ fontFamily: 'var(--ff-mono)', color: 'var(--ac)', fontSize: 11.5 }}>{s.reference ?? '—'}</code></Td>
                <Td>{s.period_start} → {s.period_end}</Td>
                <Td style={{ textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(s.depletion_count)}</Td>
                <Td style={{ textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtNum(s.total_cases)}</Td>
                <Td style={{ textAlign: 'right', fontFamily: 'var(--ff-mono)' }}>{fmtUsd(Number(s.total_fee))}</Td>
                <Td>
                  <Chip label={s.status} color={SETTLEMENT_STATUS_COLOR[s.status] ?? 'var(--mt)'} />
                  {s.status === 'void' && s.void_reason && (
                    <div style={{ fontSize: 9.5, color: 'var(--mt)', marginTop: 2 }}>{s.void_reason}</div>
                  )}
                </Td>
                <Td><span style={{ color: 'var(--mt)', fontSize: 11 }}>
                  {new Date(s.created_at).toLocaleDateString()}
                </span></Td>
                <Td>
                  {s.status === 'open' && (
                    <button onClick={() => setVoiding(s)} style={{
                      background: 'transparent', color: 'var(--rd)', border: '1px solid var(--rd)',
                      padding: '3px 8px', borderRadius: 4, fontSize: 10, cursor: 'pointer',
                    }}>Void</button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {voiding && (
        <VoidSettlementDialog
          settlement={voiding}
          onClose={() => setVoiding(null)}
          onVoided={() => { setVoiding(null); setResult(null); onChanged(); }}
        />
      )}
    </div>
  );
}

function VoidSettlementDialog({ settlement, onClose, onVoided }: {
  settlement: SubDistributorSettlement;
  onClose: () => void;
  onVoided: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await voidSettlement(settlement.id, reason.trim() || null);
      toast.success(`Settlement ${settlement.reference ?? ''} voided`);
      onVoided();
    } catch (e) {
      toast.error(rpcErrMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Void settlement ${settlement.reference ?? ''}`} onClose={onClose} maxWidth={460}>
      <div style={{ fontSize: 11.5, color: 'var(--mt)', marginBottom: 12 }}>
        Releases its {fmtNum(settlement.depletion_count)} depletions back to un-settled and archives the
        unposted Brixpense bill. Refused if the bill already posted to QuickBooks.
      </div>
      <LField label="Reason (optional)">
        <textarea rows={2} style={{ ...inp(), width: '100%', resize: 'vertical', minHeight: 40 }}
          value={reason} onChange={(e) => setReason(e.target.value)} />
      </LField>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button onClick={onClose} style={btnSecondary()}>Cancel</button>
        <button onClick={run} disabled={busy} style={{
          background: 'var(--rd)', color: '#fff', border: '1px solid var(--rd)',
          padding: '5px 11px', borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: 'pointer',
        }}>{busy ? 'Voiding…' : 'Void settlement'}</button>
      </div>
    </Modal>
  );
}
