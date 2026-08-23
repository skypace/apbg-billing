-- Fix for the column-level REVOKE pattern in 20260505e_pii_redact_side_tables.sql.
--
-- The original migration ran `REVOKE SELECT (col) ON ops.X FROM anon` and
-- expected anon's SELECT * queries to no longer return that column. In
-- Postgres, that's not how column-level GRANT/REVOKE interacts with
-- table-level privileges: when a role still holds a table-level SELECT
-- grant, the role can read every column regardless of any column-level
-- REVOKE. Verified post-apply via `SET ROLE anon; SELECT notes FROM
-- ops.delivery_stops` — the SELECT succeeded, returning the column.
--
-- The correct pattern is to revoke the table-level grant entirely and then
-- re-grant SELECT only on the safe columns. Once that's in place, anon
-- queries that reference a redacted column return permission denied; safe
-- columns continue to read normally.
--
-- Both consumer audits (Margin Minder + apbg-ops) were already clean of
-- notes/memo references, so this is a no-op for current consumers — it
-- just makes the redaction actually work.

REVOKE SELECT ON ops.delivery_stops FROM anon;
GRANT SELECT (
  id, sf_job_id, sf_job_number, stop_date, driver_id, driver_name,
  customer_ref_id, customer_name, address, arrival_time, departure_time,
  duration_min, status, invoice_amount, qbo_invoice_id, synced_at,
  sf_total, payment_status, qbo_invoice_matched, stale_alert_sent,
  sf_status, sf_qb_invoice_number, sf_encoded_id
) ON ops.delivery_stops TO anon;

REVOKE SELECT ON ops.service_jobs FROM anon;
GRANT SELECT (
  id, sf_job_id, sf_job_number, job_date, tech_id, tech_name,
  customer_ref_id, customer_name, job_type, status, dispatch_time,
  arrival_time, completion_time, duration_min, billable_hours,
  parts_cost, labor_cost, invoice_amount, qbo_invoice_id, is_callback,
  first_time_fix, synced_at, sf_total, payment_status, qbo_invoice_matched,
  stale_alert_sent, sf_status, sf_qb_invoice_number, sf_encoded_id
) ON ops.service_jobs TO anon;

REVOKE SELECT ON ops.reman_jobs FROM anon;
GRANT SELECT (
  id, sf_job_id, sf_job_number, intake_date, completion_date, tech_id,
  tech_name, equipment_type, serial_number, status, parts_cost,
  labor_hours, labor_cost, sale_price, customer_ref_id, synced_at,
  sf_total, payment_status, qbo_invoice_matched, stale_alert_sent,
  sf_status, sf_qb_invoice_number, sf_encoded_id, warranty_returned_at,
  warranty_returned_reason, field_failure_at, field_failure_reason
) ON ops.reman_jobs TO anon;

REVOKE SELECT ON ops.qbo_invoices FROM anon;
GRANT SELECT (
  id, qbo_invoice_id, doc_number, txn_date, due_date, customer_ref_id,
  customer_name, public_customer_id, total_amount, balance, status,
  department, entity, synced_at, qbo_updated_at
) ON ops.qbo_invoices TO anon;
