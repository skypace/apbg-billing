-- Vendor Portal Phase 3b — the Stripe funding float and its bookkeeping.
--
-- Bookkeeping model (Sky, 2026-08-20): the Stripe financial account is mirrored
-- in QuickBooks as a BANK account, "Stripe Vendor Funding". Money in is a QBO
-- Transfer (Chase → Stripe Vendor Funding); every vendor payment is a
-- BillPayment DRAWN ON that account, so the register itemizes per vendor per
-- bill. The account's QBO balance should therefore equal the live Stripe
-- balance — that equality is the reconciliation control, and any drift is a
-- real signal (money moved without booking, or a top-up nobody entered).
--
-- Why this table exists: Stripe CANNOT auto-pull on a low balance. Pulling
-- from a verified bank account is US-only and explicitly manual per transfer
-- ("it isn't an automated, regular transaction"), 2–6 business days, capped
-- 50k/txn · 50k/day · 100k/week. So funding arrives three ways — our
-- InboundTransfer, Sky clicking Top up in the Stripe Dashboard, or a pushed
-- ACH/wire — and ALL THREE need the same QBO Transfer written. One row per
-- funding event, keyed on the Stripe object id, is what makes that idempotent.
--
-- Deliberately NOT used: Stripe's native recurring transfer from the payments
-- balance. brix-order books Stripe payouts as QBO Deposits into Chase 72
-- (sessions 1.80–1.83); diverting that revenue into the financial account
-- would strand those Undeposited-Funds payments and break that reconciler.

-- ── 1. vendor_funding_events ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.vendor_funding_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_object_id   TEXT NOT NULL UNIQUE,    -- ibt_… / credit_… — the idempotency key
  kind               TEXT NOT NULL CHECK (kind IN ('inbound_transfer','received_credit')),
  source             TEXT NOT NULL DEFAULT 'app'
                     CHECK (source IN ('app','dashboard','external')),
  amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency           TEXT NOT NULL DEFAULT 'USD',
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','settled','failed','canceled')),
  qbo_transfer_id    TEXT,                    -- the QBO Transfer this event booked
  qbo_booked_at      TIMESTAMPTZ,
  book_error         TEXT,                    -- QBO refused; row stays for retry
  initiated_by       TEXT,                    -- staff email, or 'cron (auto top-up)'
  failure_reason     TEXT,
  stripe_created_at  TIMESTAMPTZ,             -- the sync cursor
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_funding_events_recent_idx
  ON ops.vendor_funding_events (stripe_created_at DESC NULLS LAST);
-- The work queue: settled funding that QuickBooks hasn't been told about yet.
CREATE INDEX IF NOT EXISTS vendor_funding_events_unbooked_idx
  ON ops.vendor_funding_events (created_at)
  WHERE qbo_transfer_id IS NULL AND status = 'settled';

DROP TRIGGER IF EXISTS vendor_funding_events_touch ON ops.vendor_funding_events;
CREATE TRIGGER vendor_funding_events_touch
  BEFORE UPDATE ON ops.vendor_funding_events
  FOR EACH ROW EXECUTE FUNCTION ops.tg_compliance_touch();

-- ── 2. Grants + RLS — staff read, service-role writes only ──────────────────
GRANT SELECT ON ops.vendor_funding_events TO authenticated;
GRANT ALL ON ops.vendor_funding_events TO service_role;

ALTER TABLE ops.vendor_funding_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_funding_staff_select ON ops.vendor_funding_events;
CREATE POLICY vendor_funding_staff_select ON ops.vendor_funding_events
  FOR SELECT TO authenticated
  USING (ops.fn_is_staff());

-- ── 3. Config (no new table — rides the Brixpense settings blob) ────────────
-- auto_top_up ships FALSE: money movement starts with a human, same rule as
-- the 2026-08-14 Brixpense full gate. Amounts are whole dollars.
INSERT INTO ops.expense_settings (key, value)
VALUES ('vendor_funding',
        '{"floor": 2500, "target": 10000, "auto_top_up": false, "max_per_day": 10000}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 4. Health check ─────────────────────────────────────────────────────────
-- The DB can't see Stripe, so the cron writes what it observed into
-- ops.sync_log.metadata (balance, below_floor) and this reads it back.
--   red    — a pull FAILED in the last 7d (money didn't arrive and someone
--            thinks it did), settled funding unbooked in QBO >24h (the two
--            balances have silently diverged), or the latest cron run errored.
--   yellow — balance under the floor (payouts will start refusing), or the
--            daily run hasn't reported in >48h.
-- Green before the first run: the feature ships dark.
CREATE OR REPLACE FUNCTION ops.fn_vendor_funding_health()
 RETURNS TABLE(check_name text, status text, last_event_at timestamp with time zone, age_seconds integer, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'public'
AS $function$
declare
  v_failed_ct int;
  v_unbooked_ct int;
  v_run_at timestamptz;
  v_run_status text;
  v_run_err text;
  v_meta jsonb;
  v_below boolean;
  v_balance text;
begin
  select count(*) into v_failed_ct from ops.vendor_funding_events e
    where e.status = 'failed' and e.updated_at > now() - interval '7 days';
  select count(*) into v_unbooked_ct from ops.vendor_funding_events e
    where e.status = 'settled' and e.qbo_transfer_id is null
      and e.created_at < now() - interval '24 hours';

  select s.completed_at, s.status, s.error_message, s.metadata
    into v_run_at, v_run_status, v_run_err, v_meta
    from ops.sync_log s
    where s.source = 'vendors' and s.sync_type = 'vendor_funding'
    order by s.completed_at desc nulls last limit 1;

  v_below := coalesce((v_meta->>'below_floor')::boolean, false);
  v_balance := coalesce(v_meta->>'balance', '?');

  check_name := 'vendor_funding';
  last_event_at := v_run_at;
  age_seconds := coalesce(extract(epoch from (now() - v_run_at))::int, null);

  if v_run_at is null and v_failed_ct = 0 and v_unbooked_ct = 0 then
    status := 'green';
    detail := 'Stripe vendor funding has not reported yet (daily cron; account funds manually until then)';
    return next;
    return;
  end if;

  status := case
    when v_failed_ct > 0 or v_unbooked_ct > 0 or v_run_status = 'error' then 'red'
    when v_below or v_run_at is null or v_run_at < now() - interval '48 hours' then 'yellow'
    else 'green' end;

  detail := case
    when v_failed_ct > 0 then v_failed_ct || ' funding transfer(s) FAILED in the last 7d — the Stripe balance is short. '
    else '' end
    || case
    when v_unbooked_ct > 0 then v_unbooked_ct || ' settled funding event(s) not booked to QuickBooks after 24h — the Stripe Vendor Funding balance no longer matches Stripe. '
    else '' end
    || case
    when v_run_status = 'error' then 'last funding run errored [' || coalesce(left(v_run_err,140),'') || ']. '
    when v_run_at is null then 'no funding run on record. '
    when v_run_at < now() - interval '48 hours' then 'daily funding run has not reported in >48h. '
    else '' end
    || case
    when v_below then 'Stripe payout balance $' || v_balance || ' is BELOW the top-up floor — vendor payments will refuse.'
    when v_run_status = 'success' then 'Stripe payout balance $' || v_balance || ', above floor.'
    else '' end;
  return next;
end;
$function$;

-- ── 5. Wire into fn_sync_health_extra (whole function re-declared: the live
--       20260820c body plus the vendor_funding call) ────────────────────────
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

  -- Vendor payment ledger + the Stripe funding float (Vendor Portal Phase 3/3b).
  return query select * from ops.fn_vendor_payments_health();
  return query select * from ops.fn_vendor_funding_health();

  -- Mirror staleness for every QBO mirror table. See ops.fn_mirror_freshness()
  -- for the modes and why CDC tables must be measured off sync_log, not data.
  return query select * from ops.fn_mirror_freshness();
end;
$function$;
