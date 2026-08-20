-- Vendor Portal Phase 3 — the payments ledger + the Stripe recipient link.
--
-- Rail decided by Sky 2026-08-20: Stripe Global Payouts on the existing
-- Alameda Point Beverage Group Stripe account (financial account already
-- activated). The vendor's bank details live with STRIPE (hosted recipient
-- onboarding) — the ONLY Stripe datum stored here is the v2 recipient
-- Account id. Venmo / Zelle / paper check / QBO Bill Pay stay manual rails:
-- a human sends the money and records it, which writes the QBO BillPayment.
--
-- No auto-pay, ever (Phase 0 rule): every ledger row starts from an explicit
-- superadmin click in Brixpense. Writes are service-role only (vendor-pay.mjs
-- + stripe-payout-webhook.mjs); staff read the history under RLS.

-- ── 1. vendors.stripe_recipient_id ──────────────────────────────────────────
ALTER TABLE ops.vendors ADD COLUMN IF NOT EXISTS stripe_recipient_id TEXT;

-- ── 2. vendor_payments ledger ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.vendor_payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id           UUID NOT NULL REFERENCES ops.vendors(id),
  expense_request_id  UUID REFERENCES ops.expense_requests(id),
  qbo_bill_id         TEXT,                    -- the QBO Bill being paid (null for non-bill payments)
  rail                TEXT NOT NULL CHECK (rail IN
                        ('stripe_payout','venmo_manual','zelle_manual','check_manual','qbo_billpay')),
  amount              NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency            TEXT NOT NULL DEFAULT 'USD',
  status              TEXT NOT NULL DEFAULT 'initiated'
                      CHECK (status IN ('initiated','settled','failed','recorded')),
  external_payout_id  TEXT,                    -- Stripe OutboundPayment id (obp_…)
  qbo_billpayment_id  TEXT,                    -- QBO BillPayment once booked
  reference           TEXT,                    -- manual-rail reference (check #, Venmo txn, …)
  initiated_by        TEXT,                    -- staff email
  failure_reason      TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_payments_vendor_idx
  ON ops.vendor_payments (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vendor_payments_expense_idx
  ON ops.vendor_payments (expense_request_id) WHERE expense_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vendor_payments_external_idx
  ON ops.vendor_payments (external_payout_id) WHERE external_payout_id IS NOT NULL;
-- Duplicate guard at the DB level: one LIVE payment per QBO bill (failed rows
-- release the bill for a retry).
CREATE UNIQUE INDEX IF NOT EXISTS vendor_payments_live_bill_idx
  ON ops.vendor_payments (qbo_bill_id)
  WHERE qbo_bill_id IS NOT NULL AND status IN ('initiated','settled','recorded');

DROP TRIGGER IF EXISTS vendor_payments_touch ON ops.vendor_payments;
CREATE TRIGGER vendor_payments_touch
  BEFORE UPDATE ON ops.vendor_payments
  FOR EACH ROW EXECUTE FUNCTION ops.tg_compliance_touch();

-- ── 3. Grants + RLS — staff read, service-role writes only ──────────────────
GRANT SELECT ON ops.vendor_payments TO authenticated;
GRANT ALL ON ops.vendor_payments TO service_role;

ALTER TABLE ops.vendor_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_payments_staff_select ON ops.vendor_payments;
CREATE POLICY vendor_payments_staff_select ON ops.vendor_payments
  FOR SELECT TO authenticated
  USING (ops.fn_is_staff());

-- ── 4. vendor_payments health check ─────────────────────────────────────────
-- Money movement gets watched (repo rule). Red when a payout FAILED in the
-- last 7 days (someone must re-send or record it another way) or when an
-- 'initiated' Stripe payout has sat >48h without the webhook settling it
-- (webhook broken, or the payout is stuck at Stripe). Green when empty.
CREATE OR REPLACE FUNCTION ops.fn_vendor_payments_health()
 RETURNS TABLE(check_name text, status text, last_event_at timestamp with time zone, age_seconds integer, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'public'
AS $function$
declare
  v_failed_ct int;
  v_stuck_ct int;
  v_last timestamptz;
begin
  select count(*) into v_failed_ct from ops.vendor_payments p
    where p.status = 'failed' and p.updated_at > now() - interval '7 days';
  select count(*) into v_stuck_ct from ops.vendor_payments p
    where p.status = 'initiated' and p.rail = 'stripe_payout'
      and p.created_at < now() - interval '48 hours';
  select max(p.updated_at) into v_last from ops.vendor_payments p;

  check_name := 'vendor_payments';
  last_event_at := v_last;
  age_seconds := coalesce(extract(epoch from (now() - v_last))::int, null);
  status := case
    when v_failed_ct > 0 or v_stuck_ct > 0 then 'red'
    else 'green' end;
  detail := case
    when v_failed_ct > 0 or v_stuck_ct > 0 then
      'vendor payouts need attention: ' || v_failed_ct || ' failed (7d), '
      || v_stuck_ct || ' stuck initiated >48h — Brixpense → Vendors → payment history'
    when v_last is null then 'no vendor payments recorded yet'
    else 'vendor payment ledger healthy' end;
  return next;
end;
$function$;

-- ── 5. Wire into fn_sync_health_extra (whole function re-declared: the
--       live 20260820b body plus the vendor_payments call) ─────────────────
CREATE OR REPLACE FUNCTION ops.fn_sync_health_extra()
 RETURNS TABLE(check_name text, status text, last_event_at timestamp with time zone, age_seconds integer, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'orders', 'public'
AS $function$
declare
  v_resq ops.resq_sf_token_cache%rowtype;
  v_cookie_at timestamptz;
  v_fb_at timestamptz;
  v_fb_err text;
  v_shop ops.shopify_sync_config%rowtype;
  v_err_ct int;
  v_unmapped_ct int;
  v_chase_at timestamptz;
  v_chase_status text;
  v_chase_err text;
begin
  select * into v_resq from ops.resq_sf_token_cache t order by t.updated_at desc nulls last limit 1;
  check_name := 'resq_sf_token';
  if v_resq.id is null or coalesce(v_resq.refresh_token,'') = '' then
    last_event_at := null; age_seconds := null; status := 'red';
    detail := 'no ResQ SF token cached — re-auth via sf-connect (?start=1&secret=…)';
  else
    last_event_at := v_resq.updated_at;
    age_seconds := coalesce(extract(epoch from (now() - v_resq.updated_at))::int, null);
    status := case
      when v_resq.refresh_token_expires_at is not null and v_resq.refresh_token_expires_at < now() then 'red'
      when v_resq.last_error is not null and v_resq.updated_at > now() - interval '2 hours' then 'red'
      when v_resq.updated_at < now() - interval '72 hours' then 'yellow'
      else 'green' end;
    detail := 'ResQ SF token refresh #' || coalesce(v_resq.refresh_count::text,'?') ||
      case when v_resq.last_error is not null then ' [last_error: ' || left(v_resq.last_error,140) || ']' else '' end;
  end if;
  return next;

  select s.updated_at into v_cookie_at from orders.sf_portal_session s where s.id = 1;
  check_name := 'sf_portal_cookie';
  last_event_at := v_cookie_at;
  age_seconds := coalesce(extract(epoch from (now() - v_cookie_at))::int, null);
  status := case
    when v_cookie_at is null then 'red'
    when v_cookie_at < now() - interval '30 days' then 'red'
    when v_cookie_at < now() - interval '14 days' then 'yellow'
    else 'green' end;
  detail := case when v_cookie_at is null then 'no SF admin-portal session cookie — receipt images cannot attach'
    else 'SF admin-portal cookie last refreshed ' || greatest(0, extract(epoch from (now()-v_cookie_at))::int/86400) || 'd ago (Make hook refreshes on demand)' end;
  return next;

  select s.completed_at, s.error_message into v_fb_at, v_fb_err
    from ops.sync_log s
    where s.source = 'qbo' and s.sync_type = 'netlify_token_fallback'
    order by s.completed_at desc nulls last limit 1;
  check_name := 'qbo_netlify_chain';
  last_event_at := v_fb_at;
  age_seconds := coalesce(extract(epoch from (now() - v_fb_at))::int, null);
  status := case
    when v_fb_at is not null and v_fb_at > now() - interval '24 hours' then 'red'
    else 'green' end;
  detail := case
    when v_fb_at is not null and v_fb_at > now() - interval '24 hours'
      then 'Billing QBO chain BROKEN — riding shared edge token. Re-auth via Master Control → Connections. [' || coalesce(left(v_fb_err,140),'') || ']'
    when v_fb_at is not null
      then 'own chain healthy (last fallback signal ' || greatest(0, extract(epoch from (now()-v_fb_at))::int/86400) || 'd ago)'
    else 'own chain healthy (no fallback signals on record)' end;
  return next;

  select * into v_shop from ops.shopify_sync_config c where c.id = 1;
  select count(*) into v_err_ct from ops.shopify_sync_orders o
    where o.status = 'error' and o.updated_at > now() - interval '24 hours';
  select count(*) into v_unmapped_ct from ops.shopify_sync_orders o
    where o.had_unmapped_sku and o.updated_at > now() - interval '7 days';
  check_name := 'shopify_qbo_sync';
  last_event_at := v_shop.last_run_at;
  age_seconds := coalesce(extract(epoch from (now() - v_shop.last_run_at))::int, null);
  if v_shop.id is null or not v_shop.enabled then
    status := 'green';
    detail := 'shopify-qbo-sync not yet enabled (awaiting Shopify custom-app token + channel-app disconnect)';
  else
    status := case
      when v_err_ct > 0 then 'red'
      when v_shop.last_run_at is null or v_shop.last_run_at < now() - interval '2 hours' then 'red'
      when v_unmapped_ct > 0 then 'yellow'
      else 'green' end;
    detail := 'orders sync: ' || coalesce((v_shop.last_result->>'summary'), 'no result yet')
      || case when v_err_ct > 0 then ' [' || v_err_ct || ' order(s) in error — see ops.shopify_sync_orders]' else '' end
      || case when v_unmapped_ct > 0 then ' [' || v_unmapped_ct || ' order(s) with unmapped SKUs — add to ops.shopify_item_map]' else '' end;
  end if;
  return next;

  -- Vendor document chase (Vendor Portal Phase 2): the Monday cron logs every
  -- run, chases or not. Red = latest run errored; yellow = weekly run missed
  -- by >1 day; green before the first run (feature freshly shipped).
  select s.completed_at, s.status, s.error_message into v_chase_at, v_chase_status, v_chase_err
    from ops.sync_log s
    where s.source = 'vendors' and s.sync_type = 'vendor_doc_chase'
    order by s.completed_at desc nulls last limit 1;
  check_name := 'vendor_doc_chase';
  last_event_at := v_chase_at;
  age_seconds := coalesce(extract(epoch from (now() - v_chase_at))::int, null);
  if v_chase_at is null then
    status := 'green';
    detail := 'vendor document chase has not run yet (fires Mondays with the compliance digest)';
  else
    status := case
      when v_chase_status = 'error' then 'red'
      when v_chase_at < now() - interval '8 days' then 'yellow'
      else 'green' end;
    detail := 'weekly vendor COI/W-9 chase last ran ' || greatest(0, extract(epoch from (now()-v_chase_at))::int/86400) || 'd ago'
      || case when v_chase_status = 'error' then ' [ERROR: ' || coalesce(left(v_chase_err,140),'') || ']' else '' end;
  end if;
  return next;

  -- Mirror staleness for every QBO mirror table. See ops.fn_mirror_freshness()
  -- for the modes and why CDC tables must be measured off sync_log, not data.
  -- Vendor payment ledger (Vendor Portal Phase 3).
  return query select * from ops.fn_vendor_payments_health();

  return query select * from ops.fn_mirror_freshness();
end;
$function$;
