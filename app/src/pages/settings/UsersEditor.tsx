import { useEffect, useState } from 'react';
import { PrintableTable } from '../../components/PrintableTable';
import {
  AdminUser,
  UserRole,
  adminUsersDelete,
  adminUsersInvite,
  adminUsersList,
  adminUsersRoles,
  adminUsersUpdateRole,
} from '../../lib/settings';
import { btnDanger, btnPrimary, inp } from '../../lib/styles';

// Calls the admin-users Supabase Edge Function for list / roles / invite /
// update_role / delete. Service-role-gated server-side.

export function UsersEditor() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [roles, setRoles] = useState<UserRole[]>([]);
  const [msg, setMsg] = useState<string>('');
  const [draft, setDraft] = useState<{ email: string; name: string; role: string }>({
    email: '',
    name: '',
    role: 'viewer',
  });

  function load() {
    Promise.all([adminUsersList(), adminUsersRoles()])
      .then(([listRes, rolesRes]) => {
        if (listRes.ok) setUsers(listRes.users ?? []);
        else { setUsers([]); setMsg('list error: ' + (listRes.error ?? 'unknown')); }
        if (rolesRes.ok) setRoles(rolesRes.roles ?? []);
      })
      .catch((e) => {
        setUsers([]);
        setMsg('admin-users edge function unreachable: ' + (e as Error).message);
      });
  }
  useEffect(load, []);

  function invite() {
    if (!draft.email) return alert('email required');
    setMsg('inviting…');
    adminUsersInvite(draft).then((j) => {
      if (j.ok) {
        setMsg('invited ' + draft.email);
        setDraft({ email: '', name: '', role: 'viewer' });
        load();
      } else {
        setMsg('invite error: ' + (j.error ?? 'unknown'));
      }
    });
  }

  function setUserRole(id: string, role: string) {
    adminUsersUpdateRole(id, role).then((j) => {
      if (j.ok) load();
      else setMsg('role update error: ' + (j.error ?? 'unknown'));
    });
  }

  function deleteUser(id: string, email: string) {
    if (!confirm('Delete user ' + email + '? Cannot be undone.')) return;
    adminUsersDelete(id).then((j) => {
      if (j.ok) load();
      else setMsg('delete error: ' + (j.error ?? 'unknown'));
    });
  }

  if (users === null) return <div className="ld">{msg || 'Loading…'}</div>;

  return (
    <div>
      {msg && (
        <div
          style={{
            padding: '8px 12px',
            marginBottom: 10,
            fontSize: 11,
            color: 'var(--mt)',
            background: 'var(--sf2)',
            border: '1px solid var(--bd)',
            borderRadius: 4,
          }}
        >
          {msg}
        </div>
      )}

      <div className="cd" style={{ padding: 0, marginBottom: 10 }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
          <div className="ct" style={{ margin: 0 }}>INVITE NEW USER</div>
        </div>
        <div style={{ padding: '12px 14px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="email"
            placeholder="email@…"
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            style={{ ...inp(), flex: '1 1 220px', minWidth: 200 }}
          />
          <input
            type="text"
            placeholder="Full name (optional)"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={{ ...inp(), flex: '1 1 180px', minWidth: 160 }}
          />
          <select
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            style={inp()}
          >
            {roles.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <button onClick={invite} style={btnPrimary()}>SEND INVITE</button>
        </div>
      </div>

      <div className="cd" style={{ padding: 0 }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
          <div className="ct" style={{ margin: 0 }}>USERS — {users.length}</div>
        </div>
        <PrintableTable>
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Last sign-in</th>
                <th>Confirmed?</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 600 }}>{u.email}</td>
                  <td style={{ fontSize: 11, color: 'var(--mt)' }}>{u.name || '—'}</td>
                  <td>
                    <select
                      value={u.role || 'viewer'}
                      onChange={(e) => setUserRole(u.id, e.target.value)}
                      style={inp()}
                    >
                      {roles.map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="mn" style={{ fontSize: 11, color: 'var(--mt)' }}>
                    {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString() : '—'}
                  </td>
                  <td style={{ fontSize: 11, color: u.confirmed_at ? 'var(--gn)' : 'var(--am)' }}>
                    {u.confirmed_at ? '✓' : 'pending'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button onClick={() => deleteUser(u.id, u.email)} style={btnDanger()}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PrintableTable>
      </div>
    </div>
  );
}
