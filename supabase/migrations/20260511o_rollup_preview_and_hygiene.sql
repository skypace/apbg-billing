-- v0.9.26 — Data hygiene tooling.

CREATE OR REPLACE FUNCTION ops.fn_preview_rollup_match(
  p_customers  text[] DEFAULT NULL,
  p_categories text[] DEFAULT NULL,
  p_items      text[] DEFAULT NULL,
  p_channels   text[] DEFAULT NULL,
  p_segments   text[] DEFAULT NULL,
  p_start      date   DEFAULT (current_date - 365),
  p_end        date   DEFAULT current_date
)
RETURNS TABLE(
  match_mode               text,
  matched_customers        integer,
  matched_categories       integer,
  matched_items            integer,
  matched_line_count       bigint,
  matched_revenue          numeric,
  sample_customer_names    text[],
  sample_category_names    text[],
  sample_item_names        text[]
)
LANGUAGE plpgsql STABLE
SET search_path TO 'ops', 'public'
AS $$
DECLARE
  use_customers  boolean := p_customers  IS NOT NULL AND array_length(p_customers, 1) > 0;
  use_categories boolean := p_categories IS NOT NULL AND array_length(p_categories, 1) > 0;
  use_items      boolean := p_items      IS NOT NULL AND array_length(p_items, 1) > 0;
  use_channels   boolean := p_channels   IS NOT NULL AND array_length(p_channels, 1) > 0;
  use_segments   boolean := p_segments   IS NOT NULL AND array_length(p_segments, 1) > 0;
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT v.*
      FROM ops.v_sales_lines v
     WHERE v.txn_date >= p_start AND v.txn_date <= p_end
  ),
  matched AS (
    SELECT b.*
      FROM base b
     WHERE
       (NOT use_customers OR EXISTS (
         SELECT 1 FROM unnest(p_customers) pat
          WHERE b.customer_name ILIKE '%' || pat || '%'
       ))
       AND (NOT use_categories OR EXISTS (
         SELECT 1 FROM unnest(p_categories) pat
          WHERE b.category ILIKE '%' || pat || '%'
       ))
       AND (NOT use_items OR EXISTS (
         SELECT 1 FROM unnest(p_items) pat
          WHERE b.item_name ILIKE '%' || pat || '%'
       ))
       AND (NOT use_channels OR EXISTS (
         SELECT 1 FROM unnest(p_channels) pat
          WHERE pat = ANY(b.channels) OR b.primary_channel ILIKE '%' || pat || '%'
       ))
       AND (NOT use_segments OR EXISTS (
         SELECT 1 FROM unnest(p_segments) pat
          WHERE b.segment ILIKE '%' || pat || '%'
       ))
  )
  SELECT
    'fuzzy ILIKE'::text,
    (SELECT count(DISTINCT customer_name)::integer FROM matched),
    (SELECT count(DISTINCT category)::integer      FROM matched),
    (SELECT count(DISTINCT item_name)::integer     FROM matched),
    (SELECT count(*)::bigint                       FROM matched),
    (SELECT coalesce(sum(revenue), 0)::numeric     FROM matched),
    (SELECT array_agg(DISTINCT customer_name ORDER BY customer_name)
       FROM (SELECT customer_name FROM matched LIMIT 200) s),
    (SELECT array_agg(DISTINCT category ORDER BY category)
       FROM (SELECT category FROM matched LIMIT 200) s),
    (SELECT array_agg(DISTINCT item_name ORDER BY item_name)
       FROM (SELECT item_name FROM matched LIMIT 200) s);
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_preview_rollup_match(text[], text[], text[], text[], text[], date, date) TO authenticated, anon;


CREATE OR REPLACE FUNCTION ops.fn_item_hygiene_summary()
RETURNS TABLE(
  bucket                text,
  label                 text,
  item_count            integer,
  detail                jsonb
)
LANGUAGE sql STABLE
SET search_path TO 'ops', 'public'
AS $$
  WITH items AS (
    SELECT
      it.qbo_item_id,
      it.name,
      it.active,
      it.income_account_name,
      COALESCE(s.category_override, it.category_path) AS category_resolved,
      it.category_path
    FROM ops.qbo_items it
    LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
    WHERE COALESCE(it.active, true)
  ),
  audit AS (
    SELECT * FROM ops.fn_item_pl_audit(3) WHERE active
  )
  SELECT 'no_income_account' AS bucket,
         'No income account in QBO' AS label,
         count(*)::integer AS item_count,
         to_jsonb(array_agg(name ORDER BY name)) AS detail
    FROM items
   WHERE income_account_name IS NULL OR income_account_name = ''
  UNION ALL
  SELECT 'no_category',
         'No category (neither QBO path nor override)',
         count(*)::integer,
         to_jsonb(array_agg(name ORDER BY name))
    FROM items
   WHERE category_resolved IS NULL OR category_resolved = ''
  UNION ALL
  SELECT 'isolated_in_account',
         'Alone or nearly alone in their P&L account',
         count(*)::integer,
         to_jsonb(array_agg(item_name ORDER BY item_name))
    FROM audit
   WHERE alignment_status = 'isolated'
  UNION ALL
  SELECT 'account_uncategorized',
         'Account itself mostly uncategorized — needs review',
         count(*)::integer,
         to_jsonb(array_agg(item_name ORDER BY item_name))
    FROM audit
   WHERE alignment_status = 'unclassified_account';
$$;
GRANT EXECUTE ON FUNCTION ops.fn_item_hygiene_summary() TO authenticated, anon;
