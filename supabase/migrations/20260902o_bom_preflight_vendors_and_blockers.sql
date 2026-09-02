-- 2026-09-02  The BOM says which vendor gets which PO, and what would stop it.
--
-- Two things were only discoverable by generating a work order and reading the
-- result: how many purchase orders a run will raise and to whom, and whether a
-- component points at a QuickBooks item that has been deactivated.  The second
-- one does not fail here -- Refractor will happily write the PO -- it fails at
-- the QuickBooks push, which is the worst moment to find out.  So both are
-- answered up front, off the BOM, before anybody commits a run.
--
-- A deactivated item is a BLOCKER, not a warning: QuickBooks refuses a
-- transaction that references one, so a PO carrying it cannot post.  A missing
-- vendor is the same shape -- fn_wo_generate_pos already raises on it.

CREATE OR REPLACE FUNCTION ops.fn_bom_preflight(p_bom_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ops, pg_temp
AS $$
DECLARE
  v_vendors  JSONB;
  v_blockers JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ops.product_bom WHERE id = p_bom_id) THEN
    RAISE EXCEPTION 'bom % not found', p_bom_id;
  END IF;

  -- One entry per purchase order the run will raise.  Recipe lines are
  -- deliberately excluded: they ride UNDER the gallon line as detail and never
  -- become a PO line of their own (see architecture/PRODUCTION.md).
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'vendor_name'), '[]'::jsonb)
    INTO v_vendors
    FROM (
      SELECT jsonb_build_object(
               'qbo_vendor_id', l.preferred_qbo_vendor_id,
               'vendor_name',   COALESCE(v.display_name, '(no vendor set)'),
               'line_count',    count(*),
               'items',         jsonb_agg(COALESCE(i.name, l.service_label, l.component_qbo_item_id)
                                          ORDER BY l.sort_order)
             ) AS x
        FROM ops.product_bom_lines l
        LEFT JOIN ops.qbo_items   i ON i.qbo_item_id   = l.component_qbo_item_id
        LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = l.preferred_qbo_vendor_id
       WHERE l.bom_id = p_bom_id
         AND l.line_type = 'component'
         AND l.component_qbo_item_id IS NOT NULL
       GROUP BY l.preferred_qbo_vendor_id, v.display_name
    ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'item_name'), '[]'::jsonb)
    INTO v_blockers
    FROM (
      SELECT jsonb_build_object(
               'kind',        CASE WHEN l.preferred_qbo_vendor_id IS NULL
                                   THEN 'no_vendor' ELSE 'inactive_in_qbo' END,
               'qbo_item_id', l.component_qbo_item_id,
               'item_name',   COALESCE(i.name, l.component_qbo_item_id),
               'detail',      CASE WHEN l.preferred_qbo_vendor_id IS NULL
                                   THEN 'No vendor on this line, so it cannot be put on a purchase order.'
                                   ELSE 'This item is deactivated in QuickBooks. Reactivate it there, or point the line at the current item, before pushing a purchase order.'
                              END
             ) AS x
        FROM ops.product_bom_lines l
        LEFT JOIN ops.qbo_items i ON i.qbo_item_id = l.component_qbo_item_id
       WHERE l.bom_id = p_bom_id
         AND l.line_type = 'component'
         AND l.component_qbo_item_id IS NOT NULL
         AND (l.preferred_qbo_vendor_id IS NULL OR COALESCE(i.active, TRUE) = FALSE)
    ) s;

  RETURN jsonb_build_object(
    'po_count', jsonb_array_length(v_vendors),
    'vendors',  v_vendors,
    'blockers', v_blockers
  );
END;
$$;

REVOKE ALL ON FUNCTION ops.fn_bom_preflight(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.fn_bom_preflight(UUID) TO authenticated, service_role;
