# PACER Ops Dashboard - Quick Reference

## Live Dashboard
- **URL**: `/ops/` on your APBG-billing Netlify site
- **Stack**: React 18 + Tailwind (single HTML, no build step)
- **Data**: Direct Supabase REST API (ops schema)

## Supabase Project
- **ID**: `gfsdpwiqzshhexkofiif` (APBG-BILLING)
- **Schema**: `ops` (31 tables total)
- **URL**: `https://gfsdpwiqzshhexkofiif.supabase.co`

## What's Running Autonomously
- QBO invoices + P&L syncing nightly (sync-qbo edge function, v29)
- QBO employees cache syncing (sync-qbo-employees, v1)
- SF jobs syncing every 30 min with tech names (sync-sf, v18)
- Stale invoice alerts emailing daily at 7am Pacific
- QBO line items backfilling (temporary)

## Edge Functions (8 active)
| Function | Purpose | Schedule |
|---|---|---|
| sync-qbo | QBO invoices + P&L to Supabase | Nightly 2am PT |
| sync-qbo-employees | QBO payroll employee cache | On demand |
| sync-sf | Service Fusion jobs to Supabase | Every 30 min |
| sf-oauth-callback | SF token rotation | On callback |
| stale-invoice-alert | Email if SF job has no QBO match >5d | Daily 7am PT |
| sf-tech-probe | Backfill tech names on SF jobs | On demand |
| melt-requests-forward | Melt equipment portal | On request |
| send-melt-welcome | Melt onboarding email | On trigger |

## Schema: ops.* (31 tables)

### Core Operations
- `team_members` (13) - Legacy roster with COGS mapping
- `staff` (20) - New roster linked to QBO Payroll
- `staff_roles` (12) - Role assignments (many-to-many)
- `role_types` (11) - Reference: driver, tech, reman, etc.
- `cogs_accounts` (4) - Department to QBO COGS mapping

### Financial (QBO)
- `qbo_invoices` (11,843) - All invoices synced from QBO
- `qbo_invoice_lines` (46,855) - Line-level detail
- `pl_snapshots` (1,130) - P&L by period/account
- `qbo_expenses` (0) - **PENDING: needs sync-qbo update**
- `qbo_employees_cache` (20) - QBO Payroll mirror
- `qbo_token_cache` (1) - OAuth state

### Service Operations (SF)
- `delivery_stops` (297) - Route delivery stops
- `service_jobs` (179) - Service work orders
- `reman_jobs` (5) - Remanufacturing jobs
- `sf_token_cache` (1) - SF OAuth state

### Fleet / AT&T FleetComplete (NEW - empty, pending API token)
- `fleet_vehicles` - Vehicle registry with assigned drivers
- `fleet_fuel_transactions` - Fuel purchases by vehicle/driver
- `fleet_trips` - GPS trip history with driving behavior
- `fleet_maintenance` - Service records with cost tracking
- `fc_token_cache` - FleetComplete API token

### HR / Bambee (NEW - empty, pending integration)
- `hr_employees` - Full employee records linked to staff
- `hr_time_off` - PTO requests and approvals
- `hr_documents` - Compliance docs (I-9, W-4, handbook, etc.)
- `hr_performance` - Reviews and disciplinary records
- `hr_onboarding` - Onboarding checklists

### Analytics
- `kpi_daily` (0) - **PENDING: needs rollup function**
- `kpi_embeddings` (0) - RAG layer (future)
- `crm_deals` (0) - Zoho CRM (Phase 4)
- `fleet_daily` (0) - Legacy fleet summary (replaced by fleet_trips)
- `sync_log` (550) - Audit trail for all syncs

## Remaining Build Items for Claude Code
1. Wire FleetComplete API sync edge function
2. Add qbo_expenses to sync-qbo edge function
3. Build KPI rollup pg_cron function
4. Upgrade dashboard from single HTML to Next.js app
5. Add roster CRUD (add/edit/deactivate staff)
6. Add HR data entry forms or BambooHR API sync
7. Implement auth (Supabase Auth or simple password)
