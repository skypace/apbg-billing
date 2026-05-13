-- ============================================================================
-- Brixpense — switch from magic-link to in-app authenticated approval
-- ============================================================================
-- Decision (Sky 2026-05-12): managers approve inside the authenticated app
-- using the same Supabase session that powers alamedapointbg.com. No more
-- public magic-link URLs, no more emailed approval tokens.
--
-- This migration tightens RLS to match the new flow:
--   1. Drops the 5 anon policies that were gated on approval_token presence.
--      Without the magic-link, nothing legitimate uses anon access.
--   2. Replaces the submitter-only UPDATE policy with two policies — self
--      and manager — so managers can flip status from inside the app under
--      their own JWT.
--
-- The expense_requests.approval_token column is left in place for backward
-- compatibility (already-rendered pages might still reference it). The
-- decide function no longer writes or reads it. Drop in a future cleanup
-- migration when ready.
-- ============================================================================

-- ── 1. Drop anon policies (magic-link gone) ────────────────────────────────
DROP POLICY IF EXISTS expense_requests_anon_select ON ops.expense_requests;
DROP POLICY IF EXISTS expense_requests_anon_update ON ops.expense_requests;
DROP POLICY IF EXISTS attachments_anon_select       ON ops.expense_request_attachments;
DROP POLICY IF EXISTS approvals_insert_anon         ON ops.expense_approvals;
DROP POLICY IF EXISTS approvals_anon_select         ON ops.expense_approvals;


-- ── 2. Replace submitter-only UPDATE with self + manager ───────────────────
-- Old policy blocked managers from approving — only the submitter could
-- update their own row. Replace with two named policies so each role has a
-- clear, narrow grant.
DROP POLICY IF EXISTS expense_requests_update ON ops.expense_requests;

CREATE POLICY expense_requests_update_self ON ops.expense_requests
  FOR UPDATE TO authenticated
  USING (submitted_by = auth.uid())
  WITH CHECK (submitted_by = auth.uid());

CREATE POLICY expense_requests_update_manager ON ops.expense_requests
  FOR UPDATE TO authenticated
  USING (
    manager_email IS NOT NULL
    AND lower(manager_email) = lower(auth.jwt() ->> 'email')
  )
  WITH CHECK (
    manager_email IS NOT NULL
    AND lower(manager_email) = lower(auth.jwt() ->> 'email')
  );


-- ── 3. Document the deprecated column ──────────────────────────────────────
COMMENT ON COLUMN ops.expense_requests.approval_token IS
  'DEPRECATED 2026-05-12 — magic-link approval flow removed. Column kept for backward compatibility; no function reads or writes it. Drop in a future cleanup migration.';
