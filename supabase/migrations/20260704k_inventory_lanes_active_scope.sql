-- v0.9.45a — keep automatic inventory lanes scoped to active operational items.
--
-- Reviewed manual lane assignments are preserved. The automatic seed should not
-- make deleted/inactive QuickBooks items part of daily inventory planning.

WITH classified AS (
  SELECT
    it.qbo_item_id,
    COALESCE(it.active, true) AS active,
    lower(
      concat_ws(' ',
        it.name,
        it.fully_qualified_name,
        it.category_path,
        it.income_account_name,
        ipf.family_code,
        ipt.type_code
      )
    ) AS haystack,
    ipf.family_code
  FROM ops.qbo_items it
  LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.item_product_types ipt ON ipt.qbo_item_id = it.qbo_item_id
  WHERE COALESCE(it.type, '') NOT IN ('Category', 'Group')
),
lanes AS (
  SELECT
    qbo_item_id,
    active,
    CASE
      WHEN active
       AND family_code = 'bib'
       AND haystack ~ '(^|[^a-z0-9])3[[:space:]]*g([^a-z0-9]|$)|(^|[^a-z0-9])3g(ns?)?[0-9]'
        THEN 'bib_product'
      WHEN active
       AND family_code = 'bib'
       AND haystack ~ '(^|[^a-z0-9])5[[:space:]]*g([^a-z0-9]|$)|(^|[^a-z0-9])5g(ns?)?[0-9]'
        THEN 'bib_product'
      WHEN active
       AND family_code = 'can'
       AND haystack ~ '(^|[^a-z0-9])24[[:space:]]*(p|pk|pack|packs|case|cs)([^a-z0-9]|$)|(^|[^a-z0-9])24p(k)?[0-9]'
       AND haystack !~ '(^|[^a-z0-9])(6|12)[[:space:]]*(p|pk|pack|packs|case|cs)([^a-z0-9]|$)'
        THEN 'cans_24pk'
      ELSE 'excluded'
    END AS inventory_lane,
    CASE
      WHEN active
       AND family_code = 'bib'
       AND haystack ~ '(^|[^a-z0-9])3[[:space:]]*g([^a-z0-9]|$)|(^|[^a-z0-9])3g(ns?)?[0-9]'
        THEN '3g'
      WHEN active
       AND family_code = 'bib'
       AND haystack ~ '(^|[^a-z0-9])5[[:space:]]*g([^a-z0-9]|$)|(^|[^a-z0-9])5g(ns?)?[0-9]'
        THEN '5g'
      WHEN active
       AND family_code = 'can'
       AND haystack ~ '(^|[^a-z0-9])24[[:space:]]*(p|pk|pack|packs|case|cs)([^a-z0-9]|$)|(^|[^a-z0-9])24p(k)?[0-9]'
       AND haystack !~ '(^|[^a-z0-9])(6|12)[[:space:]]*(p|pk|pack|packs|case|cs)([^a-z0-9]|$)'
        THEN '24pk'
      ELSE NULL
    END AS inventory_lane_size
  FROM classified
)
INSERT INTO ops.inventory_settings (
  qbo_item_id,
  inventory_lane,
  inventory_lane_size,
  inventory_lane_source,
  inventory_lane_reviewed,
  is_managed,
  is_planner,
  target_days_supply,
  lead_time_days,
  track_locations,
  has_bom,
  updated_at
)
SELECT
  qbo_item_id,
  inventory_lane,
  inventory_lane_size,
  'auto',
  FALSE,
  active AND inventory_lane <> 'excluded',
  FALSE,
  30,
  7,
  active AND inventory_lane <> 'excluded',
  active AND inventory_lane = 'cans_24pk',
  now()
FROM lanes
ON CONFLICT (qbo_item_id) DO UPDATE SET
  inventory_lane = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.inventory_lane
    ELSE EXCLUDED.inventory_lane
  END,
  inventory_lane_size = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.inventory_lane_size
    ELSE EXCLUDED.inventory_lane_size
  END,
  inventory_lane_source = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.inventory_lane_source
    ELSE 'auto'
  END,
  inventory_lane_reviewed = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.inventory_lane_reviewed
    ELSE FALSE
  END,
  is_managed = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.is_managed
    ELSE EXCLUDED.is_managed
  END,
  track_locations = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.track_locations
    ELSE EXCLUDED.track_locations
  END,
  has_bom = CASE
    WHEN ops.inventory_settings.inventory_lane_source = 'manual'
     AND ops.inventory_settings.inventory_lane_reviewed THEN ops.inventory_settings.has_bom
    ELSE EXCLUDED.has_bom
  END,
  updated_at = now();
