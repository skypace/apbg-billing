-- Per-customer detail RPC: header + KPIs + AR + channel/rep arrays.
-- Items / monthly / invoice lines are fetched via the existing
-- fn_sales_pivot / fn_sparkline / fn_pivot_drill scoped to the customer.
-- Applied to live DB on 2026-05-03.

CREATE OR REPLACE FUNCTION ops.fn_customer_detail(
  p_qbo_customer_id text,
  p_start date DEFAULT '2025-01-01',
  p_end date DEFAULT current_date
) RETURNS TABLE (
  qbo_customer_id text, display_name text, customer_type_name text,
  bill_addr_line1 text, bill_addr_city text, bill_addr_state text, bill_addr_postal text,
  email text, phone text, is_sub_customer boolean, active boolean, notes text,
  primary_channel text, primary_sales_rep text, all_channels text[], all_sales_reps text[],
  current_revenue numeric, current_invoice_count bigint, current_line_count bigint,
  current_est_cost numeric, current_est_margin numeric, current_margin_pct numeric,
  lifetime_revenue numeric, lifetime_invoice_count bigint, last_invoice_date date,
  ar_balance numeric, ar_overdue numeric, ar_overdue_count int
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH cur AS (
    SELECT sum(revenue)::numeric AS revenue,
      count(DISTINCT invoice_id)::bigint AS invoice_count, count(*)::bigint AS line_count,
      sum(est_cost)::numeric AS est_cost, sum(est_margin)::numeric AS est_margin
    FROM ops.v_sales_lines
    WHERE customer_ref_id = p_qbo_customer_id AND txn_date >= p_start AND txn_date <= p_end
  ),
  life AS (
    SELECT sum(revenue)::numeric AS revenue,
      count(DISTINCT invoice_id)::bigint AS invoice_count, max(txn_date) AS last_date
    FROM ops.v_sales_lines WHERE customer_ref_id = p_qbo_customer_id
  ),
  ar AS (
    SELECT sum(balance)::numeric AS ar_balance,
      sum(CASE WHEN due_date < current_date THEN balance ELSE 0 END)::numeric AS ar_overdue,
      count(*) FILTER (WHERE balance > 0 AND due_date < current_date)::int AS ar_overdue_count
    FROM ops.qbo_invoices WHERE customer_ref_id = p_qbo_customer_id AND balance > 0
  ),
  ch AS (
    SELECT array_agg(c.label ORDER BY c.sort_order) AS labels,
      max(c.label) FILTER (WHERE cc.is_primary) AS primary_label
    FROM ops.customer_channels cc JOIN ops.channels c ON c.channel_code = cc.channel_code AND c.is_active
    WHERE cc.qbo_customer_id = p_qbo_customer_id
  ),
  reps AS (
    SELECT array_agg(r.name ORDER BY r.sort_order) AS names,
      max(r.name) FILTER (WHERE csr.is_primary) AS primary_name
    FROM ops.customer_sales_reps csr JOIN ops.sales_reps r ON r.rep_code = csr.rep_code AND r.is_active
    WHERE csr.qbo_customer_id = p_qbo_customer_id
  )
  SELECT qc.qbo_customer_id, qc.display_name, qc.customer_type_name,
    qc.bill_addr_line1, qc.bill_addr_city, qc.bill_addr_state, qc.bill_addr_postal,
    qc.email, qc.phone, qc.is_sub_customer, qc.active, qc.notes,
    ch.primary_label, reps.primary_name,
    COALESCE(ch.labels, ARRAY[]::text[]), COALESCE(reps.names, ARRAY[]::text[]),
    COALESCE(cur.revenue, 0), COALESCE(cur.invoice_count, 0), COALESCE(cur.line_count, 0),
    cur.est_cost, cur.est_margin,
    CASE WHEN cur.revenue > 0 AND cur.est_cost IS NOT NULL THEN (cur.revenue - cur.est_cost) / cur.revenue ELSE NULL END,
    COALESCE(life.revenue, 0), COALESCE(life.invoice_count, 0), life.last_date,
    COALESCE(ar.ar_balance, 0), COALESCE(ar.ar_overdue, 0), COALESCE(ar.ar_overdue_count, 0)
  FROM ops.qbo_customers qc
  CROSS JOIN cur CROSS JOIN life CROSS JOIN ar
  LEFT JOIN ch ON true LEFT JOIN reps ON true
  WHERE qc.qbo_customer_id = p_qbo_customer_id;
$$;
GRANT EXECUTE ON FUNCTION ops.fn_customer_detail(text, date, date) TO anon, authenticated;
