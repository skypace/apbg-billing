import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, adoptGatewaySession } from './supabase';
import type { Session } from '@supabase/supabase-js';

/** Auth session hook — adopts the apbg-gateway SSO session first. */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adoptGatewaySession().then(() => supabase.auth.getSession()).then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  return { session, loading };
}

/** Generic async loader with loading / error / reload states. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}

// ── Item-name lookup with a module-level cache ──
// Names come from ops.v_distributor_catalog (NO cost columns; ops.qbo_items
// itself is denied to distributor logins).
const nameCache = new Map<string, string>();

export async function fetchItemNames(ids: string[]): Promise<Map<string, string>> {
  const missing = Array.from(new Set(ids.filter((id) => id && !nameCache.has(id))));
  if (missing.length > 0) {
    // Chunk to keep the querystring sane on big lists.
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      const { data, error } = await supabase
        .from('v_distributor_catalog')
        .select('qbo_item_id, name')
        .in('qbo_item_id', chunk);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as { qbo_item_id: string; name: string }[]) {
        nameCache.set(row.qbo_item_id, row.name);
      }
    }
  }
  return nameCache;
}

/** Resolve item ids → display names (falls back to the raw id). */
export function useItemNames(ids: string[]) {
  const [names, setNames] = useState<Map<string, string>>(() => new Map(nameCache));
  const key = ids.slice().sort().join(',');

  useEffect(() => {
    let alive = true;
    if (!ids.length) return;
    fetchItemNames(ids)
      .then((m) => {
        if (alive) setNames(new Map(m));
      })
      .catch(() => {
        /* names degrade to raw ids */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return useCallback(
    (id: string) => names.get(id) ?? id,
    [names]
  );
}
