import { useEffect, useState } from 'react';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../../lib/styles';

// Generic 2-column code/label/sort/active editor used by Channels and
// Segments. Both tables have the same shape, so reuse keeps the
// Settings page lean.

interface Row {
  code: string;
  label: string;
  sort_order: number | null;
  is_active: boolean;
}

interface Props {
  title: string;
  description: string;
  fetchAll: () => Promise<{ [k: string]: any }[]>;
  insert: (row: { code: string; label: string; sort_order: number; is_active: boolean }) => Promise<unknown>;
  update: (code: string, patch: Partial<Row>) => Promise<unknown>;
  remove: (code: string) => Promise<unknown>;
  codeKey: string;
  codeLabel?: string;
}

export function TaxonomyEditor({ title, description, fetchAll, insert, update, remove, codeKey, codeLabel = 'Code' }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ code: '', label: '', sort_order: 0 });

  function load() {
    fetchAll()
      .then((rs) =>
        setRows(
          rs.map((r) => ({
            code: r[codeKey],
            label: r.label,
            sort_order: r.sort_order,
            is_active: r.is_active,
          })),
        ),
      )
      .catch(() => setRows([]));
  }
  useEffect(load, []);

  function add() {
    if (!draft.code.trim() || !draft.label.trim()) return alert('Code and label required');
    insert({
      code: draft.code.trim(),
      label: draft.label.trim(),
      sort_order: Number(draft.sort_order) || 0,
      is_active: true,
    }).then(() => {
      setDraft({ code: '', label: '', sort_order: 0 });
      setCreating(false);
      load();
    });
  }

  function patch(code: string, patchObj: Partial<Row>) {
    update(code, patchObj).then(load);
  }

  function del(code: string, label: string) {
    if (!confirm(`Delete ${label}? Customers/items currently classified here will be unlinked.`)) return;
    remove(code).then(load);
  }

  if (!rows) return <div className="ld">Loading…</div>;

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div className="ct" style={{ margin: 0 }}>{title}</div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3 }}>{description}</div>
        </div>
        {!creating && (
          <button onClick={() => setCreating(true)} style={btnPrimary()}>+ NEW</button>
        )}
      </div>

      {creating && (
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--bd)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="text"
            placeholder={codeLabel.toLowerCase()}
            value={draft.code}
            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            style={{ ...inp(), width: 140 }}
          />
          <input
            type="text"
            placeholder="display label"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            style={{ ...inp(), width: 240 }}
          />
          <input
            type="number"
            placeholder="sort"
            value={draft.sort_order}
            onChange={(e) => setDraft({ ...draft, sort_order: Number(e.target.value) })}
            style={{ ...inp(), width: 70 }}
          />
          <button onClick={add} style={btnPrimary()}>ADD</button>
          <button onClick={() => setCreating(false)} style={btnSecondary()}>CANCEL</button>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="ld">No entries yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{codeLabel}</th>
              <th>Label</th>
              <th style={{ textAlign: 'right' }}>Sort</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <td className="mn" style={{ fontWeight: 600 }}>{r.code}</td>
                <td>
                  <input
                    type="text"
                    defaultValue={r.label}
                    onBlur={(e) => { if (e.target.value !== r.label) patch(r.code, { label: e.target.value }); }}
                    style={{ ...inp(), width: '100%', maxWidth: 320 }}
                  />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <input
                    type="number"
                    defaultValue={r.sort_order ?? 0}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== (r.sort_order ?? 0)) patch(r.code, { sort_order: v });
                    }}
                    style={{ ...inp(), width: 60, textAlign: 'right' }}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.is_active}
                    onChange={(e) => patch(r.code, { is_active: e.target.checked })}
                  />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => del(r.code, r.label)} style={btnDanger()}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
