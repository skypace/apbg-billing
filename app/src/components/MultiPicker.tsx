import { useEffect, useMemo, useRef, useState } from 'react';
import { inp } from '../lib/styles';

interface Props {
  label: string;
  values: string[];
  options: { label: string; revenue?: number | null }[] | null;
  loading?: boolean;
  onChange: (next: string[]) => void;
  placeholder?: string;
}

// Searchable dropdown with chip-style selection. Mirrors the legacy
// MultiPicker behavior — values is the selected array, options are
// the candidate labels.
export function MultiPicker({ label, values, options, loading, onChange, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const filtered = useMemo(() => {
    if (!options) return [];
    const needle = q.trim().toLowerCase();
    const list = needle
      ? options.filter((o) => o.label.toLowerCase().includes(needle))
      : options;
    return list.slice(0, 200);
  }, [options, q]);

  function toggle(v: string) {
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  }

  function clear() { onChange([]); }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1, marginRight: 6 }}>
        {label}
      </span>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          ...inp(),
          minWidth: 120,
          textAlign: 'left',
          cursor: 'pointer',
          color: values.length ? 'var(--ac)' : 'var(--mt)',
        }}
      >
        {values.length ? values.length + ' selected' : placeholder || 'all'}
        <span style={{ float: 'right', color: 'var(--mt)' }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 50,
            background: 'var(--sf)',
            border: '1px solid var(--bd)',
            borderRadius: 4,
            width: 320,
            maxHeight: 360,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div style={{ padding: 6, display: 'flex', gap: 4, borderBottom: '1px solid var(--bd)' }}>
            <input
              autoFocus
              placeholder={'search ' + label.toLowerCase() + '…'}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ ...inp(), flex: 1 }}
            />
            <button
              onClick={clear}
              disabled={values.length === 0}
              style={{
                ...inp(),
                cursor: values.length ? 'pointer' : 'default',
                color: values.length ? 'var(--rd)' : 'var(--mt)',
              }}
            >
              clear
            </button>
          </div>
          {loading || !options ? (
            <div className="ld">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="ld">No matches.</div>
          ) : (
            <div style={{ overflow: 'auto', flex: 1 }}>
              {filtered.map((o) => {
                const on = values.includes(o.label);
                return (
                  <div
                    key={o.label}
                    onClick={() => toggle(o.label)}
                    style={{
                      padding: '5px 10px',
                      fontSize: 11,
                      cursor: 'pointer',
                      display: 'flex',
                      gap: 6,
                      alignItems: 'center',
                      background: on ? 'rgba(34,211,238,.08)' : 'transparent',
                      borderBottom: '1px solid var(--bd)',
                    }}
                  >
                    <input type="checkbox" checked={on} readOnly />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: on ? 'var(--ac)' : 'var(--tx)' }}>
                      {o.label}
                    </span>
                    {o.revenue != null && (
                      <span className="mn" style={{ fontSize: 10, color: 'var(--mt)' }}>
                        ${Math.round(Number(o.revenue) / 1000)}k
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
