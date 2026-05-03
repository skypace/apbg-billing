import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { sbAuth } from './lib/supabase';
import { useRoute } from './lib/router';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { MarginPage } from './pages/MarginPage';
import { CustomersPage } from './pages/CustomersPage';
import { CustomerDetailPage } from './pages/CustomerDetailPage';
import { ReportsPage } from './pages/ReportsPage';
import { PlansPage } from './pages/PlansPage';
import { RepsPage } from './pages/RepsPage';
import { ComparePage } from './pages/ComparePage';
import { InventoryPage } from './pages/InventoryPage';
import { SettingsPage } from './pages/SettingsPage';
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
    case 'overview':
      body = <OverviewPage />;
      break;
    case 'margin':
      body = <MarginPage />;
      break;
    case 'customers':
      body = <CustomersPage />;
      break;
    case 'reports':
      body = <ReportsPage />;
      break;
    case 'plans':
      body = <PlansPage />;
      break;
    case 'reps':
      body = <RepsPage />;
      break;
    case 'compare':
      body = <ComparePage />;
      break;
    case 'inventory':
      body = <InventoryPage />;
      break;
    case 'settings':
      body = <SettingsPage />;
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
