-- v0.9.29 — Duplicate a plan (header + all lines) into a new fiscal year.

CREATE OR REPLACE FUNCTION ops.fn_duplicate_sales_plan(
  p_source_plan_id  uuid,
  p_new_name        text,
  p_new_fiscal_year integer,
  p_new_scenario    text DEFAULT 'plan'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF p_source_plan_id IS NULL THEN RAISE EXCEPTION 'source_plan_id required'; END IF;
  IF p_new_name IS NULL OR trim(p_new_name) = '' THEN RAISE EXCEPTION 'new name required'; END IF;

  INSERT INTO ops.sales_plans (name, fiscal_year, scenario, status)
  SELECT p_new_name, p_new_fiscal_year, COALESCE(p_new_scenario, 'plan'), 'active'
  RETURNING id INTO new_id;

  INSERT INTO ops.sales_plan_lines (plan_id, period_start, period_end, dim, dim_value,
                                    qty, revenue, est_cost, margin, notes)
  SELECT new_id, period_start, period_end, dim, dim_value,
         qty, revenue, est_cost, margin, notes
  FROM ops.sales_plan_lines
  WHERE plan_id = p_source_plan_id;

  RETURN new_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_duplicate_sales_plan(uuid, text, integer, text) TO authenticated;
