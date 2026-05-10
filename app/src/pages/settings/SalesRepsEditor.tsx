import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, UserPlus } from 'lucide-react';
import {
  CustomerSalesRep,
  SalesRep,
  assignCustomerToRep,
  deleteSalesRep,
  fetchCustomerAssignments,
  fetchSalesReps,
  insertSalesRep,
  unassignCustomer,
  updateSalesRep,
} from '../../lib/salesReps';
import { fetchCustomerOptions, QboCustomerOption } from '../../lib/inventory';
import { useToast } from '../../lib/toast';

export function SalesRepsEditor() {
  const toast = useToast();
  const [reps, setReps] = useState<SalesRep[] | null>(null);
  const [customers, setCustomers] = useState<QboCustomerOption[]>([]);
  const [assignments, setAssignments] = useState<CustomerSalesRep[]>([]);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<{ name: string; email: string; initials: string }>({
    name: '', email: '', initials: '',
  });

  function load() {
    Promise.all([fetchSalesReps(), fetchCustomerOptions(), fetchCustomerAssignments()])
      .then(([rs, cs, asg]) => {
        setReps(rs);
        setCustomers(cs);
        setAssignments(asg);
      })
      .catch(() => { setReps([]); setCustomers([]); setAssignments([]); });
  }
  useEffect(load, []);

  const repById = useMemo(() => {
    const m = new Map<string, SalesRep>();
    for (const r of reps ?? []) m.set(r.id, r);
    return m;
  }, [reps]);

  const assignByCustomer = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of assignments) m.set(a.qbo_customer_id, a.rep_id);
    return m;
  }, [assignments]);

  const filteredCustomers = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = s
      ? customers.filter((c) => c.display_name.toLowerCase().includes(s))
      : customers;
    return list.slice(0, 200);
  }, [customers, search]);

  function addRep() {
    if (!draft.name.trim()) {
      toast.warn('Rep name is required');
      return;
    }
    insertSalesRep({
      name: draft.name.trim(),
      email: draft.email.trim() || null,
      initials: draft.initials.trim().toUpperCase() || null,
      is_active: true,
    })
      .then(() => {
        setCreating(false);
        setDraft({ name: '', email: '', initials: '' });
        toast.success('Added ' + draft.name.trim());
        load();
      })
      .catch((e) => toast.error('Failed: ' + (e as Error).message));
  }

  function patchRep(id: string, patch: Partial<SalesRep>) {
    updateSalesRep(id, patch)
      .then(load)
      .catch((e) => toast.error('Failed: ' + (e as Error).message));
  }

  function removeRep(rep: SalesRep) {
    if (!confirm(`Delete rep "${rep.name}"? Customer assignments will be cleared.`)) return;
    deleteSalesRep(rep.id)
      .then(() => { toast.success('Removed ' + rep.name); load(); })
      .catch((e) => toast.error('Failed: ' + (e as Error).message));
  }

  function assign(qbo_customer_id: string, rep_id: string) {
    if (!rep_id) {
      unassignCustomer(qbo_customer_id).then(load);
      return;
    }
    assignCustomerToRep(qbo_customer_id, rep_id)
      .then(() => { toast.success('Assigned'); load(); })
      .catch((e) => toast.error('Failed: ' + (e as Error).message));
  }

  if (!reps) return <div className="ld">Loading sales reps…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="cd" style={{ padding: 0 }}>
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--bd)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <div className="ct" style={{ margin: 0 }}>Sales reps</div>
            <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3 }}>
              {reps.length} rep{reps.length === 1 ? '' : 's'} · backed by ops.sales_reps
            </div>
          </div>
          {!creating ? (
            <button
              onClick={() => setCreating(true)}
              className="tb-btn tb-btn--primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Plus size={13} strokeWidth={2.4} aria-hidden="true" />
              <span>New rep</span>
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="text"
                placeholder="name"
                autoFocus
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="login-input"
                style={{ width: 160, padding: '6px 10px', fontSize: 12 }}
              />
              <input
                type="email"
                placeholder="email"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                className="login-input"
                style={{ width: 200, padding: '6px 10px', fontSize: 12 }}
              />
              <input
                type="text"
                placeholder="abc"
                maxLength={4}
                value={draft.initials}
                onChange={(e) => setDraft({ ...draft, initials: e.target.value })}
                className="login-input"
                style={{ width: 70, padding: '6px 10px', fontSize: 12, textTransform: 'uppercase' }}
              />
              <button onClick={addRep} className="tb-btn tb-btn--primary">Add</button>
              <button onClick={() => setCreating(false)} className="tb-btn">Cancel</button>
            </div>
          )}
        </div>

        {reps.length === 0 ? (
          <div className="ld">No reps yet. Click + New rep to add one.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Initials</th>
                <th>Name</th>
                <th>Email</th>
                <th>Active</th>
                <th style={{ textAlign: 'right' }}>Customers</th>
                <th style={{ textAlign: 'right' }} />
              </tr>
            </thead>
            <tbody>
              {reps.map((r) => {
                const count = assignments.filter((a) => a.rep_id === r.id).length;
                return (
                  <tr key={r.id}>
                    <td className="mn" style={{ fontWeight: 700, color: 'var(--ac)' }}>
                      {r.initials ?? r.name.split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase()}
                    </td>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td style={{ color: 'var(--mt)', fontFamily: 'var(--ff-mono)', fontSize: 11 }}>
                      {r.email ?? '—'}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={r.is_active}
                        onChange={(e) => patchRep(r.id, { is_active: e.target.checked })}
                        style={{ accentColor: 'var(--ac)' }}
                      />
                    </td>
                    <td className="mn" style={{ textAlign: 'right' }}>{count}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        onClick={() => removeRep(r)}
                        className="tb-btn"
                        style={{ color: 'var(--rd)', borderColor: 'var(--rd)' }}
                      >
                        <Trash2 size={12} strokeWidth={2.2} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="cd" style={{ padding: 0 }}>
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--bd)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <div>
            <div className="ct" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              <UserPlus size={12} strokeWidth={2.2} aria-hidden="true" /> Customer assignments
            </div>
            <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3 }}>
              Pick a rep for each customer. Empty = unassigned.
            </div>
          </div>
          <input
            type="text"
            placeholder="Search customer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="login-input"
            style={{ width: 240, padding: '6px 10px', fontSize: 12 }}
          />
        </div>

        {filteredCustomers.length === 0 ? (
          <div className="ld">{search ? 'No customers match.' : 'Loading customers…'}</div>
        ) : (
          <div style={{ maxHeight: '52vh', overflow: 'auto' }}>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th>Customer</th>
                  <th style={{ width: 220 }}>Rep</th>
                </tr>
              </thead>
              <tbody>
                {filteredCustomers.map((c) => {
                  const repId = assignByCustomer.get(c.qbo_customer_id) ?? '';
                  const rep = repId ? repById.get(repId) : null;
                  return (
                    <tr key={c.qbo_customer_id}>
                      <td style={{ fontWeight: 600, maxWidth: 460 }}>
                        {c.display_name}
                      </td>
                      <td>
                        <select
                          value={repId}
                          onChange={(e) => assign(c.qbo_customer_id, e.target.value)}
                          className="tb-select"
                          style={{
                            width: '100%',
                            color: rep ? 'var(--ac)' : 'var(--mt)',
                            fontWeight: rep ? 600 : 400,
                          }}
                        >
                          <option value="">— unassigned —</option>
                          {(reps ?? []).filter((r) => r.is_active || r.id === repId).map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {customers.length > filteredCustomers.length && (
          <div
            style={{
              padding: '8px 16px',
              fontSize: 10,
              color: 'var(--mt)',
              borderTop: '1px solid var(--bd)',
            }}
          >
            Showing first {filteredCustomers.length} of {customers.length}. Type to filter.
          </div>
        )}
      </div>
    </div>
  );
}
