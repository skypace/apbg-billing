-- Customer lifecycle cleanup.
--
-- Active in QBO is not enough signal for the customer list. This adds a
-- reviewed inactivation queue and upgrades the customer list RPC with dormant,
-- AR, future-invoice, and lifecycle status fields.

CREATE INDEX IF NOT EXISTS qbo_invoices_customer_date_idx
  ON ops.qbo_invoices (customer_ref_id, txn_date);

CREATE INDEX IF NOT EXISTS qbo_invoices_customer_open_due_idx
  ON ops.qbo_invoices (customer_ref_id, due_date)
  WHERE balance > 0;

CREATE TABLE IF NOT EXISTS ops.customer_lifecycle_actions (
  id                    bigserial PRIMARY KEY,
  action                text NOT NULL DEFAULT 'inactivate',
  qbo_customer_id        text NOT NULL REFERENCES ops.qbo_customers(qbo_customer_id) ON DELETE CASCADE,
  customer_name          text NOT NULL,
  sf_customer_id         text,
  sf_customer_name       text,
  status                text NOT NULL DEFAULT 'requested',
  blockers              jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshot              jsonb NOT NULL DEFAULT '{}'::jsonb,
  sf_result             jsonb,
  qbo_result            jsonb,
  last_error            text,
  attempt_count          integer NOT NULL DEFAULT 0,
  requested_reason       text,
  requested_by           text,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  processing_started_at  timestamptz,
  processed_at           timestamptz,
  completed_at           timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_lifecycle_actions_action_check
    CHECK (action IN ('inactivate')),
  CONSTRAINT customer_lifecycle_actions_status_check
    CHECK (status IN ('requested', 'running', 'blocked', 'sf_failed', 'sf_done', 'qbo_failed', 'completed', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_lifecycle_open_action_idx
  ON ops.customer_lifecycle_actions (qbo_customer_id, action)
  WHERE status IN ('requested', 'running', 'blocked', 'sf_failed', 'sf_done', 'qbo_failed');

CREATE INDEX IF NOT EXISTS customer_lifecycle_status_idx
  ON ops.customer_lifecycle_actions (status, requested_at DESC);

CREATE OR REPLACE FUNCTION ops.tg_customer_lifecycle_actions_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_lifecycle_actions_touch ON ops.customer_lifecycle_actions;
CREATE TRIGGER trg_customer_lifecycle_actions_touch
  BEFORE UPDATE ON ops.customer_lifecycle_actions
  FOR EACH ROW EXECUTE FUNCTION ops.tg_customer_lifecycle_actions_touch();

COMMENT ON TABLE ops.customer_lifecycle_actions IS
  'Audited queue for customer lifecycle changes. Service Fusion is processed before QBO so the two systems do not diverge silently.';

ALTER TABLE ops.customer_lifecycle_actions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION ops.is_customer_lifecycle_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'superadmin';
$$;

DROP POLICY IF EXISTS customer_lifecycle_actions_read ON ops.customer_lifecycle_actions;
CREATE POLICY customer_lifecycle_actions_read ON ops.customer_lifecycle_actions
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS customer_lifecycle_actions_insert ON ops.customer_lifecycle_actions;
CREATE POLICY customer_lifecycle_actions_insert ON ops.customer_lifecycle_actions
  FOR INSERT TO authenticated WITH CHECK (ops.is_customer_lifecycle_admin());

DROP POLICY IF EXISTS customer_lifecycle_actions_update ON ops.customer_lifecycle_actions;
CREATE POLICY customer_lifecycle_actions_update ON ops.customer_lifecycle_actions
  FOR UPDATE TO authenticated
  USING (ops.is_customer_lifecycle_admin())
  WITH CHECK (ops.is_customer_lifecycle_admin());

GRANT SELECT, INSERT, UPDATE ON ops.customer_lifecycle_actions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE ops.customer_lifecycle_actions_id_seq TO authenticated;
GRANT ALL ON ops.customer_lifecycle_actions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE ops.customer_lifecycle_actions_id_seq TO service_role;

CREATE OR REPLACE FUNCTION ops.fn_customer_inactivation_assessment(
  p_qbo_customer_id text
) RETURNS TABLE (
  qbo_customer_id text,
  customer_name text,
  active boolean,
  last_invoice_date date,
  revenue_365 numeric,
  ar_balance numeric,
  ar_overdue numeric,
  ar_90_plus numeric,
  future_invoice_count integer,
  future_revenue numeric,
  sf_customer_id text,
  sf_customer_name text,
  blockers jsonb,
  can_inactivate boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  WITH inv AS (
    SELECT
      customer_ref_id,
      max(txn_date) FILTER (WHERE txn_date <= current_date) AS last_invoice_date,
      COALESCE(sum(total_amount) FILTER (
        WHERE txn_date >= current_date - interval '365 days'
          AND txn_date <= current_date
      ), 0)::numeric AS revenue_365,
      COALESCE(sum(balance) FILTER (WHERE COALESCE(balance, 0) > 0), 0)::numeric AS ar_balance,
      COALESCE(sum(balance) FILTER (WHERE COALESCE(balance, 0) > 0 AND due_date < current_date), 0)::numeric AS ar_overdue,
      COALESCE(sum(balance) FILTER (WHERE COALESCE(balance, 0) > 0 AND current_date - due_date > 90), 0)::numeric AS ar_90_plus,
      count(*) FILTER (WHERE txn_date > current_date)::int AS future_invoice_count,
      COALESCE(sum(total_amount) FILTER (WHERE txn_date > current_date), 0)::numeric AS future_revenue
    FROM ops.qbo_invoices
    WHERE customer_ref_id = p_qbo_customer_id
    GROUP BY 1
  ),
  sf AS (
    SELECT
      sc.qbo_customer_id,
      max(sc.sf_customer_id) FILTER (WHERE sc.sf_customer_id IS NOT NULL AND sc.sf_customer_id <> '') AS sf_customer_id,
      max(sc.sf_customer_name) FILTER (WHERE sc.sf_customer_name IS NOT NULL AND sc.sf_customer_name <> '') AS sf_customer_name
    FROM ops.sync_customers sc
    WHERE sc.qbo_customer_id = p_qbo_customer_id
      AND sc.linked IS NOT FALSE
    GROUP BY 1
  ),
  base AS (
    SELECT
      qc.qbo_customer_id,
      qc.display_name AS customer_name,
      COALESCE(qc.active, true) AS active,
      inv.last_invoice_date,
      COALESCE(inv.revenue_365, 0)::numeric AS revenue_365,
      COALESCE(inv.ar_balance, 0)::numeric AS ar_balance,
      COALESCE(inv.ar_overdue, 0)::numeric AS ar_overdue,
      COALESCE(inv.ar_90_plus, 0)::numeric AS ar_90_plus,
      COALESCE(inv.future_invoice_count, 0)::int AS future_invoice_count,
      COALESCE(inv.future_revenue, 0)::numeric AS future_revenue,
      sf.sf_customer_id,
      COALESCE(sf.sf_customer_name, qc.display_name) AS sf_customer_name
    FROM ops.qbo_customers qc
    LEFT JOIN inv ON inv.customer_ref_id = qc.qbo_customer_id
    LEFT JOIN sf ON sf.qbo_customer_id = qc.qbo_customer_id
    WHERE qc.qbo_customer_id = p_qbo_customer_id
  )
  SELECT
    b.qbo_customer_id,
    b.customer_name,
    b.active,
    b.last_invoice_date,
    b.revenue_365,
    b.ar_balance,
    b.ar_overdue,
    b.ar_90_plus,
    b.future_invoice_count,
    b.future_revenue,
    b.sf_customer_id,
    b.sf_customer_name,
    x.blockers,
    (jsonb_array_length(x.blockers) = 0) AS can_inactivate
  FROM base b
  CROSS JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(reason), '[]'::jsonb) AS blockers
    FROM (
      VALUES
        (CASE WHEN b.active IS FALSE THEN 'already_inactive' END),
        (CASE WHEN b.revenue_365 > 0 THEN 'recent_revenue' END),
        (CASE WHEN b.ar_balance > 0 THEN 'open_ar' END),
        (CASE WHEN b.future_invoice_count > 0 THEN 'future_invoice' END)
    ) AS reasons(reason)
    WHERE reason IS NOT NULL
  ) x;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_customer_inactivation_assessment(text) TO authenticated;

CREATE OR REPLACE FUNCTION ops.fn_request_customer_inactivation(
  p_qbo_customer_id text,
  p_reason text DEFAULT NULL
) RETURNS TABLE (
  id bigint,
  status text,
  qbo_customer_id text,
  customer_name text,
  blockers jsonb,
  message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, public
AS $$
DECLARE
  v_assess record;
  v_status text;
  v_requested_by text;
BEGIN
  IF NOT (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'superadmin') THEN
    RAISE EXCEPTION 'superadmin required';
  END IF;

  SELECT *
    INTO v_assess
    FROM ops.fn_customer_inactivation_assessment(p_qbo_customer_id)
    LIMIT 1;

  IF v_assess.qbo_customer_id IS NULL THEN
    RAISE EXCEPTION 'customer % not found', p_qbo_customer_id;
  END IF;

  v_status := CASE WHEN jsonb_array_length(v_assess.blockers) = 0 THEN 'requested' ELSE 'blocked' END;
  v_requested_by := COALESCE(auth.jwt() ->> 'email', 'dashboard');

  RETURN QUERY
  WITH upserted AS (
    INSERT INTO ops.customer_lifecycle_actions AS a (
      action,
      qbo_customer_id,
      customer_name,
      sf_customer_id,
      sf_customer_name,
      status,
      blockers,
      snapshot,
      requested_reason,
      requested_by,
      requested_at,
      last_error,
      completed_at
    )
    VALUES (
      'inactivate',
      v_assess.qbo_customer_id,
      v_assess.customer_name,
      v_assess.sf_customer_id,
      v_assess.sf_customer_name,
      v_status,
      v_assess.blockers,
      jsonb_build_object(
        'active', v_assess.active,
        'last_invoice_date', v_assess.last_invoice_date,
        'revenue_365', v_assess.revenue_365,
        'ar_balance', v_assess.ar_balance,
        'ar_overdue', v_assess.ar_overdue,
        'ar_90_plus', v_assess.ar_90_plus,
        'future_invoice_count', v_assess.future_invoice_count,
        'future_revenue', v_assess.future_revenue,
        'sf_customer_id', v_assess.sf_customer_id
      ),
      NULLIF(trim(COALESCE(p_reason, '')), ''),
      v_requested_by,
      now(),
      CASE WHEN v_status = 'blocked' THEN 'Blocked by current customer activity' ELSE NULL END,
      NULL
    )
    ON CONFLICT (qbo_customer_id, action)
      WHERE status IN ('requested', 'running', 'blocked', 'sf_failed', 'sf_done', 'qbo_failed')
    DO UPDATE SET
      customer_name = EXCLUDED.customer_name,
      sf_customer_id = COALESCE(EXCLUDED.sf_customer_id, a.sf_customer_id),
      sf_customer_name = COALESCE(EXCLUDED.sf_customer_name, a.sf_customer_name),
      status = CASE WHEN a.status = 'running' THEN a.status ELSE EXCLUDED.status END,
      blockers = EXCLUDED.blockers,
      snapshot = EXCLUDED.snapshot,
      requested_reason = EXCLUDED.requested_reason,
      requested_by = EXCLUDED.requested_by,
      requested_at = EXCLUDED.requested_at,
      last_error = EXCLUDED.last_error,
      completed_at = NULL
    RETURNING a.id, a.status, a.qbo_customer_id, a.customer_name, a.blockers
  )
  SELECT
    u.id,
    u.status,
    u.qbo_customer_id,
    u.customer_name,
    u.blockers,
    CASE
      WHEN u.status = 'requested' THEN 'Ready for Service Fusion then QBO inactivation'
      WHEN u.status = 'running' THEN 'Already running'
      ELSE 'Blocked by current customer activity'
    END
  FROM upserted u;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_request_customer_inactivation(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION ops.fn_cancel_customer_inactivation(
  p_action_id bigint,
  p_reason text DEFAULT NULL
) RETURNS TABLE (
  id bigint,
  status text,
  qbo_customer_id text,
  customer_name text,
  message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, public
AS $$
BEGIN
  IF NOT (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'superadmin') THEN
    RAISE EXCEPTION 'superadmin required';
  END IF;

  RETURN QUERY
  UPDATE ops.customer_lifecycle_actions a
     SET status = 'cancelled',
         last_error = NULLIF(trim(COALESCE(p_reason, '')), ''),
         completed_at = now()
   WHERE a.id = p_action_id
     AND a.status NOT IN ('completed', 'cancelled', 'running')
  RETURNING a.id, a.status, a.qbo_customer_id, a.customer_name, 'Cancelled'::text;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_cancel_customer_inactivation(bigint, text) TO authenticated;

CREATE OR REPLACE FUNCTION ops.fn_recent_customer_lifecycle_actions(
  p_days int DEFAULT 30
) RETURNS TABLE (
  id bigint,
  action text,
  qbo_customer_id text,
  customer_name text,
  sf_customer_id text,
  sf_customer_name text,
  status text,
  blockers jsonb,
  snapshot jsonb,
  sf_result jsonb,
  qbo_result jsonb,
  last_error text,
  attempt_count integer,
  requested_reason text,
  requested_by text,
  requested_at timestamptz,
  processing_started_at timestamptz,
  processed_at timestamptz,
  completed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  SELECT
    a.id,
    a.action,
    a.qbo_customer_id,
    a.customer_name,
    a.sf_customer_id,
    a.sf_customer_name,
    a.status,
    a.blockers,
    a.snapshot,
    a.sf_result,
    a.qbo_result,
    a.last_error,
    a.attempt_count,
    a.requested_reason,
    a.requested_by,
    a.requested_at,
    a.processing_started_at,
    a.processed_at,
    a.completed_at
  FROM ops.customer_lifecycle_actions a
  WHERE a.requested_at >= now() - (GREATEST(COALESCE(p_days, 30), 1) || ' days')::interval
  ORDER BY a.requested_at DESC, a.id DESC;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_recent_customer_lifecycle_actions(int) TO authenticated;

DROP FUNCTION IF EXISTS ops.fn_customer_classification_list(text, text, date, date, int, int);

CREATE FUNCTION ops.fn_customer_classification_list(
  p_search    text DEFAULT NULL,
  p_channel   text DEFAULT NULL,
  p_start     date DEFAULT '2025-01-01',
  p_end       date DEFAULT current_date,
  p_limit     int  DEFAULT 200,
  p_offset    int  DEFAULT 0
) RETURNS TABLE (
  qbo_customer_id text,
  display_name    text,
  is_sub_customer boolean,
  active          boolean,
  state           text,
  customer_type_name text,
  ytd_revenue     numeric,
  invoice_count   bigint,
  channels        text[],
  primary_channel text,
  last_invoice_date date,
  revenue_365 numeric,
  est_margin_365 numeric,
  margin_pct_365 numeric,
  cost_coverage_pct numeric,
  top_item_name text,
  top_item_revenue numeric,
  top_item_share_pct numeric,
  ar_balance numeric,
  ar_overdue numeric,
  ar_90_plus numeric,
  days_oldest_overdue integer,
  future_invoice_count integer,
  future_revenue numeric,
  future_last_invoice_date date,
  lifecycle_action_id bigint,
  lifecycle_status text,
  lifecycle_last_error text,
  lifecycle_requested_at timestamptz,
  can_inactivate boolean,
  inactive_reason text,
  next_action text,
  priority_score integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ops, public
AS $$
  WITH sales AS (
    SELECT
      v.customer_ref_id,
      COALESCE(sum(v.revenue) FILTER (WHERE v.txn_date >= p_start AND v.txn_date <= p_end), 0)::numeric AS ytd_revenue,
      count(DISTINCT v.invoice_id) FILTER (WHERE v.txn_date >= p_start AND v.txn_date <= p_end)::bigint AS invoice_count,
      COALESCE(sum(v.revenue) FILTER (
        WHERE v.txn_date >= current_date - interval '365 days'
          AND v.txn_date <= current_date
      ), 0)::numeric AS revenue_365,
      COALESCE(sum(v.est_margin) FILTER (
        WHERE v.txn_date >= current_date - interval '365 days'
          AND v.txn_date <= current_date
      ), 0)::numeric AS est_margin_365,
      COALESCE(sum(abs(v.revenue)) FILTER (
        WHERE v.txn_date >= current_date - interval '365 days'
          AND v.txn_date <= current_date
      ), 0)::numeric AS abs_revenue_365,
      COALESCE(sum(abs(v.revenue)) FILTER (
        WHERE v.txn_date >= current_date - interval '365 days'
          AND v.txn_date <= current_date
          AND v.est_cost IS NOT NULL
      ), 0)::numeric AS costed_abs_revenue_365
    FROM ops.mv_sales_lines v
    WHERE v.customer_ref_id IS NOT NULL
    GROUP BY 1
  ),
  inv AS (
    SELECT
      i.customer_ref_id,
      max(i.txn_date) FILTER (WHERE i.txn_date <= current_date) AS last_invoice_date,
      COALESCE(sum(i.total_amount) FILTER (
        WHERE i.txn_date >= current_date - interval '365 days'
          AND i.txn_date <= current_date
      ), 0)::numeric AS header_revenue_365,
      COALESCE(sum(i.balance) FILTER (WHERE COALESCE(i.balance, 0) > 0), 0)::numeric AS ar_balance,
      COALESCE(sum(i.balance) FILTER (WHERE COALESCE(i.balance, 0) > 0 AND i.due_date < current_date), 0)::numeric AS ar_overdue,
      COALESCE(sum(i.balance) FILTER (WHERE COALESCE(i.balance, 0) > 0 AND current_date - i.due_date > 90), 0)::numeric AS ar_90_plus,
      max(current_date - i.due_date) FILTER (WHERE COALESCE(i.balance, 0) > 0 AND i.due_date < current_date)::int AS days_oldest_overdue,
      count(*) FILTER (WHERE i.txn_date > current_date)::int AS future_invoice_count,
      COALESCE(sum(i.total_amount) FILTER (WHERE i.txn_date > current_date), 0)::numeric AS future_revenue,
      max(i.txn_date) FILTER (WHERE i.txn_date > current_date) AS future_last_invoice_date
    FROM ops.qbo_invoices i
    WHERE i.customer_ref_id IS NOT NULL
    GROUP BY 1
  ),
  top_item AS (
    SELECT customer_ref_id, item_name, revenue
    FROM (
      SELECT
        v.customer_ref_id,
        COALESCE(v.item_name, '(no item)') AS item_name,
        sum(v.revenue)::numeric AS revenue,
        row_number() OVER (PARTITION BY v.customer_ref_id ORDER BY sum(v.revenue) DESC NULLS LAST) AS rn
      FROM ops.mv_sales_lines v
      WHERE v.txn_date >= current_date - interval '365 days'
        AND v.txn_date <= current_date
        AND v.customer_ref_id IS NOT NULL
      GROUP BY 1, 2
    ) ranked
    WHERE rn = 1
  ),
  ch AS (
    SELECT cc.qbo_customer_id,
           array_agg(c.label ORDER BY c.sort_order) AS channels,
           max(c.label) FILTER (WHERE cc.is_primary) AS primary_channel
    FROM ops.customer_channels cc
    JOIN ops.channels c ON c.channel_code = cc.channel_code AND c.is_active
    GROUP BY 1
  ),
  lifecycle AS (
    SELECT DISTINCT ON (a.qbo_customer_id)
      a.qbo_customer_id,
      a.id,
      a.status,
      a.last_error,
      a.requested_at
    FROM ops.customer_lifecycle_actions a
    WHERE a.action = 'inactivate'
      AND a.status IN ('requested', 'running', 'blocked', 'sf_failed', 'sf_done', 'qbo_failed')
    ORDER BY a.qbo_customer_id, a.requested_at DESC, a.id DESC
  ),
  base AS (
    SELECT
      qc.qbo_customer_id,
      qc.display_name,
      qc.is_sub_customer,
      COALESCE(qc.active, true) AS active,
      qc.bill_addr_state AS state,
      qc.customer_type_name,
      COALESCE(s.ytd_revenue, 0)::numeric AS ytd_revenue,
      COALESCE(s.invoice_count, 0)::bigint AS invoice_count,
      COALESCE(ch.channels, ARRAY[]::text[]) AS channels,
      ch.primary_channel,
      inv.last_invoice_date,
      COALESCE(NULLIF(s.revenue_365, 0), inv.header_revenue_365, 0)::numeric AS revenue_365,
      COALESCE(s.est_margin_365, 0)::numeric AS est_margin_365,
      CASE WHEN COALESCE(NULLIF(s.revenue_365, 0), inv.header_revenue_365, 0) <> 0
        THEN COALESCE(s.est_margin_365, 0) / COALESCE(NULLIF(s.revenue_365, 0), inv.header_revenue_365, 0)
      END::numeric AS margin_pct_365,
      CASE WHEN COALESCE(s.abs_revenue_365, 0) > 0
        THEN COALESCE(s.costed_abs_revenue_365, 0) / NULLIF(s.abs_revenue_365, 0)
      END::numeric AS cost_coverage_pct,
      ti.item_name AS top_item_name,
      COALESCE(ti.revenue, 0)::numeric AS top_item_revenue,
      CASE WHEN COALESCE(NULLIF(s.revenue_365, 0), inv.header_revenue_365, 0) <> 0
        THEN COALESCE(ti.revenue, 0) / NULLIF(COALESCE(NULLIF(s.revenue_365, 0), inv.header_revenue_365, 0), 0)
      END::numeric AS top_item_share_pct,
      COALESCE(inv.ar_balance, 0)::numeric AS ar_balance,
      COALESCE(inv.ar_overdue, 0)::numeric AS ar_overdue,
      COALESCE(inv.ar_90_plus, 0)::numeric AS ar_90_plus,
      inv.days_oldest_overdue,
      COALESCE(inv.future_invoice_count, 0)::int AS future_invoice_count,
      COALESCE(inv.future_revenue, 0)::numeric AS future_revenue,
      inv.future_last_invoice_date,
      lc.id AS lifecycle_action_id,
      lc.status AS lifecycle_status,
      lc.last_error AS lifecycle_last_error,
      lc.requested_at AS lifecycle_requested_at
    FROM ops.qbo_customers qc
    LEFT JOIN sales s ON s.customer_ref_id = qc.qbo_customer_id
    LEFT JOIN inv ON inv.customer_ref_id = qc.qbo_customer_id
    LEFT JOIN top_item ti ON ti.customer_ref_id = qc.qbo_customer_id
    LEFT JOIN ch ON ch.qbo_customer_id = qc.qbo_customer_id
    LEFT JOIN lifecycle lc ON lc.qbo_customer_id = qc.qbo_customer_id
    WHERE (p_search IS NULL OR p_search = '' OR qc.display_name ILIKE '%' || p_search || '%')
      AND (
        p_channel IS NULL OR p_channel = ''
        OR (p_channel = 'unassigned' AND ch.channels IS NULL)
        OR (p_channel <> 'unassigned' AND p_channel = ANY(COALESCE(ch.channels, ARRAY[]::text[])))
      )
  ),
  scored AS (
    SELECT
      b.*,
      (
        b.active
        AND COALESCE(b.revenue_365, 0) = 0
        AND COALESCE(b.ar_balance, 0) = 0
        AND COALESCE(b.future_invoice_count, 0) = 0
        AND (b.last_invoice_date IS NULL OR b.last_invoice_date < current_date - interval '365 days')
      ) AS can_inactivate,
      CASE
        WHEN b.active IS FALSE THEN 'Already inactive'
        WHEN COALESCE(b.ar_balance, 0) > 0 THEN 'Open AR'
        WHEN COALESCE(b.future_invoice_count, 0) > 0 THEN 'Future invoice'
        WHEN COALESCE(b.revenue_365, 0) > 0 THEN 'Recent revenue'
        WHEN b.last_invoice_date IS NULL THEN 'No invoice history'
        WHEN b.last_invoice_date < current_date - interval '365 days' THEN 'Dormant ' || (current_date - b.last_invoice_date)::text || 'd'
        ELSE 'Watch'
      END AS inactive_reason
    FROM base b
  ),
  actioned AS (
    SELECT
      s.*,
      CASE
        WHEN s.lifecycle_status IN ('requested', 'running', 'sf_done') THEN 'Queued Inactive'
        WHEN s.lifecycle_status IN ('sf_failed', 'qbo_failed') THEN 'Fix Inactive Error'
        WHEN s.lifecycle_status = 'blocked' THEN 'Blocked Inactive'
        WHEN s.active IS FALSE THEN 'Inactive'
        WHEN s.can_inactivate THEN 'Review Inactive'
        WHEN COALESCE(s.ar_90_plus, 0) > 0 OR COALESCE(s.days_oldest_overdue, 0) >= 90 THEN 'Collect AR'
        WHEN COALESCE(s.ar_overdue, 0) > 0 THEN 'Collect AR'
        WHEN COALESCE(s.future_invoice_count, 0) > 0 THEN 'Future Invoice'
        WHEN COALESCE(s.cost_coverage_pct, 1) < 0.95 AND COALESCE(s.revenue_365, 0) > 0 THEN 'Review Cost'
        WHEN COALESCE(s.margin_pct_365, 0) < 0 AND COALESCE(s.revenue_365, 0) > 0 THEN 'Review Margin'
        WHEN COALESCE(s.top_item_share_pct, 0) >= 0.50 AND COALESCE(s.revenue_365, 0) > 0 THEN 'Expand Basket'
        ELSE 'Healthy'
      END AS next_action
    FROM scored s
  )
  SELECT
    a.qbo_customer_id,
    a.display_name,
    a.is_sub_customer,
    a.active,
    a.state,
    a.customer_type_name,
    a.ytd_revenue,
    a.invoice_count,
    a.channels,
    a.primary_channel,
    a.last_invoice_date,
    a.revenue_365,
    a.est_margin_365,
    a.margin_pct_365,
    a.cost_coverage_pct,
    a.top_item_name,
    a.top_item_revenue,
    a.top_item_share_pct,
    a.ar_balance,
    a.ar_overdue,
    a.ar_90_plus,
    a.days_oldest_overdue,
    a.future_invoice_count,
    a.future_revenue,
    a.future_last_invoice_date,
    a.lifecycle_action_id,
    a.lifecycle_status,
    a.lifecycle_last_error,
    a.lifecycle_requested_at,
    a.can_inactivate,
    a.inactive_reason,
    a.next_action,
    CASE a.next_action
      WHEN 'Queued Inactive' THEN 120
      WHEN 'Fix Inactive Error' THEN 115
      WHEN 'Review Inactive' THEN 100
      WHEN 'Collect AR' THEN 90
      WHEN 'Review Cost' THEN 80
      WHEN 'Review Margin' THEN 75
      WHEN 'Future Invoice' THEN 65
      WHEN 'Expand Basket' THEN 50
      WHEN 'Blocked Inactive' THEN 40
      WHEN 'Inactive' THEN 5
      ELSE 10
    END::int AS priority_score
  FROM actioned a
  ORDER BY priority_score DESC, a.ytd_revenue DESC NULLS LAST, a.display_name
  LIMIT GREATEST(COALESCE(p_limit, 200), 1)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

GRANT EXECUTE ON FUNCTION ops.fn_customer_classification_list(text, text, date, date, int, int) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
