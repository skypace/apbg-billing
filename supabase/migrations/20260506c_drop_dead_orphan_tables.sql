-- Drop two confirmed-dead orphan tables.
--
-- Investigation summary (sync-manifest.json orphans, audited 2026-05-06):
--
--   ops.kpi_embeddings
--     0 rows in prod, no cron writer, no UI references, no RPC consumers.
--     Likely experimental / abandoned. Manifest had it as orphan with
--     "drop in a future cleanup unless someone claims it." This is that
--     cleanup.
--
--   ops.qbo_expenses
--     0 rows in prod. The running sync-qbo-expenses cron (09:40 UTC) writes
--     ops.qbo_expense_lines instead, which is the table dashboards actually
--     read. The qbo_expenses header table was a planned aggregate that never
--     got wired. CLAUDE.md (apbg-billing) §3.A originally described it; the
--     header rollup can be re-added later as a view over qbo_expense_lines
--     if needed, no need to keep an empty stub around.
--
-- Both drops are safe in the sense that:
--   - No code in this repo references either table outside the historical
--     migration that originally created them (and a UNIQUE constraint
--     migration in 20260503g for qbo_expenses that becomes a no-op).
--   - The lint manifest's orphan entries will be removed in the same PR.
--
-- CASCADE on DROP TABLE drops any dependent objects (foreign keys, views).
-- No known dependents on either table at apply time, but CASCADE is
-- defensive against drift.

DROP TABLE IF EXISTS ops.kpi_embeddings CASCADE;
DROP TABLE IF EXISTS ops.qbo_expenses CASCADE;
