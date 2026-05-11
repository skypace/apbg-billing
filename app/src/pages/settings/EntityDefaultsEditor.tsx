import { useEffect, useState } from 'react';
import { Plus, Trash2, RotateCcw } from 'lucide-react';
import type { SalesFilters } from '../../lib/sales';
import {
  DEFAULT_ENTITY_AUTO_FILTERS,
  getEntityDefaults, setEntityDefaults,
} from '../../lib/chainModifiers';
import { useToast } from '../../lib/toast';

interface Row {
  entity:     string;
  categories: string[];
  customers:  string[];
}

function toRows(map: Record<string, Partial<SalesFilters>>): Row[] {
  return Object.entries(map).map(([entity, f]) => ({
    entity,
    categories: f.categories ?? [],
    customers:  f.customers  ?? [],
  }));
}
function fromRows(rows: Row[]): Record<string, Partial<SalesFilters>> {
  const m: Record<string, Partial<SalesFilters>> = {};
  for (const r of rows) {
    if (!r.entity.trim()) continue;
    const f: Partial<SalesFilters> = {};
    if (r.categories.length) f.categories = r.categories;
    if (r.customers.length)  f.customers  = r.customers;
    m[r.entity.trim()] = f;
  }
  return m;
}

export function EntityDefaultsEditor() {
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => { setRows(toRows(getEntityDefaults())); }, []);

  function persist(next: Row[]) {
    setRows(next);
    try { setEntityDefaults(fromRows(next)); }
    catch (e: unknown) { toast.error('Save failed: ' + (e instanceof Error ? e.message : String(e))); }
  }
  function update(idx: number, patch: Partial<Row>) {
    persist(rows.map((r, i) => i === idx ? { ...r, ...patch } : r));
  }
  function add() {
    persist([...rows, { entity: 'new', categories: [], customers: [] }]);
  }
  function remove(idx: number) {
    if (!confirm(`Delete defaults for "${rows[idx].entity}"?`)) return;
    persist(rows.filter((_, i) => i !== idx));
  }
  function reset() {
    if (!confirm('Reset entity defaults to factory baseline? Your edits will be lost.')) return;
    persist(toRows(DEFAULT_ENTITY_AUTO_FILTERS));
    toast.success('Reset to defaults');
  }
  function setList(idx: number, key: 'categories' | 'customers', val: string) {
    update(idx, { [key]: val.split(',').map((s) => s.trim()).filter(Boolean) });
  }

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <div className="ct" style={{ margin: 0 }}>Entity Smart-Defaults</div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3, lineHeight: 1.5 }}>
            When the Entity dropdown is set on Overview or Margin, these category / customer
            filters auto-apply. Edit a row → next time you pick that entity it uses the new defaults.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={reset} className="tb-btn"><RotateCcw size={12} strokeWidth={2.2} /> Reset</button>
          <button onClick={add} className="tb-btn tb-btn--primary"><Plus size={12} strokeWidth={2.4} /> New entity</button>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th style={{ width: 110 }}>Entity code</th>
            <th>Default categories (comma-sep)</th>
            <th>Default customers (comma-sep)</th>
            <th style={{ width: 44 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input type="text" defaultValue={r.entity}
                  onBlur={(e) => e.target.value !== r.entity && update(i, { entity: e.target.value.trim() })}
                  style={{ background: 'transparent', border: '1px solid transparent', color: 'var(--ac)',
                           fontFamily: 'var(--ff-display)', fontWeight: 800, fontSize: 13, padding: '4px 8px', width: '100%' }} />
              </td>
              <td><input type="text"
                defaultValue={r.categories.join(', ')}
                onBlur={(e) => setList(i, 'categories', e.target.value)}
                placeholder="BIB, Cans, Fountain, Gas"
                style={{ background: 'transparent', border: '1px solid transparent', color: 'var(--tx)',
                         fontFamily: 'var(--ff-mono)', fontSize: 11, padding: '4px 8px', width: '100%' }} /></td>
              <td><input type="text"
                defaultValue={r.customers.join(', ')}
                onBlur={(e) => setList(i, 'customers', e.target.value)}
                placeholder="FREEFLOW CUSTOMER, FRESHPET CUSTOMER"
                style={{ background: 'transparent', border: '1px solid transparent', color: 'var(--tx)',
                         fontFamily: 'var(--ff-mono)', fontSize: 11, padding: '4px 8px', width: '100%' }} /></td>
              <td>
                <button onClick={() => remove(i)} className="tb-btn"
                  style={{ color: 'var(--rd)', borderColor: 'var(--rd)', padding: '4px 6px' }}>
                  <Trash2 size={12} strokeWidth={2.2} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ padding: '10px 16px', fontSize: 10, color: 'var(--mt)', borderTop: '1px solid var(--bd)' }}>
        Entity codes must match exactly what appears in the Entity dropdown (e.g. <code>brix</code>,{' '}
        <code>AS</code>, <code>freeflow</code>, <code>FF</code>).
      </div>
    </div>
  );
}
