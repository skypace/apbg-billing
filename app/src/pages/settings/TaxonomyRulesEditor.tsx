import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, RotateCcw, ArrowUp, ArrowDown, FlaskConical } from 'lucide-react';
import {
  TaxonomyRule, DEFAULT_ITEM_RULES, DEFAULT_CUSTOMER_RULES,
  getItemRules, setItemRules, getCustomerRules, setCustomerRules,
} from '../../lib/taxonomy';
import { useToast } from '../../lib/toast';

export function TaxonomyRulesEditor() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RuleTable kind="item" />
      <RuleTable kind="customer" />
    </div>
  );
}

function RuleTable({ kind }: { kind: 'item' | 'customer' }) {
  const toast = useToast();
  const [rules, setRules] = useState<TaxonomyRule[]>([]);
  const [testInput, setTestInput] = useState('');

  const isItem = kind === 'item';
  const title = isItem ? 'Item taxonomy rules' : 'Customer taxonomy rules';
  const getter = isItem ? getItemRules     : getCustomerRules;
  const setter = isItem ? setItemRules     : setCustomerRules;
  const defaults = isItem ? DEFAULT_ITEM_RULES : DEFAULT_CUSTOMER_RULES;
  const samplePlaceholder = isItem
    ? 'e.g. "MELT 5 GAL BIB SYRUP"'
    : 'e.g. "THE MELT — Sherman Oaks"';

  useEffect(() => { setRules(getter()); }, [getter]);

  const sorted = useMemo(() => [...rules].sort((a, b) => a.order - b.order), [rules]);

  function persist(next: TaxonomyRule[]) {
    setRules(next);
    try { setter(next); }
    catch (e: unknown) { toast.error('Save failed: ' + (e instanceof Error ? e.message : String(e))); }
  }
  function update(idx: number, patch: Partial<TaxonomyRule>) {
    persist(rules.map((r, i) => i === idx ? { ...r, ...patch } : r));
  }
  function add() {
    const maxOrder = rules.reduce((m, r) => Math.max(m, r.order), 0);
    persist([...rules, { pattern: 'NEW.*', label: 'New group', order: maxOrder + 10 }]);
  }
  function remove(idx: number) {
    if (!confirm('Delete this rule?')) return;
    persist(rules.filter((_, i) => i !== idx));
  }
  function reset() {
    if (!confirm(`Reset ${kind} rules to factory defaults? Your edits will be lost.`)) return;
    persist(defaults);
    toast.success('Reset to defaults');
  }
  function move(idx: number, dir: -1 | 1) {
    // Operate on sorted view; swap order values
    const list = [...sorted];
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    const a = list[idx];
    const b = list[j];
    const oA = a.order;
    a.order = b.order;
    b.order = oA;
    persist(rules.map((r) => r === a ? a : r === b ? b : r));
  }

  // Live test: which rule wins for this input?
  const testResult = useMemo(() => {
    const n = testInput.toUpperCase();
    if (!n.trim()) return null;
    for (const r of sorted) {
      try {
        if (new RegExp(r.pattern, 'i').test(n)) return { matched: r, label: r.label };
      } catch { /* skip bad regex */ }
    }
    return { matched: null, label: 'Other' };
  }, [testInput, sorted]);

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <div className="ct" style={{ margin: 0 }}>{title}</div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3, lineHeight: 1.5 }}>
            {rules.length} rule{rules.length === 1 ? '' : 's'} · evaluated top-to-bottom (by Order).
            First match wins; if none match, the {kind} is grouped under "Other".
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={reset} className="tb-btn"><RotateCcw size={12} strokeWidth={2.2} /> Reset</button>
          <button onClick={add} className="tb-btn tb-btn--primary"><Plus size={12} strokeWidth={2.4} /> New rule</button>
        </div>
      </div>

      {/* Live test row */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--bd)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--sf2)' }}>
        <FlaskConical size={14} strokeWidth={2.2} style={{ color: 'var(--ac)' }} />
        <span className="toolbar-label">Test</span>
        <input type="text" value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          placeholder={samplePlaceholder}
          className="login-input"
          style={{ flex: 1, maxWidth: 360, padding: '6px 10px', fontSize: 12, fontFamily: 'var(--ff-mono)' }} />
        {testResult && (
          <span style={{ fontSize: 11, color: 'var(--mt)' }}>
            →{' '}
            <span style={{ color: testResult.matched ? 'var(--ac)' : 'var(--mt)', fontWeight: 700 }}>
              {testResult.label}
            </span>
            {testResult.matched && (
              <span style={{ color: 'var(--mt)', marginLeft: 8, fontFamily: 'var(--ff-mono)', fontSize: 10 }}>
                rule {testResult.matched.order} · /{testResult.matched.pattern}/
              </span>
            )}
          </span>
        )}
      </div>

      <table>
        <thead>
          <tr>
            <th style={{ width: 64 }}>Order</th>
            <th>Pattern (regex)</th>
            <th>Group label</th>
            <th style={{ width: 88, textAlign: 'right' }} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const idx = rules.indexOf(r);
            let regexOk = true;
            try { new RegExp(r.pattern, 'i'); } catch { regexOk = false; }
            return (
              <tr key={idx}>
                <td>
                  <input type="number" defaultValue={r.order}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isNaN(v) && v !== r.order) update(idx, { order: v });
                    }}
                    style={{ background: 'transparent', border: '1px solid transparent', color: 'var(--mt)',
                             fontFamily: 'var(--ff-mono)', fontSize: 12, padding: '4px 6px', width: '100%', textAlign: 'right' }} />
                </td>
                <td>
                  <input type="text" defaultValue={r.pattern}
                    onBlur={(e) => e.target.value !== r.pattern && update(idx, { pattern: e.target.value })}
                    style={{ background: 'transparent', border: regexOk ? '1px solid transparent' : '1px solid var(--rd)',
                             color: regexOk ? 'var(--tx)' : 'var(--rd)',
                             fontFamily: 'var(--ff-mono)', fontSize: 11, padding: '4px 8px', width: '100%' }}
                    title={regexOk ? '' : 'Invalid regex — this rule will be skipped'} />
                </td>
                <td>
                  <input type="text" defaultValue={r.label}
                    onBlur={(e) => e.target.value !== r.label && update(idx, { label: e.target.value })}
                    style={{ background: 'transparent', border: '1px solid transparent', color: 'var(--tx)',
                             fontWeight: 600, fontSize: 12, padding: '4px 8px', width: '100%' }} />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="tb-btn"
                    style={{ padding: '4px 6px', marginRight: 2 }} title="Move up">
                    <ArrowUp size={11} strokeWidth={2.4} />
                  </button>
                  <button onClick={() => move(i, +1)} disabled={i === sorted.length - 1} className="tb-btn"
                    style={{ padding: '4px 6px', marginRight: 2 }} title="Move down">
                    <ArrowDown size={11} strokeWidth={2.4} />
                  </button>
                  <button onClick={() => remove(idx)} className="tb-btn"
                    style={{ color: 'var(--rd)', borderColor: 'var(--rd)', padding: '4px 6px' }}>
                    <Trash2 size={11} strokeWidth={2.2} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
