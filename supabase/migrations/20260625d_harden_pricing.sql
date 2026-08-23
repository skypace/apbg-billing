-- ============================================================================
-- PRICING CONTROL CENTER — security hardening
-- ============================================================================
-- Closes two gaps the Supabase security advisor flagged after the pricing
-- model shipped (20260625a/b/c):
--
--   1. ops.pricing_contract_customers shipped WITHOUT row-level security. Every
--      other pricing table had RLS on (no anon policy → service-role only), but
--      this join table was readable/writable by anon + authenticated. Enable RLS
--      so it matches its siblings: no policy = service-role only.
--
--   2. resolve_price() and resolve_prices_for_customer() are SECURITY DEFINER
--      (they read every pricing table, bypassing RLS). They were EXECUTE-able by
--      public/anon/authenticated, which let any signed-in customer resolve ANY
--      other customer's contract pricing by passing a different qbo_customer_id.
--      Revoke execute from everyone but service_role. brix-order's submit-order
--      and customer-prices functions call these with the service key, so the app
--      is unaffected; only the public/anon leak is closed.
--
-- Applied to live (gfsdpwiqzshhexkofiif) 2026-06-25 via Supabase MCP
-- (migration name: harden_pricing_rls_and_resolvers). This file makes the repo
-- authoritative. Idempotent — safe to re-run.
-- ============================================================================

alter table ops.pricing_contract_customers enable row level security;

revoke execute on function ops.resolve_price(text, text, date)
  from public, anon, authenticated;
revoke execute on function ops.resolve_prices_for_customer(text, date)
  from public, anon, authenticated;

grant execute on function ops.resolve_price(text, text, date) to service_role;
grant execute on function ops.resolve_prices_for_customer(text, date) to service_role;
