-- §12 #6b — column-level redaction of free-text PII on side tables.
--
-- Audit context (Sky, 2026-05-05):
--   - Structured PII (email/phone/formal addresses) lives only on
--     ops.qbo_customers, gated by 20260505b + 20260505c.
--   - Residual surface on side tables = free-text columns that could
--     contain anything: notes (delivery_stops, service_jobs, reman_jobs)
--     and memo (qbo_invoices). Worth redacting.
--   - customer_name / driver_name / tech_name / addresses on side
--     tables are accepted (every dashboard row labels itself with these).
--
-- Consumer audits returned clean on both sides:
--   - Margin Minder (this repo): zero reads of notes / memo from any
--     of these tables.
--   - Apbg-ops: zero reads of notes / memo from any of these tables;
--     ops's only notes/memo reads are on its own tables (team_members,
--     third_party_crews).
--
-- This migration uses Postgres column-level GRANT/REVOKE (not RLS or a
-- view layer). PostgREST respects column grants: when anon issues
-- SELECT *, the redacted column simply isn't included in the response —
-- no error, no breakage. Authenticated callers retain full access via
-- the existing table grants and policies.
--
-- Reversible with one statement per column (re-grant SELECT to anon).

REVOKE SELECT (notes) ON ops.delivery_stops FROM anon;
REVOKE SELECT (notes) ON ops.service_jobs   FROM anon;
REVOKE SELECT (notes) ON ops.reman_jobs     FROM anon;
REVOKE SELECT (memo)  ON ops.qbo_invoices   FROM anon;

COMMENT ON COLUMN ops.delivery_stops.notes IS
  'Free-text driver notes. PII-redacted from anon as of 20260505e (§12 #6b). Authenticated callers retain access.';
COMMENT ON COLUMN ops.service_jobs.notes IS
  'Free-text service notes. PII-redacted from anon as of 20260505e (§12 #6b). Authenticated callers retain access.';
COMMENT ON COLUMN ops.reman_jobs.notes IS
  'Free-text reman notes. PII-redacted from anon as of 20260505e (§12 #6b). Authenticated callers retain access.';
COMMENT ON COLUMN ops.qbo_invoices.memo IS
  'Free-text invoice memo. PII-redacted from anon as of 20260505e (§12 #6b). Authenticated callers retain access.';
