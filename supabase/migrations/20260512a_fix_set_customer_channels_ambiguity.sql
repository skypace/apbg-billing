-- Hotfix: ops.fn_set_customer_channels was raising
--   42702 column reference "channel_code" is ambiguous
-- when called from Settings → Customer Classification.
--
-- The function declares RETURNS TABLE (channel_code text, is_primary boolean),
-- which makes those names PL/pgSQL OUT variables. They collide with the
-- ops.customer_channels columns of the same name in the DELETE WHERE clause
-- and ON CONFLICT clause. Add #variable_conflict use_column so PostgreSQL
-- prefers the column when names collide (we never assign to the OUT vars
-- explicitly — RETURN QUERY supplies them), and qualify column references
-- defensively.

CREATE OR REPLACE FUNCTION ops.fn_set_customer_channels(
  p_qbo_customer_id text,
  p_channel_labels  text[],
  p_primary_label   text DEFAULT NULL,
  p_set_by          text DEFAULT 'dashboard'
) RETURNS TABLE (channel_code text, is_primary boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
#variable_conflict use_column
DECLARE
  v_codes text[];
  v_primary_code text;
BEGIN
  IF p_qbo_customer_id IS NULL THEN RAISE EXCEPTION 'customer id required'; END IF;

  SELECT array_agg(c.channel_code)
    INTO v_codes
    FROM ops.channels c
   WHERE c.label = ANY(COALESCE(p_channel_labels, ARRAY[]::text[]));
  IF v_codes IS NULL THEN v_codes := ARRAY[]::text[]; END IF;

  IF p_primary_label IS NOT NULL THEN
    SELECT c.channel_code INTO v_primary_code
      FROM ops.channels c WHERE c.label = p_primary_label;
    IF v_primary_code IS NOT NULL AND NOT v_primary_code = ANY(v_codes) THEN
      v_primary_code := NULL;
    END IF;
  END IF;

  DELETE FROM ops.customer_channels cc
   WHERE cc.qbo_customer_id = p_qbo_customer_id
     AND NOT cc.channel_code = ANY(v_codes);

  UPDATE ops.customer_channels cc
     SET is_primary = false
   WHERE cc.qbo_customer_id = p_qbo_customer_id;

  INSERT INTO ops.customer_channels AS cc (qbo_customer_id, channel_code, is_primary, set_by, set_at)
  SELECT p_qbo_customer_id, code, (code = v_primary_code), p_set_by, now()
    FROM unnest(v_codes) AS code
  ON CONFLICT (qbo_customer_id, channel_code) DO UPDATE
     SET is_primary = EXCLUDED.is_primary,
         set_by     = EXCLUDED.set_by,
         set_at     = EXCLUDED.set_at;

  RETURN QUERY
    SELECT cc.channel_code, cc.is_primary
      FROM ops.customer_channels cc
     WHERE cc.qbo_customer_id = p_qbo_customer_id
     ORDER BY cc.is_primary DESC, cc.channel_code;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_set_customer_channels(text, text[], text, text) TO authenticated;
