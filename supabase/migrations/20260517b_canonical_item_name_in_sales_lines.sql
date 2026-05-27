-- Collapse "Category:Child" QBO FQN line names back to the canonical bare name.
--
-- Around 2026-04-25 categories were assigned to items in QBO. From that point
-- on QBO's API started returning the fully-qualified name (e.g. "3 Gallon:
-- 3G1091 HANGAR 25 DIET COLA") in `Line.ItemRef.name` on new invoice lines,
-- while older lines retained the bare name. Result: mv_sales_lines split 133
-- items into 266 ghost rows in any group-by-item-name UI.
--
-- Fix: COALESCE in the source view from the canonical ops.qbo_items.name when
-- item_ref_id resolves, so the bare name is always what surfaces. The MV is
-- then rebuilt to materialize the view directly (single source of truth), so
-- future view changes propagate via the next REFRESH.

CREATE OR REPLACE VIEW ops.v_sales_lines AS
 WITH effective AS (
         SELECT l.id,
            l.invoice_id,
            l.item_ref_id,
            COALESCE(it.name, l.item_name) AS item_name,
            l.revenue_line,
            l.account_name,
            l.description,
            l.quantity,
            l.unit_price,
            l.amount,
            l.department,
            it.purchase_cost AS static_unit_cost,
            ac.avg_unit_cost AS actual_unit_cost,
            COALESCE(ac.avg_unit_cost, it.purchase_cost) AS effective_unit_cost,
                CASE
                    WHEN ac.avg_unit_cost IS NOT NULL THEN 'actual'::text
                    WHEN it.purchase_cost IS NOT NULL THEN 'static'::text
                    ELSE 'none'::text
                END AS cost_source,
            it.type AS item_type,
            it.income_account_name,
            it.expense_account_name
           FROM ops.qbo_invoice_lines l
             LEFT JOIN ops.qbo_items it ON it.qbo_item_id = l.item_ref_id
             LEFT JOIN ops.v_item_actual_cost ac ON ac.item_ref_id = l.item_ref_id
        )
 SELECT e.id AS line_id,
    e.invoice_id,
    i.qbo_invoice_id,
    i.doc_number,
    i.txn_date,
    date_trunc('month'::text, i.txn_date::timestamp with time zone)::date AS txn_month,
    EXTRACT(year FROM i.txn_date)::integer AS txn_year,
    i.customer_ref_id,
    i.customer_name,
    i.entity,
    i.department AS invoice_department,
    e.department AS line_department,
    e.item_ref_id,
    e.item_name,
    e.revenue_line AS category,
    COALESCE(s_item.label, s_cat.label) AS segment,
    e.account_name,
    e.description,
    e.quantity,
    e.unit_price,
    e.amount AS revenue,
    e.static_unit_cost AS purchase_cost,
    e.actual_unit_cost,
    e.effective_unit_cost,
    e.cost_source,
    e.item_type,
    e.income_account_name,
    e.expense_account_name,
        CASE
            WHEN e.effective_unit_cost IS NOT NULL AND e.quantity IS NOT NULL THEN e.effective_unit_cost * e.quantity
            ELSE NULL::numeric
        END AS est_cost,
        CASE
            WHEN e.effective_unit_cost IS NOT NULL AND e.quantity IS NOT NULL THEN e.amount - e.effective_unit_cost * e.quantity
            ELSE NULL::numeric
        END AS est_margin,
    COALESCE(lc.channels, ARRAY[]::text[]) AS channels,
    lc.primary_channel,
    ARRAY[]::text[] AS sales_reps,
    pf.label AS product_family,
    pt.label AS product_type
   FROM effective e
     JOIN ops.qbo_invoices i ON i.id = e.invoice_id
     LEFT JOIN ops.item_segments is_map ON is_map.qbo_item_id = e.item_ref_id
     LEFT JOIN ops.segments s_item ON s_item.segment_code = is_map.segment_code AND s_item.is_active
     LEFT JOIN ops.category_segments cs ON cs.category = e.revenue_line
     LEFT JOIN ops.segments s_cat ON s_cat.segment_code = cs.segment_code AND s_cat.is_active
     LEFT JOIN ops.item_product_families ipf ON ipf.qbo_item_id = e.item_ref_id
     LEFT JOIN ops.product_families pf ON pf.family_code = ipf.family_code AND pf.is_active
     LEFT JOIN ops.item_product_types ipt ON ipt.qbo_item_id = e.item_ref_id
     LEFT JOIN ops.product_types pt ON pt.type_code = ipt.type_code AND pt.is_active
     LEFT JOIN LATERAL ( SELECT array_agg(c.label ORDER BY c.sort_order) AS channels,
            max(c.label) FILTER (WHERE cc.is_primary) AS primary_channel
           FROM ops.customer_channels cc
             JOIN ops.channels c ON c.channel_code = cc.channel_code
          WHERE cc.qbo_customer_id = i.customer_ref_id AND c.is_active) lc ON true;

-- Rebuild the MV to source from the view directly. The MV previously held its
-- own parallel copy of the CTE; without this rebuild the v_sales_lines fix
-- would never reach the MV (and therefore never the Margin UI).
DROP MATERIALIZED VIEW ops.mv_sales_lines;

CREATE MATERIALIZED VIEW ops.mv_sales_lines AS
  SELECT * FROM ops.v_sales_lines;

CREATE UNIQUE INDEX mv_sales_lines_pkey         ON ops.mv_sales_lines (line_id);
CREATE INDEX mv_sales_lines_txn_date_idx        ON ops.mv_sales_lines (txn_date);
CREATE INDEX mv_sales_lines_customer_ref_idx    ON ops.mv_sales_lines (customer_ref_id);
CREATE INDEX mv_sales_lines_item_ref_idx        ON ops.mv_sales_lines (item_ref_id);
CREATE INDEX mv_sales_lines_category_idx        ON ops.mv_sales_lines (category);
CREATE INDEX mv_sales_lines_segment_idx         ON ops.mv_sales_lines (segment);
CREATE INDEX mv_sales_lines_family_idx          ON ops.mv_sales_lines (product_family);
CREATE INDEX mv_sales_lines_type_idx            ON ops.mv_sales_lines (product_type);
CREATE INDEX mv_sales_lines_entity_idx          ON ops.mv_sales_lines (entity);
CREATE INDEX mv_sales_lines_channels_gin_idx    ON ops.mv_sales_lines USING gin (channels);
