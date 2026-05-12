-- v0.9.23 — Item ↔ Category ↔ P&L alignment.
--
-- Every QBO item flows revenue into a specific P&L income account
-- (qbo_items.income_account_name). Items that share an account should
-- usually share a category — that's how the P&L roll-up actually works.
--
-- fn_item_pl_audit  → per-item alignment report (current vs. dominant
--                     category for its income account, with a suggested
--                     fix when consensus is >= 60% and at least 3 items
--                     share the account).
-- fn_apply_pl_category_suggestions → bulk-apply with dry-run support.
--
-- Suggestions exclude "Uncategorized" as a target — if an account is
-- dominated by uncategorized items, the account itself needs human
-- review, not auto-flattening.

CREATE OR REPLACE FUNCTION ops.fn_item_pl_audit(
  p_min_account_items integer DEFAULT 3
)
RETURNS TABLE(
  qbo_item_id                     text,
  item_name                       text,
  active                          boolean,
  income_account_name             text,
  expense_account_name            text,
  current_category                text,
  category_override               text,
  dominant_category_for_account   text,
  account_item_count              integer,
  account_category_consensus_pct  numeric,
  alignment_status                text,
  suggested_category              text
)
LANGUAGE sql STABLE
SET search_path TO 'ops', 'public'
AS $$
  WITH item_cat AS (
    SELECT
      it.qbo_item_id,
      COALESCE(it.name, it.fully_qualified_name) AS item_name,
      COALESCE(it.active, true)                  AS active,
      it.income_account_name,
      it.expense_account_name,
      COALESCE(s.category_override, it.category_path, 'Uncategorized') AS current_category,
      s.category_override
    FROM ops.qbo_items it
    LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
  ),
  account_groups AS (
    SELECT
      ic.income_account_name,
      ic.current_category,
      count(*)::integer AS n
    FROM item_cat ic
    WHERE ic.income_account_name IS NOT NULL AND ic.income_account_name <> ''
      AND ic.active
      AND ic.current_category <> 'Uncategorized'  -- exclude from dominance calc
    GROUP BY 1, 2
  ),
  account_totals AS (
    SELECT
      income_account_name,
      count(*) FILTER (WHERE active)::integer AS total_active
    FROM item_cat
    WHERE income_account_name IS NOT NULL AND income_account_name <> ''
    GROUP BY 1
  ),
  account_dominant AS (
    SELECT DISTINCT ON (g.income_account_name)
      g.income_account_name,
      g.current_category AS dominant_category,
      g.n                AS dominant_count,
      t.total_active     AS account_total
    FROM account_groups g
    JOIN account_totals t USING (income_account_name)
    ORDER BY g.income_account_name, g.n DESC, g.current_category
  )
  SELECT
    ic.qbo_item_id,
    ic.item_name,
    ic.active,
    ic.income_account_name,
    ic.expense_account_name,
    ic.current_category,
    ic.category_override,
    ad.dominant_category,
    ad.account_total,
    CASE WHEN ad.account_total > 0 AND ad.dominant_count IS NOT NULL
         THEN ROUND((ad.dominant_count::numeric / ad.account_total) * 100, 1)
         ELSE NULL END AS account_category_consensus_pct,
    CASE
      WHEN ic.income_account_name IS NULL OR ic.income_account_name = '' THEN 'no_account'
      WHEN ad.dominant_category IS NULL THEN 'unclassified_account'
      WHEN ad.account_total < p_min_account_items THEN 'isolated'
      WHEN ic.current_category = ad.dominant_category THEN 'aligned'
      ELSE 'misaligned'
    END AS alignment_status,
    CASE
      WHEN ad.dominant_category IS NOT NULL
       AND ad.dominant_category <> 'Uncategorized'
       AND ic.current_category <> ad.dominant_category
       AND ad.account_total >= p_min_account_items
       AND (ad.dominant_count::numeric / ad.account_total) >= 0.60
      THEN ad.dominant_category
      ELSE NULL
    END AS suggested_category
  FROM item_cat ic
  LEFT JOIN account_dominant ad USING (income_account_name);
$$;
GRANT EXECUTE ON FUNCTION ops.fn_item_pl_audit(integer) TO authenticated, anon;


CREATE OR REPLACE FUNCTION ops.fn_apply_pl_category_suggestions(
  p_min_account_items integer DEFAULT 3,
  p_min_consensus_pct numeric DEFAULT 60,
  p_dry_run           boolean DEFAULT true
)
RETURNS TABLE(
  qbo_item_id    text,
  item_name      text,
  from_category  text,
  to_category    text,
  income_account text,
  applied        boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT
      a.qbo_item_id, a.item_name, a.current_category,
      a.suggested_category, a.income_account_name
    FROM ops.fn_item_pl_audit(p_min_account_items) a
    WHERE a.suggested_category IS NOT NULL
      AND a.account_category_consensus_pct >= p_min_consensus_pct
      AND a.alignment_status = 'misaligned'
      AND a.active
  LOOP
    IF NOT p_dry_run THEN
      INSERT INTO ops.inventory_settings (qbo_item_id, category_override, updated_at)
      VALUES (rec.qbo_item_id, rec.suggested_category, now())
      ON CONFLICT (qbo_item_id) DO UPDATE
        SET category_override = EXCLUDED.category_override,
            updated_at        = now();
    END IF;
    qbo_item_id    := rec.qbo_item_id;
    item_name      := rec.item_name;
    from_category  := rec.current_category;
    to_category    := rec.suggested_category;
    income_account := rec.income_account_name;
    applied        := NOT p_dry_run;
    RETURN NEXT;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_apply_pl_category_suggestions(integer, numeric, boolean) TO authenticated;
