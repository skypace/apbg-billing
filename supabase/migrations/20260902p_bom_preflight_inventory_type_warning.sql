-- 2026-09-02  Nothing we build may be an Inventory item except the finished case.
--
-- The rule (Sky): everything the production system consumes is a SERVICE or a
-- NON-INVENTORY item; the only Inventory items are the finished cases that come
-- back into the warehouse, and those already exist.  An Inventory-type raw
-- material does not fail anything loudly -- the purchase order posts fine -- it
-- quietly starts tracking a quantity and a valuation for something nobody
-- counts, and by the time that shows up it is an inventory-adjustment problem.
--
-- So it is a WARNING on the pre-flight, not a blocker: blockers stop the PO
-- reaching QuickBooks and this does not, and calling it a blocker would teach
-- people to click past a category of message that usually means "stop".
--
-- Verified at the time of writing: every BOM component is Service or
-- NonInventory, and the seven 24P####  CASE items are the only Inventory items
-- in the pipeline -- all with real quantities on hand.
--
-- The companion half is in the qbo-raw-materials edge function, which creates
-- raw-material items as NonInventory and refuses to reactivate an Inventory
-- item at all.

CREATE OR REPLACE FUNCTION ops.fn_bom_preflight(p_bom_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ops, pg_temp
AS $$
DECLARE
  v_vendors  JSONB;
  v_blockers JSONB;
  v_warnings JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ops.product_bom WHERE id = p_bom_id) THEN
    RAISE EXCEPTION 'bom % not found', p_bom_id;
  END IF;

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

  -- Blockers stop the purchase order reaching QuickBooks at all.
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

  -- Warnings do NOT stop the push. An Inventory-type component posts fine and
  -- then quietly starts tracking a quantity and a valuation for a raw material
  -- we never count -- which is the thing the Service/NonInventory rule exists
  -- to prevent. The only Inventory items in this pipeline are the finished
  -- cases that come BACK to the warehouse, and those are never components.
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'item_name'), '[]'::jsonb)
    INTO v_warnings
    FROM (
      SELECT jsonb_build_object(
               'kind',        'inventory_component',
               'qbo_item_id', l.component_qbo_item_id,
               'item_name',   i.name,
               'detail',      'This is an Inventory item in QuickBooks. Components should be Service or Non-inventory — an inventory component starts tracking quantity and value for something we never count. Only the finished case belongs in inventory.'
             ) AS x
        FROM ops.product_bom_lines l
        JOIN ops.qbo_items i ON i.qbo_item_id = l.component_qbo_item_id
       WHERE l.bom_id = p_bom_id
         AND l.line_type = 'component'
         AND i.type = 'Inventory'
    ) s;

  RETURN jsonb_build_object(
    'po_count', jsonb_array_length(v_vendors),
    'vendors',  v_vendors,
    'blockers', v_blockers,
    'warnings', v_warnings
  );
END;
$$;

REVOKE ALL ON FUNCTION ops.fn_bom_preflight(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.fn_bom_preflight(UUID) TO authenticated, service_role;
