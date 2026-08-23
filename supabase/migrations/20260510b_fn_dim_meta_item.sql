-- Extend fn_dim_meta with p_dim = 'item' branch.
-- Returns per-item attributes (SKU, type, category_path, account refs),
-- master pricing/cost (unit_price, purchase_cost), and inventory state.

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
          c.bill_addr_line1, c.bill_addr_city, c.bill_addr_state, c.bill_addr_postal,
          c.ship_addr_city, c.ship_addr_state,
          c.phone, c.email, c.customer_type_name,
          c.parent_ref_id, c.is_sub_customer,
          c.lat, c.lon, c.geocode_status
        FROM unnest(p_labels) AS label
        JOIN ops.qbo_customers c
          ON c.display_name = label OR c.fully_qualified_name = label
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

  ELSIF p_dim = 'item' THEN
    RETURN QUERY
      WITH matched AS (
        SELECT DISTINCT ON (label)
          label,
          i.qbo_item_id,
          i.name, i.fully_qualified_name,
          i.sku, i.type, i.active, i.taxable,
          i.unit_price, i.purchase_cost, i.qty_on_hand,
          i.income_account_name, i.expense_account_name, i.asset_account_name,
          i.category_path, i.parent_ref_id
        FROM unnest(p_labels) AS label
        JOIN ops.qbo_items i
          ON i.fully_qualified_name = label OR i.name = label
        ORDER BY label, (i.fully_qualified_name = label) DESC, i.active DESC
      )
      SELECT
        m.label::text AS dim_label,
        jsonb_build_object(
          'sku',              m.sku,
          'item_type',        m.type,
          'active',           m.active,
          'taxable',          m.taxable,
          'list_price',       m.unit_price,
          'item_cost',        m.purchase_cost,
          'on_hand',          m.qty_on_hand,
          'inventory_value',
            CASE
              WHEN m.qty_on_hand IS NOT NULL AND m.purchase_cost IS NOT NULL
                THEN (m.qty_on_hand * m.purchase_cost)
              ELSE NULL
            END,
          'category_path',    m.category_path,
          'income_account',   m.income_account_name,
          'expense_account',  m.expense_account_name,
          'asset_account',    m.asset_account_name,
          'parent_ref_id',    m.parent_ref_id
        ) AS meta
      FROM matched m;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_dim_meta(text, text[]) TO authenticated;
