import { useEffect, useState } from 'react';

export type View =
  | 'overview'
  | 'margin'
  | 'customers'
  | 'reports'
  | 'plans'
  | 'compare'
  | 'inventory'
  | 'stock'
  | 'production'
  | 'pricing'
  | 'proposal-builder'
  | 'operations'
  | 'fleet'
  | 'settings'
  | 'customer-detail';

export interface Route {
  view: View;
  customerId: string | null;
}

export function parseHash(): Route {
  const h = (window.location.hash || '').replace(/^#/, '').replace(/^\//, '');
  if (h.startsWith('customer-')) {
    return { view: 'customer-detail', customerId: h.slice('customer-'.length) };
  }
  const known: View[] = [
    'overview',
    'margin',
    'customers',
    'reports',
    'plans',
    'compare',
    'inventory',
    'stock',
    'production',
    'pricing',
    'proposal-builder',
    'operations',
    'fleet',
    'settings',
  ];
  if (known.includes(h as View)) return { view: h as View, customerId: null };
  return { view: 'overview', customerId: null };
}

export function useRoute(): [Route, (v: View) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash());

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function navTo(v: View) {
    const nextHash = v === 'proposal-builder' ? '#/proposal-builder' : '#' + v;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, '', nextHash);
    }
    setRoute({ view: v, customerId: null });
  }

  return [route, navTo];
}
