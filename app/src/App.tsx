import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { sbAuth } from './lib/supabase';
import { useRoute } from './lib/router';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { MarginPage } from './pages/MarginPage';
import { CustomersPage } from './pages/CustomersPage';
import { CustomerDetailPage } from './pages/CustomerDetailPage';
import { PlaceholderPage } from './pages/PlaceholderPage';

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [route, navTo] = useRoute();

  useEffect(() => {
    sbAuth.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sbAuth.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => { sub.subscription.unsubscribe(); };
  }, []);

  if (session === undefined) {
    return <div className="ld">Initializing…</div>;
  }
  if (!session) {
    return <LoginPage />;
  }

  let body;
  switch (route.view) {
    case 'margin':
      body = <MarginPage />;
      break;
    case 'customers':
      body = <CustomersPage />;
      break;
    case 'reports':
      body = <PlaceholderPage title="Reports" legacyHash="reports" />;
      break;
    case 'plans':
      body = <PlaceholderPage title="Plans" legacyHash="plans" />;
      break;
    case 'reps':
      body = <PlaceholderPage title="Reps" legacyHash="reps" />;
      break;
    case 'compare':
      body = <PlaceholderPage title="Compare" legacyHash="compare" />;
      break;
    case 'inventory':
      body = <PlaceholderPage title="Inventory" legacyHash="inventory" />;
      break;
    case 'settings':
      body = <PlaceholderPage title="Settings" legacyHash="settings" />;
      break;
    case 'customer-detail':
      body = route.customerId
        ? <CustomerDetailPage customerId={route.customerId} />
        : <PlaceholderPage title="Customer" legacyHash="customers" />;
      break;
  }

  return (
    <Layout
      current={route.view === 'customer-detail' ? 'customers' : route.view}
      onNav={navTo}
      userEmail={session.user.email}
      onLogout={() => sbAuth.auth.signOut()}
    >
      {body}
    </Layout>
  );
}
