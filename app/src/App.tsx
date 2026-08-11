import { Suspense, lazy, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { sbAuth, adoptGatewaySession } from './lib/supabase';
import { useRoute } from './lib/router';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { BrixMark } from './components/BrixMark';

// Eager: Login (gate before session) + Overview (default landing).
// Everything else is fetched on first navigation. Vite splits each lazy
// import into its own chunk; the initial download shrinks accordingly.
const MarginPage = lazy(() => import('./pages/MarginPage').then((m) => ({ default: m.MarginPage })));
const CustomersPage = lazy(() => import('./pages/CustomersPage').then((m) => ({ default: m.CustomersPage })));
const CustomerDetailPage = lazy(() => import('./pages/CustomerDetailPage').then((m) => ({ default: m.CustomerDetailPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const PlansPage = lazy(() => import('./pages/PlansPage').then((m) => ({ default: m.PlansPage })));
const ComparePage = lazy(() => import('./pages/ComparePage').then((m) => ({ default: m.ComparePage })));
const InventoryPage = lazy(() => import('./pages/InventoryPage').then((m) => ({ default: m.InventoryPage })));
const StockPage = lazy(() => import('./pages/stock/StockPage').then((m) => ({ default: m.StockPage })));
const ProductionPage = lazy(() => import('./pages/production/ProductionPage').then((m) => ({ default: m.ProductionPage })));
const PricingPage = lazy(() => import('./pages/PricingPage').then((m) => ({ default: m.PricingPage })));
const ProposalBuilderPage = lazy(() => import('./pages/ProposalBuilderPage').then((m) => ({ default: m.ProposalBuilderPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const PlaceholderPage = lazy(() => import('./pages/PlaceholderPage').then((m) => ({ default: m.PlaceholderPage })));

function Splash() {
  return (
    <div className="splash" role="status" aria-label="Loading BRIX Refractor">
      <div>
        <BrixMark size={96} title="Brix Beverage" />
        <div className="splash-brand" style={{ marginTop: 22 }}>
          Bri<span style={{ color: 'var(--ac)' }}>XR</span>efractor
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [route, navTo] = useRoute();

  useEffect(() => {
    // Adopt the apbg-gateway SSO session first, then read the session.
    adoptGatewaySession().then(() => sbAuth.auth.getSession()).then(({ data }) => setSession(data.session));
    const { data: sub } = sbAuth.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => { sub.subscription.unsubscribe(); };
  }, []);

  if (session === undefined) {
    return <Splash />;
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
    case 'compare':
      body = <ComparePage />;
      break;
    case 'inventory':
      body = <InventoryPage />;
      break;
    case 'stock':
      body = <StockPage />;
      break;
    case 'production':
      body = <ProductionPage routeParams={route.params} />;
      break;
    case 'operations':
      // Operations moved to APBG-OPS (alamedapointbg.com/operations). Stub
      // redirects in case anyone has the #operations hash bookmarked.
      body = <PlaceholderPage title="Operations" legacyHash="operations" />;
      break;
    case 'fleet':
      // Fleet was always in apbg-ops; the placeholder preserves deep links.
      body = <PlaceholderPage title="Fleet" legacyHash="operations" />;
      break;
    case 'pricing':
      body = <PricingPage routeParams={route.params} />;
      break;
    case 'proposal-builder':
      body = <ProposalBuilderPage />;
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
      <Suspense fallback={<div className="ld">Loading…</div>}>{body}</Suspense>
    </Layout>
  );
}
