-- ============================================================================
-- Brixpense — make Service Fusion receipts visible to every logged-in user
-- ============================================================================
-- Background:
--   20260512o tightened ops.expense_requests SELECT to "your own OR rows
--   routed to you as manager":
--     USING (submitted_by = auth.uid()
--            OR manager_email = lower(auth.jwt() ->> 'email'))
--
--   That is the right privacy default for personal expense/PR rows. But SF
--   job receipts (tag = 'Service Fusion'), landed by the ResQ↔SF sync /
--   expense-to-bill, are submitted_by whichever operator clicked 💰 Bill and
--   have no manager_email. So only that operator could see them on the
--   /sf-expenses screen — everyone else got an empty list.
--
-- Fix:
--   Add a second permissive SELECT policy that exposes Service-Fusion-tagged
--   rows to ALL authenticated users. Postgres OR-combines permissive policies,
--   so personal rows stay private while SF receipts are shared. Read-only —
--   no new INSERT/UPDATE grant; the SF Expenses screen is a read view.
-- ============================================================================

DROP POLICY IF EXISTS expense_requests_select_sf ON ops.expense_requests;
CREATE POLICY expense_requests_select_sf ON ops.expense_requests
  FOR SELECT TO authenticated
  USING (tag = 'Service Fusion');
