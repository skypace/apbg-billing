import { useEffect, useState } from 'react';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../../lib/styles';
import {
  SalesRep,
  deleteSalesRep,
  fetchSalesReps,
  insertSalesRep,
  updateSalesRep,
} from '../../lib/settings';
import { SB_KEY, SB_URL, _sbToken } from '../../lib/supabase';

export function SalesRepsEditor() {
  const [rows, setRows] = useState<SalesRep[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ rep_code: '', name: '', email: '' });
  const [pushMsg, setPushMsg] = useState('');

  function load() {
    fetchSalesReps().then(setRows).catch(() => setRows([]));
  }
  useEffect(load, []);

  function add() {
    if (!draft.rep_code.trim() || !draft.name.trim()) return alert('Code + name required');
    insertSalesRep({
      rep_code: draft.rep_code.trim(),
      name: draft.name.trim(),
      email: draft.email.trim() || null,
      sort_order: 0,
      is_active: true,
    }).then(() => {
      setDraft({ rep_code: '', name: '', email: '' });
      setCreating(false);
      load();
    });
  }

  async function pushReps(commit: boolean) {
    setPushMsg(commit ? 'pushing to QBO…' : 'dry-run…');
    try {
      const token = await _sbToken();
      const res = await fetch(SB_URL + '/functions/v1/push-qbo-sales-rep', {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ commit }),
      });
      const j = await res.json();
      if (!j.ok) { setPushMsg('FAIL: ' + (j.error ?? 'unknown')); return; }
      const s = j.summary || {};
      setPushMsg(
        (commit ? 'COMMITTED ' : 'DRY-RUN ') +
        'updated=' + (s.updated || 0) +
        ' would_update=' + (s.would_update || 0) +
        ' already_correct=' + (s.already_correct || 0) +
        ' skipped_no_field=' + (s.skipped_no_field?.length || 0) +
        ' errors=' + (s.errors?.length || 0),
      );
    } catch (e) {
      setPushMsg('ERROR: ' + (e as Error).message);
    }
  }

  if (!rows) return <div className="ld">Loading…</div>;

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <div>
          <div className="ct" style={{ margin: 0 }}>SALES REPS</div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3 }}>
            Reps are assignable to customers via the M2M editor (legacy /sales/ for now).
            Push reps to QBO writes the primary rep to a Customer "Sales Rep" custom field.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!creating && <button onClick={() => setCreating(true)} style={btnPrimary()}>+ NEW REP</button>}
          <button onClick={() => pushReps(false)} style={btnSecondary()}>PUSH TO QBO (DRY)</button>
          <button onClick={() => pushReps(true)} style={btnPrimary()}>PUSH TO QBO (COMMIT)</button>
        </div>
      </div>

      {pushMsg && (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--mt)', borderBottom: '1px solid var(--bd)', background: 'var(--sf2)' }}>
          {pushMsg}
        </div>
      )}

      {creating && (
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="text" placeholder="rep_code" value={draft.rep_code}
            onChange={(e) => setDraft({ ...draft, rep_code: e.target.value })}
            style={{ ...inp(), width: 120 }} />
          <input type="text" placeholder="full name" value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={{ ...inp(), width: 220 }} />
          <input type="email" placeholder="email (optional)" value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            style={{ ...inp(), width: 240 }} />
          <button onClick={add} style={btnPrimary()}>ADD</button>
          <button onClick={() => setCreating(false)} style={btnSecondary()}>CANCEL</button>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="ld">No reps yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Email</th>
              <th style={{ textAlign: 'right' }}>Sort</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rep_code}>
                <td className="mn" style={{ fontWeight: 600 }}>{r.rep_code}</td>
                <td>
                  <input type="text" defaultValue={r.name}
                    onBlur={(e) => { if (e.target.value !== r.name) updateSalesRep(r.rep_code, { name: e.target.value }).then(load); }}
                    style={{ ...inp(), width: '100%', maxWidth: 240 }} />
                </td>
                <td>
                  <input type="email" defaultValue={r.email ?? ''}
                    onBlur={(e) => {
                      const v = e.target.value || null;
                      if ((v ?? '') !== (r.email ?? '')) updateSalesRep(r.rep_code, { email: v }).then(load);
                    }}
                    style={{ ...inp(), width: '100%', maxWidth: 240 }} />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input type="number" defaultValue={r.sort_order ?? 0}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== (r.sort_order ?? 0)) updateSalesRep(r.rep_code, { sort_order: v }).then(load);
                    }}
                    style={{ ...inp(), width: 60, textAlign: 'right' }} />
                </td>
                <td>
                  <input type="checkbox" checked={r.is_active}
                    onChange={(e) => updateSalesRep(r.rep_code, { is_active: e.target.checked }).then(load)} />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => {
                    if (confirm('Delete rep ' + r.name + '?')) deleteSalesRep(r.rep_code).then(load);
                  }} style={btnDanger()}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
