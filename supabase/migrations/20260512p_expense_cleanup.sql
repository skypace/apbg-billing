-- ============================================================================
-- Brixpense — reconcile dueling expense migrations + finish seed
-- ============================================================================
-- Companion to 20260512_create_expense_tables.sql (the live schema).
--
-- Why this exists:
--   Two migrations dated 2026-05-12 both ran CREATE TABLE IF NOT EXISTS on
--   ops.expense_requests with overlapping but non-identical shapes. The
--   first (no-suffix) ran first and won; the second (suffix 'o') no-oped
--   on the requests table but DID create a redundant
--   ops.expense_request_approvals (plural) that no netlify function or
--   frontend code reads or writes.
--
-- Source of truth = 20260512_create_expense_tables.sql. The function code
-- uses `request_type`, `expense_approvals` (singular), `auto_approve_threshold`,
-- and `approval_email`. This file is a cleanup pass against that reality.
--
-- Safe to re-run; every statement is idempotent.
-- ============================================================================

-- ── 1. Drop the orphan plural-named approvals table ────────────────────────
-- Created by 20260512o; never written or read by any code. The live table is
-- ops.expense_approvals (singular).
DROP TABLE IF EXISTS ops.expense_request_approvals CASCADE;


-- ── 2. Finish seeding ops.expense_settings ─────────────────────────────────
-- The base migration seeds auto_approve_threshold (250),
-- approval_email ("wgrandell@brixbev.com"), and a generic departments list.
-- The Brixpense UI also wants:
--   • cogs_accounts   — typed COGS dropdown (Service / Equipment + new buckets)
--   • manager_emails  — eligible approvers for "Route to" picker
--   • tags            — business tag dropdown (project/event/vehicle/...)
-- Department list also gets re-aligned to the Brix entity → COGS mapping
-- documented in CLAUDE.md ("Business rules → Department-to-COGS mapping").

INSERT INTO ops.expense_settings (key, value) VALUES
  -- COGS dropdown. The two existing QBO accounts (Service COGS=101,
  -- Equipment Sales COGS=42) are wired; the seven new buckets have null
  -- ids until they are either mapped to existing QBO accounts or created
  -- in QBO. expense-request-link-bill falls back to Service COGS (101)
  -- when cogs_account_id is null.
  ('cogs_accounts', $$[
    {"id": "101", "label": "Service COGS"},
    {"id": "42",  "label": "Equipment Sales COGS"},
    {"id": null,  "label": "Fuel"},
    {"id": null,  "label": "Office Supplies"},
    {"id": null,  "label": "Working Meals"},
    {"id": null,  "label": "Travel"},
    {"id": null,  "label": "Repair & Maintenance — Building"},
    {"id": null,  "label": "New Fountain Installs COGS"},
    {"id": null,  "label": "Ice Machine Rental COGS"}
  ]$$::jsonb),

  -- Approvers eligible to receive routed requests. Auth-side check still
  -- enforced (manager_email = lower(jwt.email)) in any future RLS tighten.
  ('manager_emails', $$[
    "anthonyv@brixbev.com",
    "skypace@brixbev.com",
    "asloan@brixbev.com",
    "marco@brixbev.com",
    "joel@brixbev.com",
    "wgrandell@brixbev.com"
  ]$$::jsonb),

  -- Business tag dropdown. Drives the secondary classifier shown after
  -- entity selection on the form.
  ('tags', $$["project","event","vehicle","customer","store","general"]$$::jsonb)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      updated_at = now();

-- Re-align departments to the live entity/COGS mapping. The base migration
-- seeded a generic list (Operations/Sales/Marketing/...); the actual Brix
-- payroll/COGS taxonomy is delivery/service/reman/ops + freeflow + melt.
UPDATE ops.expense_settings
   SET value = $$["delivery","service","reman","ops","freeflow","melt"]$$::jsonb,
       updated_at = now()
 WHERE key = 'departments';


-- ── 3. Sanity check ────────────────────────────────────────────────────────
-- After this migration the canonical key list in ops.expense_settings is:
--   auto_approve_threshold  (number, seeded by base)
--   approval_email          (string, seeded by base)
--   departments             (string[], re-seeded above)
--   cogs_accounts           (object[], seeded above)
--   manager_emails          (string[], seeded above)
--   tags                    (string[], seeded above)
-- The frontend hook useExpenseSettings() loads all rows and parses by key.
