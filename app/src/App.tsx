import { Suspense, lazy, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { sbAuth, adoptGatewaySession, signOutLocal } from './lib/supabase';
import { useRoute } from './lib/router';
import { canOpen, firstAllowedView, hiddenMenuIds, visibleMenus } from './lib/appMenus';
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
const DistributorsPage = lazy(() => import('./pages/distributors/DistributorsPage').then((m) => ({ default: m.DistributorsPage })));
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

/**
 * Signed in, but every Refractor section is switched off for this account.
 * Deliberately explicit: a blank app with an empty sidebar reads as broken,
 * and the person has no idea who to ask. Names the account so an admin can
 * find it, and offers the way out.
 */
function NoSections({ email, onLogout }: { email?: string | null; onLogout: () => void }) {
  return (
    <div className="splash" role="status">
      <div style={{ maxWidth: 460, textAlign: 'center', lineHeight: 1.55 }}>
        <h1 style={{ fontSize: 20, marginBottom: 10 }}>No sections are switched on</h1>
        <p style={{ opacity: 0.75, fontSize: 14, marginBottom: 6 }}>
          Your account{email ? ` (${email})` : ''} is signed in, but every Refractor
          section has been turned off for it.
        </p>
        <p style={{ opacity: 0.75, fontSize: 14, marginBottom: 18 }}>
          Ask an administrator to enable the sections you need in the APBG hub,
          under Staff &amp; Access.
        </p>
        <button onClick={onLogout} style={{ cursor: 'pointer' }}>Sign out</button>
      </div>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [route, navTo] = useRoute();

  /**
   * Read the user's metadata LIVE, not off the session token.
   *
   * ⚠ user_metadata is baked into a JWT when it is ISSUED, and sessions on
   * this project live for months — so a menu grant changed on the gateway
   * today would not reach someone until their token happened to refresh.
   * brix-order hit exactly this on 2026-09-02 (people told they had no brand
   * minutes after being given one). getUser() calls /auth/v1/user, which
   * answers from the database. If that call fails we fall back to the token's
   * own copy: possibly stale, but it is what the app would have had anyway,
   * and it beats either locking someone out or ignoring their grant.
   */
  async function refreshMeta(s: Session | null) {
    if (!s) { setMeta(null); return; }
    try {
      const { data, error } = await sbAuth.auth.getUser();
      setMeta(
        !error && data.user
          ? (data.user.user_metadata as Record<string, unknown> | null) ?? null
          : (s.user.user_metadata as Record<string, unknown> | null) ?? null,
      );
    } catch {
      setMeta((s.user.user_metadata as Record<string, unknown> | null) ?? null);
    }
  }

  useEffect(() => {
    // Adopt the apbg-gateway SSO session first, then read the session. The
    // menu grant is resolved in the SAME step, so the splash covers it and a
    // hidden section never flashes on screen before it is filtered out.
    adoptGatewaySession()
      .then(() => sbAuth.auth.getSession())
      .then(async ({ data }) => { await refreshMeta(data.session); setSession(data.session); });
    const { data: sub } = sbAuth.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      void refreshMeta(s);
    });
    return () => { sub.subscription.unsubscribe(); };
  }, []);

  const hidden = hiddenMenuIds(meta);

  // Guard the ROUTE, not just the sidebar — a hidden link that still renders
  // its page when you type the hash is a control that only works on people
  // who do not type. Runs after render so navTo lands on a mounted router.
  useEffect(() => {
    if (!session) return;
    if (canOpen(route.view, meta)) return;
    const fallback = firstAllowedView(meta);
    if (fallback) navTo(fallback);
  }, [session, meta, route.view, navTo]);

  if (session === undefined) {
    return <Splash />;
  }
  if (!session) {
    return <LoginPage />;
  }

  // Every section switched off. Say so plainly — an empty sidebar with a blank
  // page reads as the app being broken, and the person cannot tell who to ask.
  if (visibleMenus(meta).length === 0) {
    return <NoSections email={session.user.email} onLogout={() => signOutLocal()} />;
  }

  // Denied view: render nothing this pass; the effect above is redirecting.
  if (!canOpen(route.view, meta)) {
    return <Splash />;
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
    case 'distributors':
      body = <DistributorsPage />;
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
      onLogout={() => signOutLocal()}
      hiddenMenus={hidden}
    >
      <Suspense fallback={<div className="ld">Loading…</div>}>{body}</Suspense>
    </Layout>
  );
}
