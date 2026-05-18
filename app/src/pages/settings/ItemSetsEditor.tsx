import { useEffect, useState } from 'react';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../../lib/styles';
import {
  ItemSet,
  ItemSetMember,
  addItemSetMember,
  deleteItemSet,
  fetchItemSetMembers,
  fetchItemSets,
  insertItemSet,
  removeItemSetMember,
} from '../../lib/settings';
import { fetchItemOptions, QboItemOption } from '../../lib/plans';

export function ItemSetsEditor() {
  const [sets, setSets] = useState<ItemSet[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [members, setMembers] = useState<ItemSetMember[]>([]);
  const [items, setItems] = useState<QboItemOption[]>([]);

  function loadSets() {
    fetchItemSets().then(setSets).catch(() => setSets([]));
  }
  function loadMembers(code: string | null) {
    if (!code) { setMembers([]); return; }
    fetchItemSetMembers(code).then(setMembers).catch(() => setMembers([]));
  }
  useEffect(loadSets, []);
  useEffect(() => loadMembers(active), [active]);
  useEffect(() => {
    fetchItemOptions().then(setItems).catch(() => setItems([]));
  }, []);

  function createSet() {
    const code = prompt('Set code (lowercase, no spaces, e.g. "fountain_core"):');
    if (!code) return;
    const label = prompt('Display name:', code) || code;
    insertItemSet({ set_code: code.trim(), label: label.trim(), is_active: true })
      .then(() => { loadSets(); setActive(code.trim()); });
  }

  function delSet(code: string) {
    if (!confirm('Delete set "' + code + '"? Members will be removed too.')) return;
    deleteItemSet(code).then(() => {
      if (active === code) setActive(null);
      loadSets();
    });
  }

  function addMember(it: QboItemOption) {
    if (!active) return;
    addItemSetMember({
      set_code: active,
      qbo_item_id: it.qbo_item_id,
      item_name: it.name || it.fully_qualified_name || undefined,
    }).then(() => loadMembers(active));
  }

  function removeMember(qboItemId: string) {
    if (!active) return;
    removeItemSetMember(active, qboItemId).then(() => loadMembers(active));
  }

  if (!sets) return <div className="ld">Loading…</div>;

  const availableItems = items.filter(
    (it) => !members.some((m) => m.qbo_item_id === it.qbo_item_id),
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12 }}>
      <div className="cd" style={{ padding: 0 }}>
        <div
          style={{
            padding: '12px 14px',
            borderBottom: '1px solid var(--bd)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div className="ct" style={{ margin: 0 }}>SETS — {sets.length}</div>
          <button onClick={createSet} style={btnPrimary()}>+ NEW</button>
        </div>
        {sets.length === 0 ? (
          <div className="ld">Define sets like "Fountain Core" or "Cans Lineup".</div>
        ) : (
          sets.map((s) => {
            const on = active === s.set_code;
            return (
              <div
                key={s.set_code}
                onClick={() => setActive(s.set_code)}
                style={{
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--bd)',
                  cursor: 'pointer',
                  background: on ? 'var(--sf2)' : 'transparent',
                  borderLeft: on ? '3px solid var(--ac)' : '3px solid transparent',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{s.label}</div>
                    <div style={{ fontSize: 10, color: 'var(--mt)', fontFamily: 'monospace' }}>{s.set_code}</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); delSet(s.set_code); }}
                    style={btnDanger()}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {!active ? (
        <div className="cd" style={{ padding: 16, color: 'var(--mt)', fontSize: 12 }}>
          Pick or create a set.
        </div>
      ) : (
        <div className="cd" style={{ padding: 0 }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bd)' }}>
            <div className="ct" style={{ margin: 0 }}>
              MEMBERS OF "{active}" — {members.length}
            </div>
          </div>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)' }}>
            <select
              style={{ ...inp(), width: '100%', maxWidth: 600 }}
              defaultValue=""
              onChange={(e) => {
                const it = items.find((x) => x.qbo_item_id === e.target.value);
                if (it) { addMember(it); e.target.value = ''; }
              }}
            >
              <option value="">+ add an item to this set</option>
              {availableItems.map((it) => (
                <option key={it.qbo_item_id} value={it.qbo_item_id}>
                  {it.name || it.fully_qualified_name}
                </option>
              ))}
            </select>
          </div>
          {members.length === 0 ? (
            <div className="ld">No members yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.qbo_item_id}>
                    <td>{m.item_name || m.qbo_item_id}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button onClick={() => removeMember(m.qbo_item_id)} style={btnDanger()}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
