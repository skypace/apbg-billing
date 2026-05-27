-- Helpers powering the dashboard's Control Panel (Settings).
-- Applied to live DB on 2026-05-02.

CREATE OR REPLACE FUNCTION ops.fn_list_pl_accounts(
  p_start date DEFAULT '2025-01-01',
  p_end   date DEFAULT current_date
) RETURNS TABLE (
  account_name      text,
  account_type      text,
  total             numeric,
  bucket_code       text,
  bucket_label      text,
  bucket_assigned   boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH period AS (
    SELECT pl.account_name, pl.account_type, sum(pl.amount)::numeric AS total
    FROM ops.pl_snapshots pl
    WHERE pl.period::date >= p_start AND pl.period::date <= p_end
      AND pl.account_type IN ('Expense', 'Cost of Goods Sold', 'Other Expense')
    GROUP BY 1, 2
  )
  SELECT p.account_name, p.account_type, p.total,
    COALESCE(eb.bucket_code, 'oh') AS bucket_code,
    bt.label AS bucket_label,
    eb.account_name IS NOT NULL AS bucket_assigned
  FROM period p
  LEFT JOIN ops.expense_buckets eb ON eb.account_name = p.account_name
  LEFT JOIN ops.expense_bucket_types bt ON bt.bucket_code = COALESCE(eb.bucket_code, 'oh')
  ORDER BY ABS(p.total) DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_list_pl_accounts(date, date) TO anon, authenticated;

CREATE OR REPLACE VIEW ops.v_qbo_token_status AS
SELECT realm_id, access_token_expires_at, refresh_token_expires_at,
       refresh_count, last_refreshed_by, last_error, updated_at
FROM ops.qbo_token_cache;
GRANT SELECT ON ops.v_qbo_token_status TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_set_account_bucket(
  p_account_name text, p_bucket_code text, p_set_by text DEFAULT 'dashboard'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
BEGIN
  IF p_account_name IS NULL OR p_account_name = '' THEN RAISE EXCEPTION 'account_name required'; END IF;
  IF p_bucket_code IS NULL OR p_bucket_code = '' OR p_bucket_code = 'oh' THEN
    DELETE FROM ops.expense_buckets WHERE account_name = p_account_name;
    RETURN;
  END IF;
  INSERT INTO ops.expense_buckets (account_name, bucket_code, set_by, set_at)
  VALUES (p_account_name, p_bucket_code, p_set_by, now())
  ON CONFLICT (account_name) DO UPDATE
    SET bucket_code = EXCLUDED.bucket_code, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_set_account_bucket(text, text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_set_category_segment(
  p_category text, p_segment_code text, p_set_by text DEFAULT 'dashboard'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
BEGIN
  IF p_category IS NULL OR p_category = '' THEN RAISE EXCEPTION 'category required'; END IF;
  IF p_segment_code IS NULL OR p_segment_code = '' THEN
    DELETE FROM ops.category_segments WHERE category = p_category;
    RETURN;
  END IF;
  INSERT INTO ops.category_segments (category, segment_code, set_by, set_at)
  VALUES (p_category, p_segment_code, p_set_by, now())
  ON CONFLICT (category) DO UPDATE
    SET segment_code = EXCLUDED.segment_code, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_set_category_segment(text, text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_set_item_segment(
  p_item_name text, p_segment_code text, p_set_by text DEFAULT 'dashboard'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
BEGIN
  IF p_item_name IS NULL OR p_item_name = '' THEN RAISE EXCEPTION 'item_name required'; END IF;
  IF p_segment_code IS NULL OR p_segment_code = '' THEN
    DELETE FROM ops.item_segments WHERE item_name = p_item_name;
    RETURN;
  END IF;
  INSERT INTO ops.item_segments (item_name, segment_code, set_by, set_at)
  VALUES (p_item_name, p_segment_code, p_set_by, now())
  ON CONFLICT (item_name) DO UPDATE
    SET segment_code = EXCLUDED.segment_code, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_set_item_segment(text, text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ops.fn_list_categories(
  p_start date DEFAULT '2025-01-01',
  p_end   date DEFAULT current_date
) RETURNS TABLE (
  category text, ytd_revenue numeric, line_count bigint,
  segment_code text, segment_label text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH base AS (
    SELECT l.revenue_line, count(*) AS line_count, sum(l.amount)::numeric AS rev
    FROM ops.qbo_invoice_lines l
    JOIN ops.qbo_invoices i ON i.id = l.invoice_id
    WHERE i.txn_date >= p_start AND i.txn_date <= p_end
    GROUP BY 1
  )
  SELECT COALESCE(b.revenue_line, '(unspecified)'),
         b.rev, b.line_count::bigint, cs.segment_code, s.label
  FROM base b
  LEFT JOIN ops.category_segments cs ON cs.category = b.revenue_line
  LEFT JOIN ops.segments s ON s.segment_code = cs.segment_code
  ORDER BY b.rev DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_list_categories(date, date) TO anon, authenticated;
