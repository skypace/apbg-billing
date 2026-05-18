-- Workstream: Unified Customers Settings.
-- Mirror of fn_items_master, but for customers. Joins qbo_customers with:
--   - channel taxonomy (customer_channels + channels)
--   - sales rep taxonomy (customer_sales_reps + sales_reps)
--   - YTD revenue / invoice count (from qbo_invoice_lines + qbo_invoices)
--   - AR aging buckets (open balance on qbo_invoices)
-- The new Settings → Customers grid uses this as its single source of truth.

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
  is_sub_customer      boolean,
  active               boolean,
  state                text,
  city                 text,
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
           array_agg(c.label ORDER BY c.sort_order, c.label)             AS channels,
           max(c.label) FILTER (WHERE cc.is_primary)                     AS primary_channel
    FROM ops.customer_channels cc
    JOIN ops.channels c ON c.channel_code = cc.channel_code AND c.is_active
    GROUP BY 1
  ),
  sr AS (
    SELECT csr.qbo_customer_id,
           array_agg(s.name ORDER BY s.sort_order, s.name)               AS reps,
           max(s.name) FILTER (WHERE csr.is_primary)                     AS primary_rep
    FROM ops.customer_sales_reps csr
    JOIN ops.sales_reps s ON s.rep_code = csr.rep_code AND s.is_active
    GROUP BY 1
  )
  SELECT
    qc.qbo_customer_id,
    qc.display_name,
    qc.fully_qualified_name,
    qc.parent_ref_id,
    COALESCE(qc.is_sub_customer, false),
    COALESCE(qc.active, true),
    qc.bill_addr_state,
    qc.bill_addr_city,
    qc.customer_type_name,
    qc.email,
    qc.phone,
    qc.notes,
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
  ORDER BY COALESCE(rev.rev, 0) DESC NULLS LAST, qc.display_name
  LIMIT GREATEST(COALESCE(p_limit, 500), 1)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$function$;

GRANT EXECUTE ON FUNCTION ops.fn_customers_master(date, date, text, text, boolean, int, int) TO authenticated;

-- Per-customer notes setter (qbo_customers.notes is plain column). We keep
-- channel/sales-rep mutation through the existing fn_set_customer_channels
-- / fn_set_customer_sales_reps RPCs so authorization stays consistent.

CREATE OR REPLACE FUNCTION ops.fn_set_customer_notes(
  p_qbo_customer_id text,
  p_notes           text
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
BEGIN
  IF p_qbo_customer_id IS NULL THEN RAISE EXCEPTION 'customer id required'; END IF;
  UPDATE ops.qbo_customers
     SET notes = NULLIF(trim(COALESCE(p_notes, '')), '')
   WHERE qbo_customer_id = p_qbo_customer_id;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_set_customer_notes(text, text) TO authenticated;
