-- v0.9.24 — Per-customer entity assignment + derivation fallback.
--
-- Today every qbo_invoices.entity is NULL, so the Entity filter is dead.
-- Strategy:
--   1) Add ops.qbo_customers.entity column (manual override).
--   2) Pattern-derive a fallback entity from customer + parent name.
--   3) fn_customers_master returns entity_resolved = COALESCE(override, derived).
--   4) fn_list_entities() returns entities that actually appear in data.

ALTER TABLE ops.qbo_customers ADD COLUMN IF NOT EXISTS entity TEXT;

CREATE OR REPLACE FUNCTION ops.fn_derive_entity(
  p_customer_name text,
  p_parent_name   text DEFAULT NULL
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'ops', 'public'
AS $$
  WITH names AS (
    SELECT upper(coalesce(p_customer_name, '') || ' ' || coalesce(p_parent_name, '')) AS s
  )
  SELECT CASE
    WHEN (SELECT s FROM names) LIKE '%FRESHPET%' OR (SELECT s FROM names) LIKE '%FRESH PET%' THEN 'freeflow'
    WHEN (SELECT s FROM names) LIKE '%FREEFLOW%'                                             THEN 'freeflow'
    WHEN (SELECT s FROM names) LIKE '%ALAMEDA SODA%'                                         THEN 'AS'
    WHEN (SELECT s FROM names) LIKE '%SHOPIFY%'                                              THEN 'AS'
    WHEN (SELECT s FROM names) LIKE '%ALAMEDAPOINT%'                                         THEN 'AS'
    WHEN (SELECT s FROM names) LIKE '%MELT%'                                                 THEN 'brix'
    WHEN (SELECT s FROM names) LIKE '%STARBIRD%'                                             THEN 'brix'
    ELSE 'brix'
  END;
$$;

CREATE OR REPLACE FUNCTION ops.fn_set_customer_entity(
  p_qbo_customer_id text,
  p_entity          text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'ops', 'public'
AS $$
BEGIN
  IF p_qbo_customer_id IS NULL THEN RAISE EXCEPTION 'customer id required'; END IF;
  UPDATE ops.qbo_customers
     SET entity = NULLIF(trim(COALESCE(p_entity, '')), '')
   WHERE qbo_customer_id = p_qbo_customer_id;
END;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_set_customer_entity(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION ops.fn_list_entities()
RETURNS TABLE(entity text, customer_count integer, sales_count bigint, revenue numeric)
LANGUAGE sql STABLE
SET search_path TO 'ops', 'public'
AS $$
  WITH cust AS (
    SELECT
      COALESCE(qc.entity, ops.fn_derive_entity(qc.display_name, parent.display_name)) AS entity,
      qc.qbo_customer_id
    FROM ops.qbo_customers qc
    LEFT JOIN ops.qbo_customers parent ON parent.qbo_customer_id = qc.parent_ref_id
    WHERE COALESCE(qc.active, true)
  ),
  lines AS (
    SELECT
      COALESCE(c.entity, 'brix') AS entity,
      l.amount
    FROM ops.qbo_invoice_lines l
    JOIN ops.qbo_invoices i  ON i.id = l.invoice_id
    LEFT JOIN cust c ON c.qbo_customer_id = i.customer_ref_id
    WHERE i.txn_date >= (current_date - 365)
  )
  SELECT
    e AS entity,
    (SELECT count(DISTINCT qbo_customer_id) FROM cust WHERE entity = e)::integer AS customer_count,
    count(*)::bigint                                                              AS sales_count,
    coalesce(sum(amount), 0)::numeric                                             AS revenue
  FROM lines, LATERAL (SELECT lines.entity AS e) ent
  GROUP BY e
  ORDER BY revenue DESC NULLS LAST;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_list_entities() TO authenticated, anon;

DROP FUNCTION IF EXISTS ops.fn_customers_master(date, date, text, text, boolean, int, int);

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
  entity               text,
  entity_resolved      text,
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
           sum(l.amount)::numeric AS rev,
           count(DISTINCT i.id)::bigint AS inv_count,
           max(i.txn_date)::date AS last_inv
    FROM ops.qbo_invoice_lines l
    JOIN ops.qbo_invoices i ON i.id = l.invoice_id
    WHERE i.txn_date >= p_start AND i.txn_date <= p_end
    GROUP BY 1
  ),
  ar AS (
    SELECT i.customer_ref_id,
           sum(i.balance)::numeric                                                            AS ar_total,
           sum(i.balance) FILTER (WHERE current_date - i.due_date BETWEEN 0 AND 30)::numeric  AS ar_current,
           sum(i.balance) FILTER (WHERE current_date - i.due_date BETWEEN 31 AND 60)::numeric AS ar_31_60,
           sum(i.balance) FILTER (WHERE current_date - i.due_date BETWEEN 61 AND 90)::numeric AS ar_61_90,
           sum(i.balance) FILTER (WHERE current_date - i.due_date > 90)::numeric              AS ar_90_plus,
           count(*)::bigint                                                                   AS open_inv
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
    qc.entity,
    COALESCE(qc.entity, ops.fn_derive_entity(qc.display_name, parent.display_name)) AS entity_resolved,
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
  ORDER BY
    COALESCE(parent.display_name, qc.display_name),
    qc.is_sub_customer,
    qc.display_name
  LIMIT GREATEST(COALESCE(p_limit, 500), 1)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$function$;
GRANT EXECUTE ON FUNCTION ops.fn_customers_master(date, date, text, text, boolean, int, int) TO authenticated;
