import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  QboCustomerLite,
  SubDistributor,
  SubDistributorAccount,
  addDistributorAccount,
  fetchDistributorAccounts,
  updateDistributorAccount,
} from '../../lib/subDistributors';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { Chip, errMsg, QboCustomerSearch, Td, Th } from './common';

export function DistributorAccountsTab({ dist }: { dist: SubDistributor }) {
  const toast = useToast();
  const [rows, setRows] = useState<SubDistributorAccount[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Add form
  const [picked, setPicked] = useState<QboCustomerLite | null>(null);
  const [chain, setChain] = useState('');

  function reload() {
    setRows(null);
    fetchDistributorAccounts(dist.id).then(setRows).catch((e) => { setRows([]); toast.error(errMsg(e)); });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [dist.id]);

  async function add() {
    if (!picked) return;
    setBusy(true);
    try {
      await addDistributorAccount({
        sub_distributor_id: dist.id,
        qbo_customer_id: picked.qbo_customer_id,
        account_name: picked.display_name,
        chain: chain.trim() || null,
      });
      toast.success(`Added ${picked.display_name}`);
      setPicked(null);
      setChain('');
      reload();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function toggleActive(a: SubDistributorAccount) {
    setBusy(true);
    try {
      await updateDistributorAccount(a.id, { is_active: !a.is_active });
      toast.success(a.is_active ? 'Deactivated' : 'Reactivated');
      reload();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="cd" style={{
        padding: 10, marginBottom: 14, fontSize: 11, color: 'var(--mt)',
        border: '1px solid var(--bd)', background: 'rgba(91,181,240,0.04)',
      }}>
        The chain stores this partner delivers to. Depletions are recorded against these accounts.
      </div>

      {/* Add form */}
      <div className="cd" style={{ padding: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px' }}>
            <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
              QBO customer (the store)
            </div>
            <QboCustomerSearch
              value={picked?.qbo_customer_id ?? null}
              valueLabel={picked?.display_name ?? null}
              onPick={setPicked}
              placeholder="Search e.g. THE MELT (STANFORD)…"
            />
          </div>
          <div style={{ flex: '0 1 160px' }}>
            <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>Chain</div>
            <input style={{ ...inp(), width: '100%' }} value={chain} placeholder="The Melt / Starbird"
              onChange={(e) => setChain(e.target.value)} />
          </div>
          <button onClick={add} disabled={busy || !picked} style={btnPrimary()}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Add account
          </button>
        </div>
      </div>

      <div className="cd" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--sf)', borderBottom: '1px solid var(--bd)' }}>
              <Th>Account</Th>
              <Th>Chain</Th>
              <Th>QBO #</Th>
              <Th>Status</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {rows !== null && rows.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 14, color: 'var(--mt)', textAlign: 'center' }}>
                No serviced accounts yet.
              </td></tr>
            )}
            {(rows ?? []).map((a) => (
              <tr key={a.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: a.is_active ? 1 : 0.55 }}>
                <Td><span style={{ fontWeight: 600 }}>{a.account_name ?? '—'}</span></Td>
                <Td><span style={{ color: 'var(--mt)' }}>{a.chain ?? '—'}</span></Td>
                <Td><code style={{ fontFamily: 'var(--ff-mono)', color: 'var(--mt)', fontSize: 10.5 }}>
                  {a.qbo_customer_id}
                </code></Td>
                <Td><Chip label={a.is_active ? 'active' : 'inactive'} color={a.is_active ? 'var(--gn)' : 'var(--mt)'} /></Td>
                <Td>
                  <button onClick={() => toggleActive(a)} disabled={busy} style={btnSecondary()}>
                    {a.is_active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
