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
const ThirdPartyBills = lazy(() => import('@/pages/ThirdPartyBills'));
const SFExpenses = lazy(() => import('@/pages/SFExpenses'));
const BillsInbox = lazy(() => import('@/pages/BillsInbox'));
const PayRun = lazy(() => import('@/pages/PayRun'));
const MyInbox = lazy(() => import('@/pages/MyInbox'));
const ExpenseReports = lazy(() => import('@/pages/ExpenseReports'));
const BillRules = lazy(() => import('@/pages/BillRules'));
const CardMatch = lazy(() => import('@/pages/CardMatch'));
const Vendors = lazy(() => import('@/pages/Vendors'));
const VendorDetail = lazy(() => import('@/pages/VendorDetail'));
const Tax1099 = lazy(() => import('@/pages/Tax1099'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));

function LoadingFallback() {
  return (
    <div className="loading-fallback">
      <div className="spinner" />
    </div>
  );
}

export default function App() {
  const { session, loading } = useSession();
  if (loading) return <LoadingFallback />;

  return (
    <Suspense fallback={<LoadingFallback />}>
      <Routes>
        {/* All routes are auth-gated. Approver must log into Supabase. */}
        {!session ? (
          <Route path="*" element={<LoginPage />} />
        ) : (
          <Route element={<AppShell />}>
            <Route index element={<LandingPage />} />
            <Route path="new" element={<ExpenseForm />} />
            <Route path="new-pr" element={<PurchaseRequestForm />} />
            <Route path="pending" element={<PendingList />} />
            <Route path="queue" element={<ManagerQueue />} />
            <Route path="third-party" element={<ThirdPartyBills />} />
            <Route path="sf-expenses" element={<SFExpenses />} />
            <Route path="bills" element={<BillsInbox />} />
            <Route path="pay-run" element={<PayRun />} />
            <Route path="inbox" element={<MyInbox />} />
            <Route path="reports" element={<ExpenseReports />} />
            <Route path="rules" element={<BillRules />} />
            <Route path="cards" element={<CardMatch />} />
            <Route path="vendors" element={<Vendors />} />
            <Route path="vendors/:id" element={<VendorDetail />} />
            <Route path="tax-1099" element={<Tax1099 />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="edit/:id" element={<ExpenseForm />} />
            <Route path="review/:id" element={<ApprovalPage />} />
            <Route path="*" element={<Navigate to="" replace />} />
          </Route>
        )}
      </Routes>
    </Suspense>
  );
}
