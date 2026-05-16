-- Submitter-owned DELETE policies on expense attachments. Without these,
-- the X-click-deletes flow added in app-expense/src/pages/ExpenseForm.tsx
-- (commit fd03337) silently no-ops: RLS denies, PostgREST returns zero
-- rows + no error, the UI clears local state, and the receipt reappears
-- on the next page load.
--
-- SELECT/INSERT policies were created in 20260512o_brix_expense_requests.sql
-- (table) + 20260512_create_expense_tables.sql (storage). DELETE was never
-- written — the X button only became reachable when fd03337 wired the
-- edit-mode preview, so the policy gap was never exercised.
--
-- Submitter-only (not manager). Managers reviewing PRs at /expense/review/:id
-- should not be able to detach receipts out from under the submitter.
--
-- Already applied live via Supabase MCP on 2026-05-16.

CREATE POLICY expense_attachments_delete ON ops.expense_request_attachments
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ops.expense_requests r
      WHERE r.id = request_id
        AND r.submitted_by = auth.uid()
    )
  );

CREATE POLICY expense_attach_storage_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'expense-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
