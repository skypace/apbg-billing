-- Vendor Portal Phase 2 — token-gated vendor onboarding.
--
-- Vendors never get logins. Staff click "Request documents" (Brixpense →
-- Vendors) or the Monday chase cron fires → a one-time link goes out by email
-- → the vendor lands on the public /vendor-onboarding page (visitor-kiosk
-- recipe: unauthenticated, all writes through service-role functions) and
-- uploads their W-9 + COI + payment preference.
--
-- Only the SHA-256 HASH of the token is stored — the raw token exists only
-- inside the emailed link, so a database read can never impersonate a link.
-- Tokens expire after 14 days and are single-completion (used_at); uploads
-- before completion ride the same token.
--
-- Health: the chase cron logs every run to ops.sync_log (source='vendors',
-- sync_type='vendor_doc_chase') and fn_sync_health_extra() gains a check —
-- repo rule: no unmonitored pipeline.

-- ── 1. vendor_onboard_tokens ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.vendor_onboard_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   UUID NOT NULL REFERENCES ops.vendors(id),
  token_hash  TEXT NOT NULL UNIQUE,          -- sha256 hex of the raw token (raw lives only in the emailed link)
  purpose     TEXT NOT NULL DEFAULT 'onboard'
              CHECK (purpose IN ('onboard','docs_refresh')),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,                   -- stamped when the vendor completes the flow
  sent_to     TEXT,                          -- email address the link went to
  created_by  TEXT,                          -- staff email, or 'chase-cron'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_onboard_tokens_vendor_idx
  ON ops.vendor_onboard_tokens (vendor_id, created_at DESC);

-- ── 2. Grants + RLS ─────────────────────────────────────────────────────────
-- Staff may SELECT (VendorDetail shows invite status — hashes are harmless);
-- all writes are service-role only (the public intake + the chase cron).
GRANT SELECT ON ops.vendor_onboard_tokens TO authenticated;
GRANT ALL ON ops.vendor_onboard_tokens TO service_role;

ALTER TABLE ops.vendor_onboard_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_onboard_tokens_staff_select ON ops.vendor_onboard_tokens;
CREATE POLICY vendor_onboard_tokens_staff_select ON ops.vendor_onboard_tokens
  FOR SELECT TO authenticated
  USING (ops.fn_is_staff());

-- ── 3. vendor_doc_chase health check ────────────────────────────────────────
-- Extends fn_sync_health_extra() (whole function replaced — body is the live
-- 2026-08-20 version plus the new check). Rules: red when the latest chase
-- run errored; yellow when the weekly run is >8 days late (only once a first
-- run exists — a brand-new check must not sit red before the feature's first
-- Monday, the sf-expense-autopost lesson); green otherwise.
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
  return query select * from ops.fn_mirror_freshness();
end;
$function$;
