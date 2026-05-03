-- Lists every distinct item from invoice lines with revenue, current
-- effective segment, override status, and most-common category.
-- Powers the Settings → Products page.
-- Applied to live DB on 2026-05-02.

CREATE OR REPLACE FUNCTION ops.fn_list_items(
  p_start  date    DEFAULT '2025-01-01',
  p_end    date    DEFAULT current_date,
  p_search text    DEFAULT NULL,
  p_filter text    DEFAULT NULL,
  p_limit  int     DEFAULT 1000
) RETURNS TABLE (
  item_name           text,
  qbo_item_id         text,
  item_type           text,
  income_account_name text,
  ytd_revenue         numeric,
  ytd_qty             numeric,
  line_count          bigint,
  top_category        text,
  effective_segment   text,
  override_segment_code text,
  active              boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH base AS (
    SELECT
      item_name, item_ref_id,
      sum(revenue)::numeric AS rev,
      sum(quantity)::numeric AS qty,
      count(*)::bigint AS lines,
      mode() WITHIN GROUP (ORDER BY category) AS top_category,
      mode() WITHIN GROUP (ORDER BY segment)  AS top_segment
    FROM ops.v_sales_lines
    WHERE txn_date >= p_start AND txn_date <= p_end
    GROUP BY 1, 2
  )
  SELECT
    b.item_name, b.item_ref_id, it.type, it.income_account_name,
    b.rev, b.qty, b.lines, b.top_category, b.top_segment,
    is_map.segment_code, COALESCE(it.active, true)
  FROM base b
  LEFT JOIN ops.qbo_items it ON it.qbo_item_id = b.item_ref_id
  LEFT JOIN ops.item_segments is_map ON is_map.item_name = b.item_name
  WHERE
    (p_search IS NULL OR p_search = '' OR b.item_name ILIKE '%' || p_search || '%')
    AND (
      p_filter IS NULL OR p_filter = ''
      OR (p_filter = 'unmapped' AND b.top_segment IS NULL)
      OR (p_filter <> 'unmapped' AND p_filter = b.top_segment)
    )
  ORDER BY b.rev DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 1000), 1);
$$;

GRANT EXECUTE ON FUNCTION ops.fn_list_items(date, date, text, text, int) TO anon, authenticated;
