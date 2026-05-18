# PACER Ops Dashboard — Claude Code Handoff

> **Generated**: April 27, 2026
> **Owner**: Sky Pace (skypace@brixbev.com), CEO, PACER Group
> **Repo**: github.com/skypace/apbg-billing
> **Deploy**: Netlify (auto-deploys from main branch, publish dir: `public/`)

---

## 1. WHAT EXISTS RIGHT NOW

### Supabase (Postgres)
- **Project ID**: `gfsdpwiqzshhexkofiif`
- **URL**: `https://gfsdpwiqzshhexkofiif.supabase.co`
- **Anon Key**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY`
- **Schema**: `ops` (exposed to PostgREST API via `Accept-Profile: ops` header)
- **Region**: us-east-2, Postgres 17

### Edge Functions (8 active, all on Supabase)
| Slug | Purpose | Schedule | Status |
|---|---|---|---|
| `sync-qbo` (v29) | QBO invoices + invoice lines + P&L snapshots to ops tables | Nightly 2am PT via pg_cron | WORKING |
| `sync-qbo-employees` (v1) | QBO Payroll employee list to `ops.qbo_employees_cache` | On demand | WORKING |
| `sync-sf` (v18) | Service Fusion jobs to delivery_stops / service_jobs / reman_jobs | Every 30 min via pg_cron | WORKING |
| `sf-oauth-callback` | Handles SF OAuth2 token exchange | On callback | WORKING |
| `stale-invoice-alert` | Emails if SF job has $$ but no QBO invoice after 5 days | Daily 7am PT via pg_cron | WORKING |
| `sf-tech-probe` | Backfills tech_name on SF jobs missing it | On demand | WORKING |
| `melt-requests-forward` | Melt equipment portal forwarding | On request | WORKING |
| `send-melt-welcome` | Melt customer onboarding email | On trigger | WORKING |

### Netlify Functions (existing billing system, DO NOT TOUCH)
The `netlify/functions/` directory contains Whitney's vendor bill processing system. These are production functions used daily. Do not modify them.

### Existing Frontend (DO NOT TOUCH)
`public/` contains the billing portal pages: `index.html`, `approve.html`, `customer-approve.html`, `control.html`, `sync.html`, `setup.html`. These are used by the operations team daily.

### Placeholder Dashboard
`public/ops/index.html` is a single-file React+Babel prototype. It connects to Supabase and renders live data. **Replace this** with a proper Next.js or Vite app.

---

## 2. DATABASE SCHEMA (ops.*)

### 2A. Roster and Team

**`ops.staff`** (20 rows) — Primary employee table
```
staff_id        uuid PK (gen_random_uuid)
qbo_employee_id text UNIQUE (FK -> qbo_employees_cache)
display_name    text NOT NULL
email           text
phone           text
status          text ['active','inactive','terminated','on_leave']
department      text ['delivery','service','reman','ops','admin','sales']
entity          text ['brix','freeflow','shared']
annual_wage     numeric
split_pct       numeric (0-100, for 50/50 people like Marco/Joel)
is_lead         boolean
is_contractor   boolean
cost_center     text
home_branch     text
notes           text
created_at      timestamptz
updated_at      timestamptz
```

**`ops.role_types`** (11 rows) — Reference table
```
role_code       text PK (driver_cdl_a, driver_cdl_b, driver_helper, tech_refrig, tech_electric, tech_general, reman_lead, reman_tech, dispatcher, supervisor, sales_rep)
label           text
description     text
business_unit   text ['delivery','service','reman','fleet','admin','sales']
sort_order      integer
```

**`ops.staff_roles`** (12 rows) — Many-to-many, dated
```
staff_id        uuid (FK -> staff)
role_code       text (FK -> role_types)
is_primary      boolean
effective_from  date
effective_to    date (null = current)
cert_number     text
cert_expires_on date
notes           text
PK: (staff_id, role_code, effective_from)
```

**`ops.cogs_accounts`** (4 rows) — Department to QBO COGS mapping
```
department       text PK
qbo_account_id   text
qbo_account_name text
pl_line_label    text
```
Values: delivery -> 1150040011 (B2B Direct Labor), service -> 1150040012 (Service Direct Labor), reman -> 1150040013 (Reman Direct Labor), ops -> 1150040007 (Direct Labor)

**`ops.team_members`** (13 rows) — LEGACY roster. FKs from delivery_stops, service_jobs, reman_jobs, fleet_daily, kpi_daily all point here. Keep synced with `ops.staff` or migrate FKs.

**`ops.qbo_employees_cache`** (20 rows) — Read-only mirror of QBO Payroll
```
qbo_employee_id  text PK
display_name     text
given_name       text
family_name      text
email            text
active           boolean
hire_date        date
hourly_rate      numeric
raw              jsonb (full QBO employee record)
qbo_synced_at    timestamptz
```

### 2B. Financial (QBO)

**`ops.qbo_invoices`** (11,843 rows) — All invoices
```
id               bigint PK
qbo_invoice_id   text UNIQUE
doc_number       text
txn_date         date
due_date         date
customer_ref_id  text
customer_name    text
public_customer_id bigint (FK -> public.customers)
total_amount     numeric
balance          numeric
status           text
department       text
entity           text ['AS','FF']
memo             text
synced_at        timestamptz
qbo_updated_at   timestamptz
```

**`ops.qbo_invoice_lines`** (46,855 rows) — Line-level detail
```
id               bigint PK
invoice_id       bigint (FK -> qbo_invoices)
line_num         integer
description      text
quantity         numeric
unit_price       numeric
amount           numeric
item_ref_id      text
item_name        text
account_ref_id   text
account_name     text
revenue_line     text (categorization)
department       text
```

**`ops.pl_snapshots`** (1,130 rows) — P&L by period/account
```
id               bigint PK
period           text (e.g. '2025-01', '2025-02')
account_id       text
account_name     text
account_type     text (Income, Cost of Goods Sold, Expense)
amount           numeric
entity           text ['AS','FF','combined']
snapshot_at      timestamptz
```

**`ops.qbo_expenses`** (0 rows) — EMPTY, NEEDS SYNC
```
id               bigint PK
qbo_txn_id       text
qbo_txn_type     text
txn_date         date
account_ref_id   text
account_name     text
amount           numeric
vendor_name      text
employee_name    text
memo             text
department       text
entity           text ['AS','FF']
expense_category text
synced_at        timestamptz
```
**ACTION NEEDED**: Update sync-qbo edge function to also pull Purchase and Bill entities from QBO and upsert into this table.

### 2C. Service Operations (from Service Fusion)

**`ops.delivery_stops`** (297 rows)
```
id, sf_job_id (unique), sf_job_number, stop_date, driver_id (FK team_members), driver_name,
customer_ref_id, customer_name, address, arrival_time, departure_time, duration_min,
status, invoice_amount, qbo_invoice_id, notes, synced_at, sf_total, payment_status,
qbo_invoice_matched (bool), stale_alert_sent (bool), sf_status, sf_qb_invoice_number
```

**`ops.service_jobs`** (179 rows) — same structure as delivery_stops with: job_date, tech_id/tech_name, job_type, dispatch_time, arrival_time, completion_time, billable_hours, parts_cost, labor_cost, is_callback, first_time_fix

**`ops.reman_jobs`** (5 rows) — intake_date, completion_date, tech_id/tech_name, equipment_type, serial_number, status ['intake','in_progress','qc','complete','shipped','scrapped'], parts_cost, labor_hours, labor_cost, sale_price

### 2D. Fleet / AT&T FleetComplete (ALL EMPTY - NEW)

**Integration Status**: Schema deployed. API token NOT yet obtained.
**API**: Powerfleet (formerly FleetComplete) REST API
- Docs: https://tlshosted.fleetcomplete.com/Integration/v8_5_0/Help
- Auth: Token-based (free for customers)
- Contact: support@powerfleet.com
- AT&T product page: business.att.com/products/fleet-complete.html

**`ops.fleet_vehicles`** — Vehicle registry
```
id, fc_asset_id (unique), vehicle_name, vin, license_plate, make, model, year, odometer,
status ['active','inactive','maintenance','retired'],
assigned_driver_id (FK team_members), fuel_type, tank_capacity_gal, avg_mpg,
insurance_monthly, lease_monthly, notes, synced_at
```

**`ops.fleet_fuel_transactions`** — Fuel card data
```
id, vehicle_id (FK fleet_vehicles), driver_id (FK team_members),
txn_date, gallons, price_per_gal, total_cost, odometer_at,
station_name, station_address, fuel_type, receipt_ref, synced_at
```

**`ops.fleet_trips`** — GPS trip data
```
id, fc_trip_id (unique), vehicle_id (FK), driver_id (FK),
trip_date, start_time, end_time, start_address, end_address,
distance_miles, drive_time_min, idle_time_min, max_speed_mph, avg_speed_mph,
hard_brakes, hard_accels, speed_violations, synced_at
```

**`ops.fleet_maintenance`** — Service records
```
id, vehicle_id (FK), service_date, service_type ['oil_change','tires','brakes','transmission','inspection','bodywork','electrical','other'],
description, vendor_name, cost, odometer_at, next_due_date, next_due_miles, qbo_expense_id, notes
```

**`ops.fc_token_cache`** — Single-row API token storage (id=1)

**ACTION NEEDED**: 
1. Sky gets API token from Powerfleet portal
2. Build `sync-fleetcomplete` Supabase edge function
3. Schedule via pg_cron (every 30 min or hourly)

### 2E. HR / Bambee (ALL EMPTY - NEW)

**Integration Options**:
- **Bambee** (bambee.com) — Outsourced HR manager service, $99/mo. NO public API. Data entry is manual or CSV import.
- **BambooHR** (bamboohr.com) — Full HRIS with REST API v1. Docs: https://documentation.bamboohr.com/reference. Auth: API key or OAuth2. Webhooks supported for employee change events.

**`ops.hr_employees`**
```
id, staff_id (FK staff), bambee_employee_id, bamboohr_id,
first_name, last_name, email, phone,
address_line1, address_city, address_state, address_zip, ssn_last4,
date_of_birth, hire_date, termination_date,
employment_status ['active','terminated','on_leave','suspended'],
employment_type ['full_time','part_time','contractor','seasonal'],
pay_type ['salary','hourly'], pay_rate, pay_frequency, exempt_status,
supervisor_id (self-FK), emergency_contact_name, emergency_contact_phone,
notes, synced_at, created_at, updated_at
```

**`ops.hr_time_off`** — PTO tracking
```
id, employee_id (FK), request_date, start_date, end_date, hours,
type ['vacation','sick','personal','bereavement','jury_duty','fmla','unpaid','other'],
status ['pending','approved','denied','cancelled'], approved_by, notes
```

**`ops.hr_documents`** — Compliance docs
```
id, employee_id (FK), doc_type ['i9','w4','handbook_ack','policy_ack','offer_letter','termination','warning','performance_review','certification','training','other'],
title, file_url, signed_at, expires_at, status ['pending','signed','expired','na'], notes
```

**`ops.hr_performance`** — Reviews and disciplinary
```
id, employee_id (FK), review_date, reviewer_name,
type ['annual_review','90_day','verbal_warning','written_warning','pip','commendation','coaching','termination'],
rating (1-5), summary, action_items, next_review_date
```

**`ops.hr_onboarding`** — Checklist items
```
id, employee_id (FK), task_name,
category ['paperwork','equipment','training','access','orientation','other'],
due_date, completed_at, assigned_to, notes
```

### 2F. Analytics

**`ops.kpi_daily`** (0 rows) — EMPTY, NEEDS ROLLUP FUNCTION
```
id, kpi_date, team_member_id (FK), member_name, department, entity,
-- Delivery
stops_completed, delivery_revenue, delivery_cost, cost_per_stop, revenue_per_stop, margin_per_stop, miles_driven, revenue_per_mile,
-- Service
jobs_completed, service_revenue, service_cost, cost_per_job, revenue_per_job, billable_hours, total_hours, utilization_pct, first_fix_pct, avg_response_min,
-- Reman
units_completed, reman_revenue, reman_cost, labor_per_unit, parts_per_unit, margin_per_unit, turnaround_days,
computed_at
```
**ACTION NEEDED**: Write a Postgres function + pg_cron job that aggregates delivery_stops, service_jobs, reman_jobs, and team_members into daily KPI rows.

**`ops.kpi_embeddings`** (0 rows) — pgvector RAG layer (future)
**`ops.crm_deals`** (0 rows) — Zoho CRM sync (Phase 4)
**`ops.fleet_daily`** (0 rows) — Legacy summary (superceded by fleet_trips)

### 2G. Infrastructure

**`ops.sync_log`** (550 rows) — Audit trail
```
id, source ['qbo','sf','fleet','zoho_crm','bambee','fleetcomplete'],
sync_type, started_at, completed_at, status ['running','success','error'],
records_synced, error_message, metadata (jsonb)
```

**`ops.qbo_token_cache`** (1 row) — QBO OAuth state, realm_id as PK. Has mutex locking via `refresh_lease_until`.

**`ops.sf_token_cache`** (1 row) — SF OAuth state.

---

## 3. CONFIRMED PAYROLL AND ENTITY SPLIT

This is the source of truth. Staff records in ops.staff should match these numbers.

### Payroll by Entity
| Name | Annual Wage | Entity | Department | COGS Account |
|---|---|---|---|---|
| Joaquin Onate | $46,000 | Brix (AS) | delivery | 1150040011 |
| Kyle McGee | $43,000 | Brix (AS) | delivery | 1150040011 |
| Eric VanRenselaar | $55,000 | FreeFlow (FF) | service | 1150040012 |
| Rene Benavides | $52,000 | FreeFlow (FF) | service | 1150040012 |
| Anthony VanRenselaar | $72,000 | FreeFlow (FF) | service | 1150040012 |
| Robert Nadell | $47,000 | FreeFlow (FF) | reman | 1150040013 |
| Jermaene Feliciano | $44,000 | FreeFlow (FF) | reman | 1150040013 |
| Alejandro Andrade | $37,000 | FreeFlow (FF) | reman | 1150040013 |
| Marco Di Luca | $105,000 | Shared (50/50) | admin | — |
| Joel Sanchez | $75,000 | Shared (50/50) | admin | — |
| Sky Pace | $132,000 | Shared (officer) | admin | — |
| Anthony Sloan | $112,000 | Shared (officer) | admin | — |

**FreeFlow total wages**: $395K. **Alameda Soda total wages**: $422K.
Payroll tax follows wages: 69% FF / 31% AS.
Sloan $112K eliminated mid-2027, replaced by Sam Katz + Dani Weinstock at $60K each at AS.

---

## 4. WHAT TO BUILD

### 4A. App Architecture
- **Framework**: Next.js 14+ (App Router) or Vite + React
- **Styling**: Tailwind CSS
- **Data**: Supabase JS client v2, schema `ops`
- **Auth**: Supabase Auth (email/password for now, Sky + Sam + Dani as initial users)
- **Deploy**: Netlify (same site as current billing portal, or separate Netlify site if cleaner)
- **Design**: Dark theme, industrial/ops aesthetic. Think mission control, not SaaS marketing.

### 4B. Pages / Views

1. **Executive Dashboard** (CEO view)
   - Revenue summary (P&L from pl_snapshots)
   - AR aging buckets (from qbo_invoices where balance > 0)
   - Top customers by revenue and AR
   - Labor cost as % of revenue
   - Revenue per employee
   - EBITDA approximation
   - Entity split view (Brix vs FreeFlow)

2. **Delivery Operations**
   - Stops per day per driver (from delivery_stops)
   - Cost per stop (driver daily wage / stops)
   - Revenue per stop
   - Margin per stop
   - Dead runs (stops with $0 invoiced)
   - Stale invoices (sf_total > 0, qbo_invoice_matched = false)

3. **Service Operations**
   - Jobs per tech per day
   - Revenue per job, cost per job
   - First-time fix rate
   - Stale invoices
   - PM vs break/fix breakdown
   - Billable utilization %

4. **Remanufacturing**
   - WIP count and backlog
   - Units completed per month
   - Turnaround days
   - Margin per unit
   - Tech productivity

5. **Fleet Management** (placeholder until FleetComplete wired)
   - Vehicle registry (CRUD on fleet_vehicles)
   - Fuel transaction log
   - Trip history with driving behavior scores
   - Maintenance tracker with next-service alerts
   - Cost per mile dashboard
   - MPG tracking

6. **HR** (placeholder until Bambee/BambooHR wired)
   - Employee directory with full profile
   - Time-off request/approval workflow
   - Document compliance tracker (I-9, W-4, handbook acks)
   - Performance review history
   - Onboarding checklist per new hire
   - Certificate expiry alerts

7. **Roster Management** (full CRUD)
   - Add / edit / deactivate staff
   - Assign roles (from role_types)
   - Set department, entity, wage, COGS account
   - View job history per person (join to delivery_stops/service_jobs/reman_jobs)
   - Cost allocation per person per period

8. **Settings**
   - Sync status (last sync times from sync_log)
   - API connection health
   - User management

### 4C. KPI Spec
See `PACER-KPI-SPEC.md` in this repo for the full 108-metric specification across 5 departments + 7 automated alerts + roster CRUD.

---

## 5. KNOWN GAPS TO FIX

| Priority | Gap | What to Do |
|---|---|---|
| P0 | `qbo_expenses` is empty | Update sync-qbo edge function to also query QBO Purchase and Bill entities; upsert into ops.qbo_expenses |
| P0 | `kpi_daily` has no rollup | Write a Postgres function that aggregates daily KPIs from delivery_stops + service_jobs + reman_jobs + team_members; schedule via pg_cron nightly |
| P1 | No auth on dashboard | Add Supabase Auth; create initial users for Sky, Sam, Dani |
| P1 | FleetComplete not wired | Sky needs to get API token first, then build sync-fleetcomplete edge function |
| P2 | HR data empty | Decide Bambee vs BambooHR; if BambooHR, build sync; if Bambee, build manual entry forms |
| P2 | team_members vs staff dual tables | Migrate FKs from delivery_stops/service_jobs/reman_jobs to point at staff.staff_id instead of team_members.id |
| P3 | No Zoho CRM sync | Phase 4, deprioritized |
| P3 | No RAG / kpi_embeddings | Phase 5, after core dashboard is solid |

---

## 6. ENVIRONMENT AND SECRETS

### Supabase Edge Functions need these env vars (already set):
- `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` — Intuit Developer app credentials
- `QBO_REALM_ID` = `9130352144155116`
- `SF_CLIENT_ID`, `SF_CLIENT_SECRET` — Service Fusion OAuth app
- `RESEND_API_KEY` — For transactional email (alerts)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — For edge functions to write to DB

### FleetComplete (to be added):
- `FC_API_TOKEN` — From Powerfleet portal
- `FC_ACCOUNT_ID` — Your FleetComplete account

### BambooHR (if chosen):
- `BAMBOOHR_API_KEY` — From BambooHR admin settings
- `BAMBOOHR_SUBDOMAIN` — Your company subdomain

---

## 7. CROSS-REPO CONTEXT

This repo (`apbg-billing`) is part of a multi-repo system. See `CLAUDE.md` in repo root for the architecture handbook pointer at `activespacescience/Skilliosis_Mytosis_Architecture`.

### Related repos (all under github.com/skypace):
- **pacerfinance** — MCP servers (QBO Connector, Zoho) at pacerfinance.netlify.app
- **Pacer-outlook** — Outlook MCP at pacer-outlook.netlify.app

### Related Supabase project:
- **gfsdpwiqzshhexkofiif** (this project, APBG-BILLING) — `public` schema has equipment portal tables (customers, jobs, store_schedule, store_orders, contract_items, knowledge_chunks with pgvector). The `ops` schema is the dashboard data.

---

## 8. QUICK START FOR CLAUDE CODE

```bash
# Clone the repo
git clone https://github.com/skypace/apbg-billing.git
cd apbg-billing

# The current site is static HTML served from public/
# To build the new dashboard app:
# Option A: Create a new Next.js app in a subdirectory (e.g. dashboard/)
# Option B: Create a Vite app that builds to public/ops/

# Connect to Supabase
# npm install @supabase/supabase-js
# Use the anon key above with { db: { schema: 'ops' } }

# Read the KPI spec
cat PACER-KPI-SPEC.md

# Check current data
# Use Supabase dashboard at: https://supabase.com/dashboard/project/gfsdpwiqzshhexkofiif
```

---

*This document is the single source of truth for building the PACER Ops Dashboard. If something contradicts this doc, this doc wins.*
