import { useEffect, useMemo, useState } from 'react';
import { PrintableTable } from '../../components/PrintableTable';
import { UploadCloud } from 'lucide-react';
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
import { pushQboSalesRepDryRun, pushQboSalesRepCommit } from '../../lib/settings';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SalesRepsEditor() {
  const toast = useToast();
  const [reps, setReps] = useState<SalesRep[] | null>(null);
  const [customers, setCustomers] = useState<QboCustomerOption[]>([]);
  const [assignments, setAssignments] = useState<CustomerSalesRep[]>([]);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<{ rep_code: string; name: string; sort_order: number }>({
    rep_code: '',
    name: '',
    sort_order: 100,
  });
  const [pushingReps, setPushingReps] = useState(false);

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

  const repByCode = useMemo(() => {
    const m = new Map<string, SalesRep>();
    for (const r of reps ?? []) m.set(r.rep_code, r);
    return m;
  }, [reps]);

  const assignByCustomer = useMemo(() => {
    const m = new Map<string, string>();
    // Pick the primary rep per customer; fall back to any rep if none flagged.
    for (const a of assignments) {
      const existing = m.get(a.qbo_customer_id);
      if (!existing || a.is_primary) m.set(a.qbo_customer_id, a.rep_code);
    }
    return m;
  }, [assignments]);

  const filteredCustomers = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = s
      ? customers.filter((c) => c.display_name.toLowerCase().includes(s))
      : customers;
    return list.slice(0, 200);
  }, [customers, search]);

  async function pushToQbo() {
    setPushingReps(true);
    try {
      const dry: any = await pushQboSalesRepDryRun();
      const s = dry?.summary;
      const wouldUpdate = s?.would_update ?? 0;
      const noField = s?.skipped_no_field?.length ?? 0;
      if (wouldUpdate === 0 && noField === 0) {
        toast.info('QBO already in sync — every customer has the correct rep.');
        setPushingReps(false);
        return;
      }
      const lines = [];
      if (wouldUpdate > 0) lines.push(wouldUpdate + ' customer(s) need the rep updated in QBO');
      if (noField > 0) lines.push(noField + " customer(s) skipped: 'Sales Rep' custom field not attached");
      const ok = confirm(
        "Push sales-rep assignments to QuickBooks?\n\n"
        + lines.join('\n')
        + "\n\nQBO custom field name must be 'Sales Rep' (Settings → Custom fields → All Customers).",
      );
      if (!ok) { setPushingReps(false); return; }
      const result: any = await pushQboSalesRepCommit();
      const updated = result?.summary?.updated ?? 0;
      toast.success(`Updated ${updated} customer rep assignment(s) in QBO.`);
    } catch (e: unknown) {
      toast.error('QBO push failed: ' + errMsg(e));
    } finally {
      setPushingReps(false);
    }
  }

  function addRep() {
    const code = draft.rep_code.trim();
    const name = draft.name.trim();
    if (!code) {
      toast.warn('Rep code is required (e.g. SP, JM)');
      return;
    }
    if (!name) {
      toast.warn('Rep name is required');
      return;
    }
    insertSalesRep({
      rep_code: code,
      name,
      sort_order: Number(draft.sort_order) || 100,
      is_active: true,
    })
      .then(() => {
        setCreating(false);
        setDraft({ rep_code: '', name: '', sort_order: 100 });
        toast.success('Added ' + name + ' (' + code + ')');
        load();
      })
      .catch((e: unknown) => toast.error('Failed: ' + errMsg(e)));
  }

  function patchRep(rep_code: string, patch: Partial<SalesRep>) {
    updateSalesRep(rep_code, patch)
      .then(load)
      .catch((e: unknown) => toast.error('Failed: ' + errMsg(e)));
  }

  function removeRep(rep: SalesRep) {
    if (!confirm(`Delete rep "${rep.name}" (${rep.rep_code})? Customer assignments will be cleared.`)) return;
    deleteSalesRep(rep.rep_code)
      .then(() => { toast.success('Removed ' + rep.name); load(); })
      .catch((e: unknown) => toast.error('Failed: ' + errMsg(e)));
  }

  function assign(qbo_customer_id: string, rep_code: string) {
    if (!rep_code) {
      unassignCustomer(qbo_customer_id).then(load);
      return;
    }
    assignCustomerToRep(qbo_customer_id, rep_code)
      .then(() => { toast.success('Assigned'); load(); })
      .catch((e: unknown) => toast.error('Failed: ' + errMsg(e)));
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
            <div style={{ display: 'inline-flex', gap: 6 }}>
              <button
                onClick={pushToQbo}
                disabled={pushingReps}
                className="tb-btn"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                title="Push every customer's primary sales rep to their QBO 'Sales Rep' custom field (dry-run first, then confirm)."
              >
                <UploadCloud size={13} strokeWidth={2.4} aria-hidden="true" />
                <span>{pushingReps ? 'Pushing…' : 'Push to QBO'}</span>
              </button>
              <button
                onClick={() => setCreating(true)}
                className="tb-btn tb-btn--primary"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Plus size={13} strokeWidth={2.4} aria-hidden="true" />
                <span>New rep</span>
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="text"
                placeholder="code (e.g. SP)"
                autoFocus
                value={draft.rep_code}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, rep_code: e.target.value.toUpperCase() })}
                className="login-input"
                style={{ width: 110, padding: '6px 10px', fontSize: 12, textTransform: 'uppercase' }}
                maxLength={8}
              />
              <input
                type="text"
                placeholder="full name"
                value={draft.name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, name: e.target.value })}
                className="login-input"
                style={{ width: 220, padding: '6px 10px', fontSize: 12 }}
              />
              <input
                type="number"
                placeholder="sort"
                value={draft.sort_order}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, sort_order: Number(e.target.value) || 100 })}
                className="login-input"
                style={{ width: 70, padding: '6px 10px', fontSize: 12 }}
              />
              <button onClick={addRep} className="tb-btn tb-btn--primary">Add</button>
              <button onClick={() => setCreating(false)} className="tb-btn">Cancel</button>
            </div>
          )}
        </div>

        {reps.length === 0 ? (
          <div className="ld">No reps yet. Click + New rep to add one.</div>
        ) : (
          <PrintableTable>
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th style={{ textAlign: 'right' }}>Sort</th>
                  <th>Active</th>
                  <th style={{ textAlign: 'right' }}>Customers</th>
                  <th style={{ textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {reps.map((r) => {
                  const count = assignments.filter((a) => a.rep_code === r.rep_code).length;
                  return (
                    <tr key={r.rep_code}>
                      <td className="mn" style={{ fontWeight: 700, color: 'var(--ac)' }}>
                        {r.rep_code}
                      </td>
                      <td style={{ fontWeight: 600 }}>
                        <input
                          type="text"
                          defaultValue={r.name}
                          onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
                            if (e.target.value.trim() !== r.name) {
                              patchRep(r.rep_code, { name: e.target.value.trim() });
                            }
                          }}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--tx)',
                            fontWeight: 600,
                            fontSize: 12,
                            width: '100%',
                            fontFamily: 'inherit',
                          }}
                        />
                      </td>
                      <td className="mn" style={{ textAlign: 'right' }}>
                        <input
                          type="number"
                          defaultValue={r.sort_order}
                          onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
                            const v = Number(e.target.value) || 100;
                            if (v !== r.sort_order) patchRep(r.rep_code, { sort_order: v });
                          }}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--mt)',
                            fontSize: 11,
                            width: 50,
                            textAlign: 'right',
                            fontFamily: 'var(--ff-mono)',
                          }}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={r.is_active}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => patchRep(r.rep_code, { is_active: e.target.checked })}
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
          </PrintableTable>
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
              Pick a rep for each customer. Empty = unassigned. Each customer's primary rep
              flows into v_sales_lines.sales_reps for filtering and reports.
            </div>
          </div>
          <input
            type="text"
            placeholder="Search customer…"
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
            className="login-input"
            style={{ width: 240, padding: '6px 10px', fontSize: 12 }}
          />
        </div>

        {filteredCustomers.length === 0 ? (
          <div className="ld">{search ? 'No customers match.' : 'Loading customers…'}</div>
        ) : (
          <div style={{ maxHeight: '52vh', overflow: 'auto' }}>
            <PrintableTable>
              <table>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                  <tr>
                    <th>Customer</th>
                    <th style={{ width: 220 }}>Rep</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.map((c) => {
                    const code = assignByCustomer.get(c.qbo_customer_id) ?? '';
                    const rep = code ? repByCode.get(code) : null;
                    return (
                      <tr key={c.qbo_customer_id}>
                        <td style={{ fontWeight: 600, maxWidth: 460 }}>
                          {c.display_name}
                        </td>
                        <td>
                          <select
                            value={code}
                            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => assign(c.qbo_customer_id, e.target.value)}
                            className="tb-select"
                            style={{
                              width: '100%',
                              color: rep ? 'var(--ac)' : 'var(--mt)',
                              fontWeight: rep ? 600 : 400,
                            }}
                          >
                            <option value="">— unassigned —</option>
                            {(reps ?? [])
                              .filter((r) => r.is_active || r.rep_code === code)
                              .map((r) => (
                                <option key={r.rep_code} value={r.rep_code}>
                                  {r.rep_code} · {r.name}
                                </option>
                              ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </PrintableTable>
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
