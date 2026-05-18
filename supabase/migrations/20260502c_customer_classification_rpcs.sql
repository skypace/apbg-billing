-- RPCs powering the dashboard's Customers classification page.
-- Applied to live DB on 2026-05-02.

CREATE OR REPLACE FUNCTION ops.fn_customer_classification_list(
  p_search    text DEFAULT NULL,
  p_channel   text DEFAULT NULL,
  p_start     date DEFAULT '2025-01-01',
  p_end       date DEFAULT current_date,
  p_limit     int  DEFAULT 200,
  p_offset    int  DEFAULT 0
) RETURNS TABLE (
  qbo_customer_id text,
  display_name    text,
  is_sub_customer boolean,
  active          boolean,
  state           text,
  customer_type_name text,
  ytd_revenue     numeric,
  invoice_count   bigint,
  channels        text[],
  primary_channel text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH rev AS (
    SELECT i.customer_ref_id,
           sum(l.amount)::numeric AS rev,
           count(DISTINCT i.id)::bigint AS inv_count
    FROM ops.qbo_invoice_lines l
    JOIN ops.qbo_invoices i ON i.id = l.invoice_id
    WHERE i.txn_date >= p_start AND i.txn_date <= p_end
    GROUP BY 1
  ),
  ch AS (
    SELECT cc.qbo_customer_id,
           array_agg(c.label ORDER BY c.sort_order) AS channels,
           max(c.label) FILTER (WHERE cc.is_primary) AS primary_channel
    FROM ops.customer_channels cc
    JOIN ops.channels c ON c.channel_code = cc.channel_code AND c.is_active
    GROUP BY 1
  )
  SELECT
    qc.qbo_customer_id,
    qc.display_name,
    qc.is_sub_customer,
    qc.active,
    qc.bill_addr_state AS state,
    qc.customer_type_name,
    COALESCE(r.rev, 0) AS ytd_revenue,
    COALESCE(r.inv_count, 0) AS invoice_count,
    COALESCE(ch.channels, ARRAY[]::text[]) AS channels,
    ch.primary_channel
  FROM ops.qbo_customers qc
  LEFT JOIN rev r  ON r.customer_ref_id = qc.qbo_customer_id
  LEFT JOIN ch     ON ch.qbo_customer_id = qc.qbo_customer_id
  WHERE qc.active
    AND (p_search IS NULL OR p_search = '' OR qc.display_name ILIKE '%' || p_search || '%')
    AND (
      p_channel IS NULL OR p_channel = ''
      OR (p_channel = 'unassigned' AND ch.channels IS NULL)
      OR (p_channel <> 'unassigned' AND p_channel = ANY(COALESCE(ch.channels, ARRAY[]::text[])))
    )
  ORDER BY COALESCE(r.rev, 0) DESC NULLS LAST, qc.display_name
  LIMIT GREATEST(COALESCE(p_limit, 200), 1)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

GRANT EXECUTE ON FUNCTION ops.fn_customer_classification_list(text, text, date, date, int, int) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_set_customer_channels(
  p_qbo_customer_id text,
  p_channel_labels  text[],
  p_primary_label   text DEFAULT NULL,
  p_set_by          text DEFAULT 'dashboard'
) RETURNS TABLE (channel_code text, is_primary boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
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

  DELETE FROM ops.customer_channels
   WHERE qbo_customer_id = p_qbo_customer_id
     AND NOT channel_code = ANY(v_codes);

  UPDATE ops.customer_channels
     SET is_primary = false
   WHERE qbo_customer_id = p_qbo_customer_id;

  INSERT INTO ops.customer_channels (qbo_customer_id, channel_code, is_primary, set_by, set_at)
  SELECT p_qbo_customer_id, code, (code = v_primary_code), p_set_by, now()
    FROM unnest(v_codes) AS code
  ON CONFLICT (qbo_customer_id, channel_code) DO UPDATE
     SET is_primary = EXCLUDED.is_primary,
         set_by = EXCLUDED.set_by,
         set_at = EXCLUDED.set_at;

  RETURN QUERY
    SELECT cc.channel_code, cc.is_primary
      FROM ops.customer_channels cc
     WHERE cc.qbo_customer_id = p_qbo_customer_id
     ORDER BY cc.is_primary DESC, cc.channel_code;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_set_customer_channels(text, text[], text, text) TO anon, authenticated;
