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
  | 'distributors'
  | 'pricing'
  | 'proposal-builder'
  | 'operations'
  | 'fleet'
  | 'settings'
  | 'customer-detail';

export interface Route {
  view: View;
  customerId: string | null;
  params: Record<string, string>;
}

export function parseHash(): Route {
  const raw = (window.location.hash || '').replace(/^#/, '').replace(/^\//, '');
  const [h, query = ''] = raw.split('?', 2);
  const params = Object.fromEntries(new URLSearchParams(query).entries());
  if (h.startsWith('customer-')) {
    return { view: 'customer-detail', customerId: h.slice('customer-'.length), params };
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
    'distributors',
    'pricing',
    'proposal-builder',
    'operations',
    'fleet',
    'settings',
  ];
  if (known.includes(h as View)) return { view: h as View, customerId: null, params };
  return { view: 'overview', customerId: null, params: {} };
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
    setRoute({ view: v, customerId: null, params: {} });
  }

  return [route, navTo];
}
