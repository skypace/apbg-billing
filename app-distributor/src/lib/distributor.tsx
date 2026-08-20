import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { supabase } from './supabase';
import type { SubDistributor } from './types';

// ── Distributor membership context ──
// RLS on ops.sub_distributors returns ONLY the caller's distributor(s), so a
// plain select is the membership check. Loaded once on boot; zero rows means
// this login has no portal access. The whole app assumes exactly one
// membership — when more than one row comes back a switcher shows in the
// sidebar and the active one is remembered per browser.

const ACTIVE_KEY = 'brixdist-active-distributor';

interface DistributorCtx {
  loading: boolean;
  error: string | null;
  distributors: SubDistributor[];
  distributor: SubDistributor | null;
  setActiveId: (id: string) => void;
  reload: () => void;
}

const Ctx = createContext<DistributorCtx>({
  loading: true,
  error: null,
  distributors: [],
  distributor: null,
  setActiveId: () => {},
  reload: () => {},
});

export function DistributorProvider({ children }: { children: ReactNode }) {
  const [distributors, setDistributors] = useState<SubDistributor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_KEY);
    } catch {
      return null;
    }
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    supabase
      .from('sub_distributors')
      .select(
        'id, code, name, status, model, per_case_delivery_fee, qbo_customer_id, inventory_location_id, territory, contact_name, contact_email, contact_phone'
      )
      .order('name')
      .then(({ data, error: err }) => {
        if (!alive) return;
        if (err) {
          setError(err.message);
        } else {
          setDistributors((data ?? []) as SubDistributor[]);
        }
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id);
    try {
      localStorage.setItem(ACTIVE_KEY, id);
    } catch {
      /* best-effort */
    }
  }, []);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const distributor = useMemo(() => {
    if (!distributors.length) return null;
    return distributors.find((d) => d.id === activeId) ?? distributors[0];
  }, [distributors, activeId]);

  const value = useMemo(
    () => ({ loading, error, distributors, distributor, setActiveId, reload }),
    [loading, error, distributors, distributor, setActiveId, reload]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDistributor() {
  return useContext(Ctx);
}
