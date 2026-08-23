import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  DistributorUserRole,
  SubDistributor,
  SubDistributorUser,
  addDistributorUser,
  fetchDistributorUsers,
  updateDistributorUser,
} from '../../lib/subDistributors';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { Chip, errMsg, Td, Th } from './common';

export function DistributorUsersTab({ dist }: { dist: SubDistributor }) {
  const toast = useToast();
  const [rows, setRows] = useState<SubDistributorUser[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<DistributorUserRole>('member');
  const [busy, setBusy] = useState(false);

  function reload() {
    setRows(null);
    fetchDistributorUsers(dist.id).then(setRows).catch((e) => { setRows([]); toast.error(errMsg(e)); });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [dist.id]);

  async function add() {
    if (!email.trim()) return;
    setBusy(true);
    try {
      await addDistributorUser(dist.id, email, role);
      toast.success(`Added ${email.trim()}`);
      setEmail('');
      setRole('member');
      reload();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function toggleActive(u: SubDistributorUser) {
    setBusy(true);
    try {
      await updateDistributorUser(u.id, { is_active: !u.is_active });
      toast.success(u.is_active ? `Deactivated ${u.email}` : `Activated ${u.email}`);
      reload();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  }

  async function setUserRole(u: SubDistributorUser, r: DistributorUserRole) {
    setBusy(true);
    try {
      await updateDistributorUser(u.id, { role: r });
      toast.success('Role updated');
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
        Provision the login itself from the gateway admin console; this list only grants portal access.
      </div>

      {/* Add form */}
      <div className="cd" style={{ padding: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px' }}>
            <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>Email</div>
            <input style={{ ...inp(), width: '100%' }} value={email} placeholder="person@distributor.com"
              onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>Role</div>
            <select style={inp()} value={role} onChange={(e) => setRole(e.target.value as DistributorUserRole)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button onClick={add} disabled={busy || !email.trim()} style={btnPrimary()}>
            <Plus size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Add user
          </button>
        </div>
      </div>

      <div className="cd" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--sf)', borderBottom: '1px solid var(--bd)' }}>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th>Added</Th>
              <Th> </Th>
            </tr>
          </thead>
          <tbody>
            {rows !== null && rows.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 14, color: 'var(--mt)', textAlign: 'center' }}>
                No portal users yet.
              </td></tr>
            )}
            {(rows ?? []).map((u) => (
              <tr key={u.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: u.is_active ? 1 : 0.55 }}>
                <Td><span style={{ fontWeight: 600 }}>{u.email}</span></Td>
                <Td>
                  <select style={inp()} value={u.role} disabled={busy}
                    onChange={(e) => setUserRole(u, e.target.value as DistributorUserRole)}>
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </Td>
                <Td><Chip label={u.is_active ? 'active' : 'inactive'} color={u.is_active ? 'var(--gn)' : 'var(--mt)'} /></Td>
                <Td><span style={{ color: 'var(--mt)', fontSize: 11 }}>
                  {new Date(u.created_at).toLocaleDateString()}
                </span></Td>
                <Td>
                  <button onClick={() => toggleActive(u)} disabled={busy} style={btnSecondary()}>
                    {u.is_active ? 'Deactivate' : 'Activate'}
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
