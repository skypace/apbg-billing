-- fn_dim_meta(p_dim, p_labels[]) -> per-label metadata for Smart Columns.
-- Phase 2A: customer dim. Returns a single jsonb blob per label so the
-- RPC signature can grow without changes on the frontend wrapper.
--
-- Matching strategy: prefer display_name match, fall back to
-- fully_qualified_name (DISTINCT ON keeps one row per requested label).

CREATE OR REPLACE FUNCTION ops.fn_dim_meta(
  p_dim    text,
  p_labels text[]
)
RETURNS TABLE (
  dim_label text,
  meta      jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ops, public
AS $$
BEGIN
  IF p_labels IS NULL OR array_length(p_labels, 1) IS NULL THEN
    RETURN;
  END IF;

  IF p_dim = 'customer' THEN
    RETURN QUERY
      WITH matched AS (
        SELECT DISTINCT ON (label)
          label,
          c.qbo_customer_id,
          c.display_name,
          c.fully_qualified_name,
          c.bill_addr_line1,
          c.bill_addr_city,
          c.bill_addr_state,
          c.bill_addr_postal,
          c.ship_addr_city,
          c.ship_addr_state,
          c.phone,
          c.email,
          c.customer_type_name,
          c.parent_ref_id,
          c.is_sub_customer,
          c.lat,
          c.lon,
          c.geocode_status
        FROM unnest(p_labels) AS label
        JOIN ops.qbo_customers c
          ON c.display_name = label
          OR c.fully_qualified_name = label
        ORDER BY label, (c.display_name = label) DESC, c.is_sub_customer ASC
      )
      SELECT
        m.label::text AS dim_label,
        jsonb_build_object(
          'bill_addr_line1',  m.bill_addr_line1,
          'bill_addr_city',   m.bill_addr_city,
          'bill_addr_state',  m.bill_addr_state,
          'bill_addr_postal', m.bill_addr_postal,
          'ship_addr_city',   m.ship_addr_city,
          'ship_addr_state',  m.ship_addr_state,
          'phone',            m.phone,
          'email',            m.email,
          'customer_type',    m.customer_type_name,
          'parent_ref_id',    m.parent_ref_id,
          'is_sub_customer',  m.is_sub_customer,
          'primary_channel', (
            SELECT ch.label
            FROM ops.customer_channels cc
            JOIN ops.channels ch ON ch.channel_code = cc.channel_code
            WHERE cc.qbo_customer_id = m.qbo_customer_id
              AND cc.is_primary = true
            LIMIT 1
          ),
          'lat',            m.lat,
          'lon',            m.lon,
          'geocode_status', m.geocode_status
        ) AS meta
      FROM matched m;
  END IF;

  -- Phase 2B (v0.9.2) will add p_dim = 'item' branch here.
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_dim_meta(text, text[]) TO authenticated;
