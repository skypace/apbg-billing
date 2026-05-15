-- ============================================================================
-- Brixpense — final auth model: in-app approval, email is notification only
-- ============================================================================
-- Sequence summary:
--   20260512   = base tables + RLS (had anon policies for magic-link)
--   20260512o  = no-op overlap (orphan plural-named approvals table)
--   20260512p  = cleanup (drop orphan, finish seed)
--   20260512q  = first stab at in-app auth (overshot — got reverted)
--   20260512r  = reverted q, restored anon RLS for magic-link
--   20260512s  = THIS FILE. Final model. Re-drops anon RLS, installs the
--                self/manager UPDATE pair, deprecates approval_token.
--
-- Why two flips: clarifying the design with the human (Sky) took two passes.
-- This file is the durable end state. The intermediate migrations stay in
-- history; their net effect (after 20260512s applies) is zero.
--
-- Final flow:
--   Expense       — auto-approved on submit, no email, no approval workflow
--   Purchase Req  — submitter picks approver from manager_emails list,
--                   notify emails the approver a link to the portal,
--                   approver logs into Supabase and approves in-app
--
-- The decide netlify function uses the approver's Bearer JWT; RLS allows
-- their UPDATE because manager_email = lower(jwt.email).
-- ============================================================================

-- ── 1. Drop anon RLS (no anonymous approval anywhere) ──────────────────────
DROP POLICY IF EXISTS expense_requests_anon_select ON ops.expense_requests;
DROP POLICY IF EXISTS expense_requests_anon_update ON ops.expense_requests;
DROP POLICY IF EXISTS attachments_anon_select       ON ops.expense_request_attachments;
DROP POLICY IF EXISTS approvals_insert_anon         ON ops.expense_approvals;
DROP POLICY IF EXISTS approvals_anon_select         ON ops.expense_approvals;


-- ── 2. Replace submitter-only UPDATE with self + manager pair ──────────────
DROP POLICY IF EXISTS expense_requests_update          ON ops.expense_requests;
DROP POLICY IF EXISTS expense_requests_update_self     ON ops.expense_requests;
DROP POLICY IF EXISTS expense_requests_update_manager  ON ops.expense_requests;

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


-- ── 3. Document approval_token as deprecated ───────────────────────────────
COMMENT ON COLUMN ops.expense_requests.approval_token IS
  'DEPRECATED 2026-05-12. Was used by the abandoned magic-link approval flow. '
  'No function reads or writes this column. Safe to drop in a future cleanup '
  'migration once any in-flight rows have aged out.';
