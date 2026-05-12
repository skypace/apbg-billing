-- v0.9.22 — Local active toggle on items + categories pick-list +
-- address columns + parent-first sort on fn_customers_master.

DROP FUNCTION IF EXISTS ops.fn_customers_master(date, date, text, text, boolean, int, int);

CREATE OR REPLACE FUNCTION ops.fn_set_qbo_item_active(
  p_qbo_item_id text,
  p_active      boolean
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
BEGIN
  IF p_qbo_item_id IS NULL THEN RAISE EXCEPTION 'qbo_item_id required'; END IF;
  UPDATE ops.qbo_items
     SET active = COALESCE(p_active, true)
   WHERE qbo_item_id = p_qbo_item_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_set_qbo_item_active(text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION ops.fn_list_categories()
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
GRANT EXECUTE ON FUNCTION ops.fn_list_categories() TO authenticated, anon;

CREATE OR REPLACE FUNCTION ops.fn_customers_master(
  p_start    date    DEFAULT (date_trunc('year', current_date))::date,
  p_end      date    DEFAULT current_date,
  p_search   text    DEFAULT NULL,
  p_channel  text    DEFAULT NULL,
  p_only_active boolean DEFAULT true,
  p_limit    int     DEFAULT 500,
  p_offset   int     DEFAULT 0
)
RETURNS TABLE(
  qbo_customer_id      text,
  display_name         text,
  fully_qualified_name text,
  parent_ref_id        text,
  parent_name          text,
  is_sub_customer      boolean,
  active               boolean,
  state                text,
  city                 text,
  address              text,
  postal               text,
  customer_type_name   text,
  email                text,
  phone                text,
  notes                text,
  ytd_revenue          numeric,
  invoice_count        bigint,
  last_invoice_date    date,
  ar_total             numeric,
  ar_current           numeric,
  ar_31_60             numeric,
  ar_61_90             numeric,
  ar_90_plus           numeric,
  open_invoice_count   bigint,
  channels             text[],
  primary_channel      text,
  sales_reps           text[],
  primary_sales_rep    text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $function$
  WITH rev AS (
    SELECT i.customer_ref_id,
           sum(l.amount)::numeric        AS rev,
           count(DISTINCT i.id)::bigint  AS inv_count,
           max(i.txn_date)::date         AS last_inv
    FROM ops.qbo_invoice_lines l
    JOIN ops.qbo_invoices i ON i.id = l.invoice_id
    WHERE i.txn_date >= p_start AND i.txn_date <= p_end
    GROUP BY 1
  ),
  ar AS (
    SELECT i.customer_ref_id,
           sum(i.balance)::numeric                                                                AS ar_total,
           sum(i.balance) FILTER (WHERE current_date - i.due_date BETWEEN 0 AND 30)::numeric      AS ar_current,
           sum(i.balance) FILTER (WHERE current_date - i.due_date BETWEEN 31 AND 60)::numeric     AS ar_31_60,
           sum(i.balance) FILTER (WHERE current_date - i.due_date BETWEEN 61 AND 90)::numeric     AS ar_61_90,
           sum(i.balance) FILTER (WHERE current_date - i.due_date > 90)::numeric                  AS ar_90_plus,
           count(*)::bigint                                                                       AS open_inv
    FROM ops.qbo_invoices i
    WHERE i.balance > 0
    GROUP BY 1
  ),
  ch AS (
    SELECT cc.qbo_customer_id,
           array_agg(c.label ORDER BY c.sort_order, c.label) AS channels,
           max(c.label) FILTER (WHERE cc.is_primary)         AS primary_channel
    FROM ops.customer_channels cc
    JOIN ops.channels c ON c.channel_code = cc.channel_code AND c.is_active
    GROUP BY 1
  ),
  sr AS (
    SELECT csr.qbo_customer_id,
           array_agg(s.name ORDER BY s.sort_order, s.name)  AS reps,
           max(s.name) FILTER (WHERE csr.is_primary)        AS primary_rep
    FROM ops.customer_sales_reps csr
    JOIN ops.sales_reps s ON s.rep_code = csr.rep_code AND s.is_active
    GROUP BY 1
  )
  SELECT
    qc.qbo_customer_id, qc.display_name, qc.fully_qualified_name,
    qc.parent_ref_id, parent.display_name,
    COALESCE(qc.is_sub_customer, false),
    COALESCE(qc.active, true),
    qc.bill_addr_state, qc.bill_addr_city, qc.bill_addr_line1, qc.bill_addr_postal,
    qc.customer_type_name, qc.email, qc.phone, qc.notes,
    COALESCE(rev.rev, 0)::numeric,
    COALESCE(rev.inv_count, 0)::bigint,
    rev.last_inv,
    COALESCE(ar.ar_total, 0)::numeric,
    COALESCE(ar.ar_current, 0)::numeric,
    COALESCE(ar.ar_31_60, 0)::numeric,
    COALESCE(ar.ar_61_90, 0)::numeric,
    COALESCE(ar.ar_90_plus, 0)::numeric,
    COALESCE(ar.open_inv, 0)::bigint,
    COALESCE(ch.channels, ARRAY[]::text[]),
    ch.primary_channel,
    COALESCE(sr.reps, ARRAY[]::text[]),
    sr.primary_rep
  FROM ops.qbo_customers qc
  LEFT JOIN ops.qbo_customers parent ON parent.qbo_customer_id = qc.parent_ref_id
  LEFT JOIN rev ON rev.customer_ref_id = qc.qbo_customer_id
  LEFT JOIN ar  ON ar.customer_ref_id  = qc.qbo_customer_id
  LEFT JOIN ch  ON ch.qbo_customer_id  = qc.qbo_customer_id
  LEFT JOIN sr  ON sr.qbo_customer_id  = qc.qbo_customer_id
  WHERE (NOT p_only_active OR COALESCE(qc.active, true))
    AND (
      p_search IS NULL OR p_search = ''
      OR qc.display_name        ILIKE '%' || p_search || '%'
      OR qc.fully_qualified_name ILIKE '%' || p_search || '%'
      OR COALESCE(qc.customer_type_name, '') ILIKE '%' || p_search || '%'
    )
    AND (
      p_channel IS NULL OR p_channel = ''
      OR (p_channel = 'unassigned' AND (ch.channels IS NULL OR array_length(ch.channels, 1) = 0))
      OR (p_channel <> 'unassigned' AND p_channel = ANY(COALESCE(ch.channels, ARRAY[]::text[])))
    )
  -- Parent-first sort: customers sort by their parent's name (or own
  -- if root). Within the same parent group, parents come before subs,
  -- then alphabetical.
  ORDER BY
    COALESCE(parent.display_name, qc.display_name),
    qc.is_sub_customer,
    qc.display_name
  LIMIT GREATEST(COALESCE(p_limit, 500), 1)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_customers_master(date, date, text, text, boolean, int, int) TO authenticated;
