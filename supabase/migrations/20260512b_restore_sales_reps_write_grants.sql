-- Hotfix: sales-rep saves were failing with
--   42501 permission denied for table customer_sales_reps
-- (and the same on ops.sales_reps).
--
-- Both tables exist in live and are queried via fn_customers_master, but the
-- INSERT/UPDATE/DELETE grants that 20260503f originally set up for the
-- authenticated role were missing. The May-5 "drop rep tables" migration
-- (20260505d) was apparently never applied — or the tables were recreated
-- afterward without re-establishing write privileges. Either way the UI
-- (Customers settings → primary sales rep dropdown, and the Sales Reps CRUD
-- page) does direct PostgREST writes, which require these grants.
--
-- We don't re-enable RLS here. RLS is currently disabled on both tables, and
-- the original policies were unconstrained (USING (true)) — functionally
-- equivalent to RLS-off. Keeping RLS-off until/unless a real row-level
-- restriction is needed.

GRANT INSERT, UPDATE, DELETE ON ops.sales_reps          TO authenticated;
GRANT INSERT, UPDATE, DELETE ON ops.customer_sales_reps TO authenticated;
