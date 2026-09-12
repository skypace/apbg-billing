-- 20260912a · the timeline says WHO, and a PO and a work order can see each other
--
-- From the production team's test notes (Calli, 2026-09-11):
--   "Would be sweet if [the timeline] has a note of which user in the system
--    added the information … good for traceability for us all to see who is
--    doing what and when."
--   "Better ability to tie a PO to a work order … Would be ideal to be able to
--    open a work order and have it be linked to the associated PO and vice versa."
--
-- Both were DATA problems dressed as feature requests: work_order_events has
-- carried created_by (auth.users.id) since 20260721a and the screen printed
-- only the time; purchase_orders has carried work_order_id since 20260721a and
-- production_run_id + purchase_order_line_demand since 20260903f, and the
-- screens rendered the number as text with no link either way.
--
-- (1) ops.v_work_order_events — the events plus the actor's display name.
--     ⚠ NOT security_invoker, on purpose: auth.users is readable by the view's
--     owner and by nobody the browser logs in as, and a display name is the
--     whole point. The view therefore re-applies the gate itself:
--     ops.fn_is_internal() in the WHERE, so a customer, partner or foodservice
--     login on this shared project reads zero rows — the same population the
--     table's own RLS admits (work_order_events_no_distributor + fn_is_staff).
--     Name = user_metadata.full_name, else the part of the email before the @
--     (215 of 233 accounts carry a name; an address is a worse label than a
--     name but a better one than a UUID). ⚠ The events table's created_by is
--     NULL when a step was run by pg_cron or the service role; that prints as
--     "system", never as a person.
--
-- (2) ops.v_work_order_purchase_orders — one row per (work order, PO) pair,
--     both directions of the link in one place: a PO raised FOR a work order
--     (purchase_orders.work_order_id) and a PO raised for the work order's RUN
--     that covers one of its material lines (purchase_order_line_demand). `via`
--     says which. The work-order detail reads it by wo_id, the PO detail by
--     po_id, so neither screen composes the join itself.
--     security_invoker: it reads purchase_orders / work_orders / line_demand
--     under the caller's own RLS.
--
-- (3) A run PO's notes name the flavours it covers. Single-work-order POs have
--     said "Materials for work order WO-…" since 20260721a; a run PO said only
--     "Materials for run RUN-…". Sky (2026-09-12): "link the PO and work orders
--     in the notes field" — so fn_run_generate_pos now appends " · flavours:
--     WO-…, WO-…" (one anchor in the LIVE body, asserted to match exactly
--     once; fn_run_generate_pos carries its guard inline, so CREATE OR REPLACE
--     of the live text is the right move here, unlike a 20260820b wrapper).
--     Nothing to backfill: no production order has raised a PO yet.

-- (1) ------------------------------------------------------------------------
CREATE OR REPLACE VIEW ops.v_work_order_events AS
SELECT e.id, e.wo_id, e.event_type, e.from_status, e.to_status, e.note, e.payload,
       e.created_by, e.created_at,
       CASE
         WHEN e.created_by IS NULL THEN 'system'
         ELSE COALESCE(NULLIF(trim(u.raw_user_meta_data->>'full_name'), ''),
                       split_part(u.email, '@', 1),
                       'unknown user')
       END AS created_by_name,
       u.email AS created_by_email
  FROM ops.work_order_events e
  LEFT JOIN auth.users u ON u.id = e.created_by
 WHERE ops.fn_is_internal();

COMMENT ON VIEW ops.v_work_order_events IS
  '20260912a: work_order_events + the actor''s display name from auth.users. Owner-run (NOT security_invoker) so the name can be read; gated on ops.fn_is_internal() in the WHERE instead. created_by NULL = a cron/service-role step, printed as "system".';

REVOKE ALL ON ops.v_work_order_events FROM PUBLIC, anon;
GRANT SELECT ON ops.v_work_order_events TO authenticated, service_role;

-- (2) ------------------------------------------------------------------------
CREATE OR REPLACE VIEW ops.v_work_order_purchase_orders WITH (security_invoker = on) AS
WITH links AS (
  SELECT po.id AS po_id, po.work_order_id AS wo_id, 'work_order'::text AS via
    FROM ops.purchase_orders po
   WHERE po.work_order_id IS NOT NULL
  UNION
  SELECT d.po_id, d.wo_id, 'run'::text
    FROM ops.purchase_order_line_demand d
)
SELECT l.wo_id, w.batch_code, w.status AS wo_status, w.run_id,
       l.po_id, po.po_number, po.qbo_vendor_id, v.display_name AS vendor_name,
       po.status AS po_status, po.close_rule, po.subtotal, po.qbo_purchase_order_id, po.production_run_id,
       l.via
  FROM links l
  JOIN ops.purchase_orders po ON po.id = l.po_id
  JOIN ops.work_orders w ON w.id = l.wo_id
  LEFT JOIN ops.qbo_vendors v ON v.qbo_vendor_id = po.qbo_vendor_id;

COMMENT ON VIEW ops.v_work_order_purchase_orders IS
  '20260912a: every (work order, purchase order) pair — a PO raised for the work order (via=work_order) or for its run covering one of its material lines (via=run, from purchase_order_line_demand). Read by wo_id on the work-order detail and by po_id on the PO detail.';

REVOKE ALL ON ops.v_work_order_purchase_orders FROM PUBLIC, anon;
GRANT SELECT ON ops.v_work_order_purchase_orders TO authenticated, service_role;

-- (3) ------------------------------------------------------------------------
DO $mig$
DECLARE
  v_def TEXT; n INT;
  a TEXT := $a$'Materials for run ' || r.run_number || CASE WHEN v_close_rule = 'on_run_yield' THEN ' · closes when the run ships (nothing is received against it)' ELSE '' END,$a$;
  s TEXT := $s$'Materials for run ' || r.run_number
                  || COALESCE(' · flavours: ' || (SELECT string_agg(w.batch_code || ' (' || COALESCE(b.name, '?') || ')', ', ' ORDER BY w.batch_code)
                                                     FROM ops.work_orders w LEFT JOIN ops.product_bom b ON b.id = w.bom_id
                                                    WHERE w.run_id = p_run_id AND w.status <> 'void'), '')
                  || CASE WHEN v_close_rule = 'on_run_yield' THEN ' · closes when the run ships (nothing is received against it)' ELSE '' END,$s$;
BEGIN
  SELECT pg_get_functiondef('ops.fn_run_generate_pos'::regproc) INTO v_def;
  n := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
  IF n <> 1 THEN RAISE EXCEPTION '20260912a: expected the run-PO notes anchor exactly once in fn_run_generate_pos, found %', n; END IF;
  IF position('fn_assert_internal' in v_def) = 0 THEN RAISE EXCEPTION '20260912a: fn_run_generate_pos no longer carries its inline guard — stop'; END IF;
  EXECUTE replace(v_def, a, s);
  SELECT pg_get_functiondef('ops.fn_run_generate_pos'::regproc) INTO v_def;
  IF position('flavours: ' in v_def) = 0 THEN RAISE EXCEPTION '20260912a: flavour list not present after apply'; END IF;
  IF position('fn_assert_internal' in v_def) = 0 THEN RAISE EXCEPTION '20260912a: guard lost on apply'; END IF;
END
$mig$;
