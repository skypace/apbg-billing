import { useEffect, useMemo, useState } from 'react';
import {
  SubDistributor,
  SubDistributorAccount,
  SubDistributorDepletion,
  fetchDepletions,
  fetchDistributorAccounts,
} from '../../lib/subDistributors';
import { useToast } from '../../lib/toast';
import { inp } from '../../lib/styles';
import { fmtNum } from '../../lib/formatters';
import { errMsg, Td, Th } from './common';

interface Props {
  dist: SubDistributor;
  itemNameById: Map<string, string>;
}

export function DistributorDepletionsTab({ dist, itemNameById }: Props) {
  const toast = useToast();
  const [rows, setRows] = useState<SubDistributorDepletion[] | null>(null);
  const [accounts, setAccounts] = useState<SubDistributorAccount[] | null>(null);
  const [month, setMonth] = useState(''); // 'YYYY-MM' or '' = all recent

  useEffect(() => {
    setRows(null);
    fetchDepletions(dist.id, month || null)
      .then(setRows)
      .catch((e) => { setRows([]); toast.error(errMsg(e)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dist.id, month]);

  useEffect(() => {
    setAccounts(null);
    fetchDistributorAccounts(dist.id).then(setAccounts).catch(() => setAccounts([]));
  }, [dist.id]);

  const accountNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts ?? []) m.set(a.id, a.account_name ?? a.qbo_customer_id);
    return m;
  }, [accounts]);

  const totals = useMemo(() => {
    let cases = 0, fees = 0;
    for (const r of rows ?? []) {
      cases += Number(r.cases);
      fees += Number(r.fee_amount ?? 0);
    }
    return { cases, fees };
  }, [rows]);

  return (
    <div>
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
                {' · '}delivery fees <strong style={{ color: 'var(--tx)' }}>
                  {totals.fees > 0 ? `$${totals.fees.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '$0.00'}
                </strong></>}
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
                <Td>{r.delivered_date}</Td>
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
