-- v0.9.35b — Audit log for every QBO writeback.
--
-- Today push-qbo-item (Item.Active flips + Category ParentRef updates)
-- runs fire-and-forget. There's no way to answer "what got pushed today"
-- from our own DB; you have to reconstruct from edge-function HTTP logs
-- or QBO's MetaData.LastUpdatedTime. This adds a first-class audit table
-- the client writes after every writeback call.

CREATE TABLE IF NOT EXISTS ops.qbo_writeback_log (
  id             bigserial PRIMARY KEY,
  action         text NOT NULL,          -- 'setActive', 'bulkSyncCategories', ...
  qbo_item_id    text,                   -- nullable for bulk actions
  before_state   jsonb,                  -- e.g. {active:true, name:'CC-SVCFEE'}
  after_state    jsonb,                  -- e.g. {active:false, name:'CC-SVCFEE (deleted)'}
  result_status  text NOT NULL,          -- 'success' | 'failure' | 'cancelled'
  error_message  text,
  performed_by   text,
  performed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qwl_performed_at ON ops.qbo_writeback_log(performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_qwl_item         ON ops.qbo_writeback_log(qbo_item_id) WHERE qbo_item_id IS NOT NULL;

ALTER TABLE ops.qbo_writeback_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qwl_read ON ops.qbo_writeback_log;
CREATE POLICY qwl_read ON ops.qbo_writeback_log FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON ops.qbo_writeback_log TO anon, authenticated;
GRANT INSERT ON ops.qbo_writeback_log TO authenticated;

CREATE OR REPLACE FUNCTION ops.fn_log_qbo_writeback(
  p_action       text,
  p_qbo_item_id  text,
  p_before       jsonb,
  p_after        jsonb,
  p_result       text,
  p_error        text DEFAULT NULL,
  p_performed_by text DEFAULT 'dashboard'
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO ops.qbo_writeback_log
    (action, qbo_item_id, before_state, after_state, result_status, error_message, performed_by)
  VALUES
    (p_action, p_qbo_item_id, p_before, p_after, p_result, p_error, p_performed_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_log_qbo_writeback(text, text, jsonb, jsonb, text, text, text) TO authenticated;

-- Convenience: "what did I push today?"
CREATE OR REPLACE FUNCTION ops.fn_recent_qbo_writebacks(p_days int DEFAULT 1)
RETURNS TABLE(
  id bigint, action text, qbo_item_id text, item_name text,
  before_state jsonb, after_state jsonb, result_status text,
  error_message text, performed_by text, performed_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  SELECT w.id, w.action, w.qbo_item_id,
         COALESCE(it.name, (w.before_state->>'name'), (w.after_state->>'name')) AS item_name,
         w.before_state, w.after_state, w.result_status,
         w.error_message, w.performed_by, w.performed_at
  FROM ops.qbo_writeback_log w
  LEFT JOIN ops.qbo_items it ON it.qbo_item_id = w.qbo_item_id
  WHERE w.performed_at >= now() - (p_days || ' days')::interval
  ORDER BY w.performed_at DESC;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_recent_qbo_writebacks(int) TO authenticated;
