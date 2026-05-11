import { useEffect, useState } from 'react';
import { Plus, Trash2, RotateCcw } from 'lucide-react';
import {
  ChainModifier, DEFAULT_CHAIN_MODIFIERS,
  getChainModifiers, setChainModifiers,
} from '../../lib/chainModifiers';
import { useToast } from '../../lib/toast';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ChainModifiersEditor() {
  const toast = useToast();
  const [mods, setMods] = useState<ChainModifier[]>([]);

  useEffect(() => { setMods(getChainModifiers()); }, []);

  function persist(next: ChainModifier[]) {
    setMods(next);
    try { setChainModifiers(next); }
    catch (e: unknown) { toast.error('Save failed: ' + errMsg(e)); }
  }
  function update(idx: number, patch: Partial<ChainModifier>) {
    persist(mods.map((m, i) => i === idx ? { ...m, ...patch } : m));
  }
  function add() {
    persist([...mods, {
      code: 'NEW', label: 'New rollup', full: 'New rollup',
      filters: { customers: [], categories: [] }, group: 'equipment',
    }]);
  }
  function remove(idx: number) {
    if (!confirm(`Delete "${mods[idx].code}"?`)) return;
    persist(mods.filter((_, i) => i !== idx));
    toast.success('Removed');
  }
  function reset() {
    if (!confirm('Reset modifiers to factory defaults? Your edits will be lost.')) return;
    persist(DEFAULT_CHAIN_MODIFIERS);
    toast.success('Reset to defaults');
  }
  function setList(idx: number, key: 'customers' | 'categories', val: string) {
    const arr = val.split(',').map((s) => s.trim()).filter(Boolean);
    update(idx, { filters: { ...mods[idx].filters, [key]: arr } });
  }

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <div className="ct" style={{ margin: 0 }}>Chain Rollup Modifiers</div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3, lineHeight: 1.5 }}>
            {mods.length} modifier{mods.length === 1 ? '' : 's'} · stored in your browser. Edit any field
            inline — changes apply immediately to the Rollup filter on Overview + Margin.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={reset} className="tb-btn" title="Reset to factory defaults">
            <RotateCcw size={12} strokeWidth={2.2} /> <span>Reset</span>
          </button>
          <button onClick={add} className="tb-btn tb-btn--primary">
            <Plus size={12} strokeWidth={2.4} /> <span>New rollup</span>
          </button>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 70 }}>Code</th>
              <th>Label</th>
              <th style={{ width: 140 }}>Group</th>
              <th>Customers (comma-sep)</th>
              <th>Categories (comma-sep)</th>
              <th style={{ width: 70 }}>Parent</th>
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {mods.map((m, i) => (
              <tr key={i}>
                <td>
                  <input type="text" defaultValue={m.code}
                    onBlur={(e) => e.target.value !== m.code && update(i, { code: e.target.value.toUpperCase().trim() })}
                    style={cellStyle({ fontFamily: 'var(--ff-display)', fontWeight: 800, color: 'var(--ac)' })} />
                </td>
                <td><input type="text" defaultValue={m.label}
                  onBlur={(e) => e.target.value !== m.label && update(i, { label: e.target.value })}
                  style={cellStyle()} /></td>
                <td>
                  <select value={m.group}
                    onChange={(e) => update(i, { group: e.target.value as 'equipment' | 'soda' })}
                    className="tb-select" style={{ width: '100%' }}>
                    <option value="equipment">Equipment & Service</option>
                    <option value="soda">Soda Sales</option>
                  </select>
                </td>
                <td><input type="text"
                  defaultValue={(m.filters.customers ?? []).join(', ')}
                  onBlur={(e) => setList(i, 'customers', e.target.value)}
                  placeholder="THE MELT, STARBIRD"
                  style={cellStyle({ fontFamily: 'var(--ff-mono)', fontSize: 11 })} /></td>
                <td><input type="text"
                  defaultValue={(m.filters.categories ?? []).join(', ')}
                  onBlur={(e) => setList(i, 'categories', e.target.value)}
                  placeholder="Equipment, Service"
                  style={cellStyle({ fontFamily: 'var(--ff-mono)', fontSize: 11 })} /></td>
                <td><input type="text" defaultValue={m.parent ?? ''}
                  onBlur={(e) => update(i, { parent: e.target.value.trim() || undefined })}
                  placeholder="—"
                  style={cellStyle({ fontFamily: 'var(--ff-display)', textAlign: 'center', color: 'var(--mt)' })} /></td>
                <td>
                  <button onClick={() => remove(i)} className="tb-btn"
                    style={{ color: 'var(--rd)', borderColor: 'var(--rd)', padding: '4px 6px' }}
                    title="Delete">
                    <Trash2 size={12} strokeWidth={2.2} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ padding: '10px 16px', fontSize: 10, color: 'var(--mt)', borderTop: '1px solid var(--bd)' }}>
        <strong>Hierarchy:</strong> set Parent = CHE on Melt/Starbird E&S rows so they roll up; same with CHS and the soda rows.
        Customer names must match QBO display names exactly (case-sensitive).
      </div>
    </div>
  );
}

function cellStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 4,
    color: 'var(--tx)',
    fontSize: 12,
    fontFamily: 'inherit',
    padding: '4px 8px',
    width: '100%',
    transition: 'border-color 120ms ease, background 120ms ease',
    ...extra,
  };
}
