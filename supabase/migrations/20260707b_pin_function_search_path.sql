-- Harden `function_search_path_mutable` (Supabase security advisor, 54 WARN).
--
-- Every user-defined function in ops/orders/public that lacked an explicit
-- search_path now pins one. A SECURITY DEFINER (or even INVOKER) function with
-- a mutable search_path can be tricked into resolving an unqualified object
-- name to an attacker-created object in an earlier schema on the path. Pinning
-- a fixed list closes that.
--
-- The pinned list (ops, orders, public, pg_temp) covers the schemas these
-- functions already resolve against, so behavior is unchanged; pg_temp is last
-- so a temp object can never shadow a real one. Extension-owned functions
-- (pgvector / pg_trgm / cube / earthdistance) are intentionally NOT touched —
-- those are managed by their extensions (and are the separate
-- `extension_in_public` advisory).
--
-- Applied out-of-band via the Supabase MCP against gfsdpwiqzshhexkofiif; this
-- file keeps the repo authoritative.

ALTER FUNCTION ops.categorize_expense(p_account_id text) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.categorize_revenue(p_account_id text) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.fn_bom_item_volume_fl_oz(p_name text, p_type text) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.fn_bom_uom_to_fl_oz(p_qty numeric, p_uom text) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.fn_touch_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.is_customer_lifecycle_admin() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.is_superadmin_jwt() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.last_sync_at(p_source text, p_sync_type text) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.set_proposal_builder_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.set_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.tg_copack_orders_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.tg_customer_lifecycle_actions_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.tg_expense_requests_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.tg_inventory_locations_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.tg_inventory_transfers_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.tg_product_bom_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.tg_purchase_orders_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.tg_resq_sf_links_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.tg_site_settings_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.tg_sync_customers_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.tg_touch_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.tg_work_orders_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.touch_customer_groups_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.touch_customer_tags_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.touch_fleet_break_locations_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.touch_kpi_exclusions_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.touch_rental_contracts_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.touch_revenue_categories_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.touch_third_party_crews_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.touch_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION ops.touch_vehicle_assignments_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION orders.cylinder_label_from_btrf(p_desc text, p_item_name text) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION orders.cylinder_label_from_item(p_item_name text) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION orders.next_order_number() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION orders.order_lines_recompute_trigger() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION orders.price_for_customer(p_customer_id uuid, p_catalog_item_id uuid) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION orders.recompute_order_totals(p_order_id uuid) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION orders.set_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION orders.tg_rental_autopay_items_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.asset_warranties_touch_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.audit_log_deny_modify() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.audit_log_hash_chain() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.gateway_apps_touch() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.match_knowledge_chunks(p_customer_id bigint, p_query vector, p_k integer) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.match_knowledge_chunks(p_customer_id bigint, p_query vector, p_k integer, p_job_id bigint) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.pm_assignments_touch_updated_at() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.po_shipment_items_recompute_trg() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.po_shipments_recompute_lines_trg() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.po_shipments_touch_trg() SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.qbo_token_claim_refresh(p_realm_id text, p_min_ttl_seconds integer, p_lease_seconds integer) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.qbo_token_persist(p_realm_id text, p_access_token text, p_access_expires timestamp with time zone, p_refresh_token text, p_refresh_expires timestamp with time zone, p_refreshed_by text) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.qbo_token_release_failed(p_realm_id text, p_error text) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.recompute_po_line_qty_shipped(p_line_id bigint) SET search_path = ops, orders, public, pg_temp;
ALTER FUNCTION public.seed_tracker_checklist(p_job_id bigint) SET search_path = ops, orders, public, pg_temp;
