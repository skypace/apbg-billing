import { useEffect, useMemo, useState } from 'react';
import { PrintableTable } from '../../components/PrintableTable';
import { Plus, Trash2, RotateCcw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  ChainModifier, DEFAULT_CHAIN_MODIFIERS,
  getChainModifiers, setChainModifiers,
} from '../../lib/chainModifiers';
import { previewRollupMatch, type RollupMatchPreview } from '../../lib/inventory';
import { fm } from '../../lib/formatters';
import { useToast } from '../../lib/toast';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ChainModifiersEditor() {
  const toast = useToast();
  const [mods, setMods] = useState<ChainModifier[]>([]);
  const [previewByCode, setPreviewByCode] = useState<Map<string, RollupMatchPreview>>(new Map());
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => { setMods(getChainModifiers()); }, []);

  // Live-fetch match counts for every modifier. Rerun on edits.
  useEffect(() => {
    if (mods.length === 0) return;
    let cancelled = false;
    setPreviewLoading(true);
    Promise.all(mods.map(async (m) => {
      const res = await previewRollupMatch({
        customers:  m.filters.customers ?? null,
        categories: m.filters.categories ?? null,
        items:      m.filters.items ?? null,
        channels:   m.filters.channels ?? null,
        segments:   m.filters.segments ?? null,
      });
      return [m.code, res[0]] as const;
    }))
      .then((entries) => {
        if (cancelled) return;
        const next = new Map<string, RollupMatchPreview>();
        for (const [code, p] of entries) if (p) next.set(code, p);
        setPreviewByCode(next);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [mods]);

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

  const zeroMatchCount = useMemo(() => {
    let n = 0;
    for (const m of mods) {
      const p = previewByCode.get(m.code);
      if (p && p.matched_line_count === 0) n++;
    }
    return n;
  }, [mods, previewByCode]);

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <div className="ct" style={{ margin: 0 }}>Chain Rollup Modifiers</div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3, lineHeight: 1.5 }}>
            {mods.length} modifier{mods.length === 1 ? '' : 's'} · stored in your browser.
            Match column shows live ILIKE preview against the last 12 months of sales.
            {previewLoading && ' · refreshing…'}
            {zeroMatchCount > 0 && (
              <span style={{ color: 'var(--am)', marginLeft: 6 }}>
                <AlertTriangle size={10} style={{ verticalAlign: -1 }} /> {zeroMatchCount} hit 0 rows — edit names to match actual data
              </span>
            )}
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
        <PrintableTable>
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>Code</th>
                <th>Label</th>
                <th style={{ width: 140 }}>Group</th>
                <th>Customers (comma-sep, ILIKE)</th>
                <th>Categories (comma-sep, ILIKE)</th>
                <th style={{ width: 230 }}>Match (12 mo)</th>
                <th style={{ width: 70 }}>Parent</th>
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {mods.map((m, i) => {
                const p = previewByCode.get(m.code);
                return (
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
                    <td>
                      {p ? (
                        <MatchChip preview={p} title={chipTitle(p)} />
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--mt)' }}>—</span>
                      )}
                    </td>
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
                );
              })}
            </tbody>
          </table>
        </PrintableTable>
      </div>

      <div style={{ padding: '10px 16px', fontSize: 10, color: 'var(--mt)', borderTop: '1px solid var(--bd)' }}>
        <strong>Pattern match.</strong> Names are matched with case-insensitive substring (ILIKE) against
        customer / category. e.g. <code>THE MELT</code> matches <em>The Melt :: Berkeley</em>,
        <em>The Melt :: 925 Market</em>, etc. <strong>Hierarchy:</strong> set Parent = CHE on Melt/Starbird E&S
        rows so they roll up; same with CHS and the soda rows.
      </div>
    </div>
  );
}

function MatchChip({ preview, title }: { preview: RollupMatchPreview; title?: string }) {
  const zero = preview.matched_line_count === 0;
  const Icon = zero ? AlertTriangle : CheckCircle2;
  const color = zero ? 'var(--am)' : 'var(--gn)';
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontFamily: 'var(--ff-mono)', fontSize: 10.5, color,
        background: zero ? 'rgba(244,180,0,0.08)' : 'rgba(46,184,114,0.08)',
        border: '1px solid ' + color, padding: '2px 8px', borderRadius: 12,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={11} strokeWidth={2.4} aria-hidden="true" />
      {preview.matched_customers} cust · {preview.matched_items} item · {fm(preview.matched_revenue)}
    </span>
  );
}

function chipTitle(p: RollupMatchPreview): string {
  const cust = (p.sample_customer_names ?? []).slice(0, 5).join(', ');
  const cats = (p.sample_category_names ?? []).slice(0, 5).join(', ');
  return `${p.matched_line_count.toLocaleString()} lines · ${p.matched_categories} categories\n`
    + `Sample customers: ${cust || '—'}\n`
    + `Sample categories: ${cats || '—'}`;
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
