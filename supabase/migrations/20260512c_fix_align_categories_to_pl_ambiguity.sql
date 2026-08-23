-- Hotfix: ops.fn_align_categories_to_pl was raising
--   42702 column reference "qbo_item_id" is ambiguous
-- when called from the Items master "Align to P&L" action.
--
-- The function declares RETURNS TABLE(qbo_item_id text, ...) which makes
-- that an OUT variable, then references the same name as a column in the
-- INSERT ... ON CONFLICT (qbo_item_id) clause. Add #variable_conflict
-- use_column so PostgreSQL prefers the column on conflict — the OUT
-- variables are only assigned via `:=` (which is unambiguous PL/pgSQL
-- syntax, unaffected by use_column).

CREATE OR REPLACE FUNCTION ops.fn_align_categories_to_pl(
  p_commit boolean DEFAULT false
)
RETURNS TABLE(
  qbo_item_id         text,
  item_name           text,
  income_account_name text,
  from_category       text,
  to_category         text,
  status              text,
  applied             boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
#variable_conflict use_column
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT
      it.qbo_item_id,
      COALESCE(it.name, it.fully_qualified_name) AS item_name,
      it.income_account_name,
      COALESCE(s.category_override, it.category_path, 'Uncategorized') AS current_category
    FROM ops.qbo_items it
    LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
    WHERE COALESCE(it.active, true) = true
  LOOP
    IF rec.income_account_name IS NULL OR rec.income_account_name = '' THEN
      qbo_item_id         := rec.qbo_item_id;
      item_name           := rec.item_name;
      income_account_name := rec.income_account_name;
      from_category       := rec.current_category;
      to_category         := NULL;
      status              := 'skipped_no_account';
      applied             := false;
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF rec.current_category = rec.income_account_name THEN
      qbo_item_id         := rec.qbo_item_id;
      item_name           := rec.item_name;
      income_account_name := rec.income_account_name;
      from_category       := rec.current_category;
      to_category         := rec.income_account_name;
      status              := 'already_aligned';
      applied             := false;
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF p_commit THEN
      INSERT INTO ops.inventory_settings (qbo_item_id, category_override, updated_at)
      VALUES (rec.qbo_item_id, rec.income_account_name, now())
      ON CONFLICT (qbo_item_id) DO UPDATE
        SET category_override = EXCLUDED.category_override,
            updated_at        = now();
    END IF;

    qbo_item_id         := rec.qbo_item_id;
    item_name           := rec.item_name;
    income_account_name := rec.income_account_name;
    from_category       := rec.current_category;
    to_category         := rec.income_account_name;
    status              := 'updated';
    applied             := p_commit;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_align_categories_to_pl(boolean) TO authenticated;
