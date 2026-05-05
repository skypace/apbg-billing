import { useEffect, useState } from 'react';

export type View =
  | 'margin'
  | 'customers'
  | 'reports'
  | 'plans'
  | 'compare'
  | 'inventory'
  | 'settings'
  | 'customer-detail';

export interface Route {
  view: View;
  customerId: string | null;
}

export function parseHash(): Route {
  const h = (window.location.hash || '').replace(/^#/, '');
  if (h.startsWith('customer-')) {
    return { view: 'customer-detail', customerId: h.slice('customer-'.length) };
  }
  const known: View[] = [
    'margin',
    'customers',
    'reports',
    'plans',
    'compare',
    'inventory',
    'settings',
  ];
  if (known.includes(h as View)) return { view: h as View, customerId: null };
  return { view: 'margin', customerId: null };
}

export function useRoute(): [Route, (v: View) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash());

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function navTo(v: View) {
    if (window.location.hash !== '#' + v) {
      window.history.replaceState(null, '', '#' + v);
    }
    setRoute({ view: v, customerId: null });
  }

  return [route, navTo];
}
