import { Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useSession } from '@/lib/hooks';
import { DistributorProvider, useDistributor } from '@/lib/distributor';
import { AppShell } from '@/components/AppShell';
import { LoginPage } from '@/pages/LoginPage';
import { BrixMark, BrixWordmark } from '@/components/BrixMark';
import { signOutLocal } from '@/lib/supabase';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Shipments = lazy(() => import('@/pages/Shipments'));
const ShipmentDetail = lazy(() => import('@/pages/ShipmentDetail'));
const Orders = lazy(() => import('@/pages/Orders'));
const Depletions = lazy(() => import('@/pages/Depletions'));
const Agreements = lazy(() => import('@/pages/Agreements'));
const Billing = lazy(() => import('@/pages/Billing'));

function LoadingFallback() {
  return (
    <div className="loading-fallback">
      <div className="spinner" />
    </div>
  );
}

/** Signed in, but ops.sub_distributor_users has no active row for this login. */
function NoAccess() {
  return (
    <div className="login-page">
      <div className="login-card" style={{ textAlign: 'center' }}>
        <div className="login-brand">
          <BrixMark size={80} />
          <BrixWordmark style={{ fontSize: '1.6rem' }} />
        </div>
        <p className="login-desc" style={{ marginBottom: 8 }}>
          This account doesn&rsquo;t have distributor portal access.
        </p>
        <p className="login-desc">
          If you believe this is a mistake, contact your Brix Beverage rep to
          get your login linked to your distributor.
        </p>
        <button
          type="button"
          className="login-btn"
          style={{ width: '100%' }}
          onClick={async () => {
            await signOutLocal();
            window.location.reload();
          }}
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}

function Gate() {
  const { loading, error, distributors } = useDistributor();
  if (loading) return <LoadingFallback />;
  if (error) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="err-note">Couldn&rsquo;t load your distributor profile: {error}</div>
          <p className="login-desc">Refresh to try again, or contact your Brix Beverage rep.</p>
        </div>
      </div>
    );
  }
  if (distributors.length === 0) return <NoAccess />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="shipments" element={<Shipments />} />
        <Route path="shipments/:id" element={<ShipmentDetail />} />
        <Route path="orders" element={<Orders />} />
        <Route path="depletions" element={<Depletions />} />
        <Route path="agreements" element={<Agreements />} />
        <Route path="billing" element={<Billing />} />
        <Route path="*" element={<Navigate to="" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  const { session, loading } = useSession();
  if (loading) return <LoadingFallback />;

  return (
    <Suspense fallback={<LoadingFallback />}>
      {!session ? (
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      ) : (
        <DistributorProvider>
          <Gate />
        </DistributorProvider>
      )}
    </Suspense>
  );
}
