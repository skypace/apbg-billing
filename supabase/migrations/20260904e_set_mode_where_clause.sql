-- 20260904e — fn_sales_ledger_set_mode: the UPDATE needs a WHERE clause.
--
-- Reported (Sky, 2026-09-04): flipping the sales feed from the Stock → On-Hand
-- panel failed with
--   rpc fn_sales_ledger_set_mode failed: 400 {"code":"21000","message":"UPDATE requires a WHERE clause"}
--
-- Cause: the PostgREST role (authenticator) runs with
-- session_preload_libraries=safeupdate, which refuses any UPDATE or DELETE that
-- carries no WHERE clause — SQLSTATE 21000. `ops.sales_ledger_config` is a
-- one-row table, so 20260902x wrote `UPDATE … SET mode = …;` with no WHERE.
-- Every check of that function was run as postgres (the MCP / pg_cron), where
-- safeupdate is not loaded, so the UI button was never actually exercised.
--
-- Rule for any function reachable through PostgREST: a single-row config
-- table is still updated WITH a WHERE (its key column), never bare. Swept every
-- ops function for the same shape: this was the only one.
--
-- Not generator-wrapped (20260902x gave it an inline staff guard, and there is
-- no __i inner), so CREATE OR REPLACE is the right edit here.

CREATE OR REPLACE FUNCTION ops.fn_sales_ledger_set_mode(p_mode text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'ops', 'pg_temp'
AS $$
BEGIN
  IF NOT ops.fn_is_staff() THEN RAISE EXCEPTION 'staff only'; END IF;
  IF p_mode NOT IN ('off','shadow','live') THEN
    RAISE EXCEPTION 'mode must be off, shadow or live';
  END IF;
  UPDATE ops.sales_ledger_config
     SET mode = p_mode, updated_at = now()
   WHERE only_row = true;
  IF NOT FOUND THEN
    INSERT INTO ops.sales_ledger_config (only_row, mode) VALUES (true, p_mode);
  END IF;
  RETURN p_mode;
END;
$$;

REVOKE EXECUTE ON FUNCTION ops.fn_sales_ledger_set_mode(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ops.fn_sales_ledger_set_mode(text) TO authenticated, service_role;
