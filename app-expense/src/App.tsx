import { Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useSession } from '@/lib/hooks';
import { AppShell } from '@/components/AppShell';
import { LoginPage } from '@/pages/LoginPage';

const LandingPage = lazy(() => import('@/pages/LandingPage'));
const ExpenseForm = lazy(() => import('@/pages/ExpenseForm'));
const PurchaseRequestForm = lazy(() => import('@/pages/PurchaseRequestForm'));
const PendingList = lazy(() => import('@/pages/PendingList'));
const ManagerQueue = lazy(() => import('@/pages/ManagerQueue'));
const ApprovalPage = lazy(() => import('@/pages/ApprovalPage'));

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
    </div>
  );
}

export default function App() {
  const { session, loading } = useSession();

  if (loading) {
    return <LoadingFallback />;
  }

  return (
    <Suspense fallback={<LoadingFallback />}>
      <Routes>
        {/* Public: magic-link approval page (no auth required) */}
        <Route path="/approve/:token" element={<ApprovalPage />} />

        {/* Auth-gated routes */}
        {!session ? (
          <Route path="*" element={<LoginPage />} />
        ) : (
          <Route element={<AppShell />}>
            <Route index element={<LandingPage />} />
            <Route path="new" element={<ExpenseForm />} />
            <Route path="new-pr" element={<PurchaseRequestForm />} />
            <Route path="pending" element={<PendingList />} />
            <Route path="queue" element={<ManagerQueue />} />
            <Route path="edit/:id" element={<ExpenseForm />} />
            <Route path="*" element={<Navigate to="" replace />} />
          </Route>
        )}
      </Routes>
    </Suspense>
  );
}
