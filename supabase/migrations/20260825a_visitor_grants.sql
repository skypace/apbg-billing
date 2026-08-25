-- 20260825a — staff sign-out on the visitor log. Applied live 2026-08-25.
--
-- 20260818e enabled RLS and wrote a staff FOR ALL policy on ops.visitor_visits,
-- but the table was only ever GRANTed SELECT to `authenticated`. Postgres checks
-- table GRANTs BEFORE RLS, so every staff sign-out PATCH from /compliance was
-- rejected with a permission error no matter what the policy said — the button
-- looked dead. Same trap brix-order hit in its 1.10 session.
--
-- No INSERT/DELETE for staff on visits: rows are created by the kiosk's
-- service-role function and are a compliance record — nothing hand-deletes one.
grant update on ops.visitor_visits to authenticated;
grant insert, update on ops.visitor_settings to authenticated;

-- Visitor rows are personal data (name, phone, photo path, signature). RLS
-- already denied anon, but the leftover SELECT grant made that a policy detail
-- rather than a hard wall.
revoke select on ops.visitor_visits from anon;
