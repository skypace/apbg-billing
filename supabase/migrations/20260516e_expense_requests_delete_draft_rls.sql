-- DELETE policy for ops.expense_requests so the new-flow INSERT rollback
-- in ExpenseForm's handleSubmit catch can actually clean up an orphan
-- draft row when upload/attach/notify fails. Before this migration the
-- table had only SELECT/INSERT/UPDATE policies (20260512o + 20260512s),
-- so PostgREST silently denied the DELETE — supabase-js returned
-- { data: [], error: null }, the surrounding try/catch never fired,
-- and the rollback was theater. Every transient upload failure left an
-- orphan in the dashboard's recent-submissions list with no in-app
-- way to clean it up.
--
-- Scoped to status='draft' + submitted_by=auth.uid() so submitters
-- cannot purge their own posted/QBO-linked rows. Matches the
-- documented client-side .eq('status','draft') filter on the rollback
-- call.
--
-- Already applied live via Supabase MCP on 2026-05-16.

DROP POLICY IF EXISTS expense_requests_delete_own_draft ON ops.expense_requests;
CREATE POLICY expense_requests_delete_own_draft ON ops.expense_requests
  FOR DELETE TO authenticated
  USING (submitted_by = auth.uid() AND status = 'draft');
