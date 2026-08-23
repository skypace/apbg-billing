-- Hotfix for v0.9.22 — an older fn_list_categories(p_start, p_end) already
-- exists for category sales rollups. PostgREST PGRST203 fires when both
-- signatures match a no-arg call. Rename the new zero-arg helper to
-- fn_list_category_options. The legacy fn_list_categories(date, date)
-- stays untouched.

DROP FUNCTION IF EXISTS ops.fn_list_categories();

CREATE OR REPLACE FUNCTION ops.fn_list_category_options()
RETURNS TABLE(label text, source text, count bigint)
LANGUAGE sql STABLE
SET search_path TO 'ops', 'public'
AS $$
  WITH all_cats AS (
    SELECT s.category_override AS label, 'override'::text AS source
      FROM ops.inventory_settings s
     WHERE s.category_override IS NOT NULL AND s.category_override <> ''
    UNION ALL
    SELECT it.category_path AS label, 'qbo'::text AS source
      FROM ops.qbo_items it
     WHERE it.category_path IS NOT NULL AND it.category_path <> ''
  )
  SELECT a.label,
         CASE WHEN bool_or(a.source = 'override') AND bool_or(a.source = 'qbo') THEN 'both'
              WHEN bool_or(a.source = 'override') THEN 'override'
              ELSE 'qbo' END AS source,
         count(*) AS count
    FROM all_cats a
   GROUP BY a.label
   ORDER BY a.label;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_list_category_options() TO authenticated, anon;
