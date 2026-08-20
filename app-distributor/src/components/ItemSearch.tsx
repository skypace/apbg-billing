import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { CatalogItem } from '@/lib/types';

/**
 * Debounced item lookup over ops.v_distributor_catalog (name-only view —
 * deliberately no cost columns). Picking a result calls onPick and clears
 * the box.
 */
export function ItemSearch({
  onPick,
  placeholder = 'Search items by name…',
}: {
  onPick: (item: CatalogItem) => void;
  placeholder?: string;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CatalogItem[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const q = term.trim();
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    const seq = ++seqRef.current;
    setSearching(true);
    const t = window.setTimeout(async () => {
      const { data, error } = await supabase
        .from('v_distributor_catalog')
        .select('qbo_item_id, name, fully_qualified_name, category_path, active')
        .ilike('name', `%${q}%`)
        .order('name')
        .limit(15);
      if (seq !== seqRef.current) return; // stale response
      setSearching(false);
      if (error) {
        setResults([]);
        setOpen(true);
        return;
      }
      setResults((data ?? []) as CatalogItem[]);
      setOpen(true);
    }, 300);
    return () => window.clearTimeout(t);
  }, [term]);

  // Close on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div className="isearch" ref={wrapRef}>
      <input
        type="text"
        value={term}
        placeholder={placeholder}
        onChange={(e) => setTerm(e.target.value)}
        onFocus={() => {
          if (results.length) setOpen(true);
        }}
        style={{ width: '100%' }}
      />
      {open && (
        <div className="isearch-pop">
          {searching && <div className="isearch-none">Searching…</div>}
          {!searching && results.length === 0 && (
            <div className="isearch-none">No items match &ldquo;{term.trim()}&rdquo;.</div>
          )}
          {!searching &&
            results.map((it) => (
              <button
                key={it.qbo_item_id}
                type="button"
                className="isearch-row"
                onClick={() => {
                  onPick(it);
                  setTerm('');
                  setResults([]);
                  setOpen(false);
                }}
              >
                {it.name}
                {it.category_path && (
                  <span className="isearch-cat">{it.category_path}</span>
                )}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
