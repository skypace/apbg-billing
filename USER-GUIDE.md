# APBG Systems — Complete User Guide

## Overview

This guide covers two connected systems that power billing, work order management, and financial operations across Brix, Freeflow, and The Melt:

1. **APBG Billing** (`pacer-billing.netlify.app`) — Vendor bill processing, ResQ↔SF sync, expense-to-bill conversion
2. **Melt Dashboard** (`melt-dashboard.netlify.app`) — Financial overview, store tracking, equipment inventory, invoice management

Both systems connect to **QuickBooks Online**, **ResQ**, **Service Fusion**, and **Google Sheets** — each with independent OAuth credentials.

---

## Table of Contents

1. [APBG Billing System](#1-apbg-billing-system)
   - [Bill Upload & Processing](#11-bill-upload--processing)
   - [Bill Approval](#12-bill-approval)
   - [ResQ↔SF Sync Dashboard](#13-resqsf-sync-dashboard)
   - [Photo Upload](#14-photo-upload-to-resq)
   - [Expense Receipt → QBO Bill](#15-expense-receipt--qbo-bill)
   - [Customer Onboarding](#16-customer-onboarding)
   - [Setup & Connections](#17-setup--connections)
2. [Melt Dashboard](#2-melt-dashboard)
   - [Dashboard Home](#21-dashboard-home)
   - [Stores](#22-stores)
   - [Payments & Statements](#23-payments--statements)
   - [Work Orders](#24-work-orders)
   - [Inventory & Rent](#25-inventory--rent)
   - [Files](#26-files)
   - [Settings](#27-settings)
   - [QBO Connection](#28-qbo-connection)
3. [How the Systems Connect](#3-how-the-systems-connect)
4. [Automated Processes](#4-automated-processes)
5. [Account & Category Mapping](#5-account--category-mapping)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. APBG Billing System

**URL:** https://pacer-billing.netlify.app

### 1.1 Bill Upload & Processing

**What it does:** Takes a vendor bill (PDF or image), scans it with AI, extracts all the data, and routes it for approval.

**How to use:**

1. Go to the billing homepage
2. Drag and drop a PDF or image of a vendor bill onto the upload zone (or click to browse)
3. The system sends the file to Claude AI, which reads and extracts:
   - Vendor name
   - Bill/invoice number
   - Date and due date
   - Every line item (description, quantity, unit cost)
   - Category per line item (equipment or service)
   - Total, subtotal, tax
   - Any job numbers, PO numbers, or work order references
4. You're redirected to the approval page with everything pre-filled

**Email intake:** Bills can also arrive via email. When a vendor emails a bill to the configured address, SendGrid forwards it to the system automatically. An approval email is sent to the finance team with a secure review link.

---

### 1.2 Bill Approval

**URL:** https://pacer-billing.netlify.app/approve.html

**What it does:** Review AI-scanned bill data, select vendor/location/account, and create the bill in QuickBooks.

**How to use:**

1. The form loads pre-filled with scanned data
2. Review and adjust if needed:
   - **Vendor** — Searchable dropdown of all QBO vendors. If the vendor doesn't exist, click "Create New Vendor" to add one on the fly
   - **Account** — Select the COGS account:
     - **Service COGS** (account 101) — for labor, service calls, repairs, consulting
     - **Equipment Sales COGS** (account 42) — for parts, materials, equipment, supplies
   - **Location/Customer** — Searchable dropdown (The Melt locations, Starbird, etc.)
   - **Job Number** (required) — The Service Fusion or ResQ job/work order number. This is how the system matches the bill to an existing invoice
   - **Line Items** — Add, remove, or edit. Qty x Unit Cost auto-calculates
3. Click **Approve & Create Bill**
4. The system:
   - Creates the bill in QuickBooks
   - Searches the last 6 months of invoices for a match on the job number
   - If matched: shows the margin (invoice revenue minus bill cost)
   - Sends a confirmation email with all details

---

### 1.3 ResQ↔SF Sync Dashboard

**URL:** https://pacer-billing.netlify.app/sync.html
**Access code:** `pacer2026`

**What it does:** Manages the bidirectional sync between ResQ (maintenance platform) and Service Fusion (field service).

**Dashboard shows:**
- **Status cards** — ResQ connection, SF connection, active work order count, last sync time
- **Work order table** — Every mapped WO with ResQ code, title, facility, SF job number, statuses, and action buttons
- **Sync log** — Detailed log of the last sync run (steps, errors, counts)

**Work order lifecycle:**

| ResQ Status | SF Status | What Happens |
|---|---|---|
| NOT_YET_SCHEDULED | Unscheduled | SF job created automatically |
| SCHEDULED | Scheduled-Service | Status synced both ways |
| NOT_YET_COMPLETED | (in progress) | Waiting for completion |
| COMPLETED / NEEDS_INVOICE | Completed-Service | Visit completed in ResQ, photos flagged for upload |
| AWAITING_PAYMENT | Invoiced | Invoice submitted to ResQ (5-mutation flow) |
| CLOSED | Invoiced | Done — hidden from dashboard |

**Actions:**
- **Run Sync Now** — Triggers an immediate sync (runs in background, polls for results)
- **Refresh Status** — Reloads dashboard data without running a sync

**Automatic sync:** Runs every 5 minutes via cron job.

**Completed WOs** (CLOSED, AWAITING_PAYMENT, WAITING_FOR_COORDINATOR_APPROVAL) are automatically hidden from the table. The stat card shows "X active of Y total."

---

### 1.4 Photo Upload to ResQ

**Where:** Sync dashboard → 📸 Upload button on any WO row

**Why manual:** Service Fusion's file storage uses private S3 URLs that can't be downloaded programmatically. Photos must be uploaded manually.

**How to use:**

1. Click **📸 Upload** on the WO row
2. Modal opens — drag and drop photos (or click to browse)
3. Multiple files supported (images, PDFs, docs)
4. Review the file list (shows name + size, click ✕ to remove)
5. Click **Upload to ResQ**
6. Files are converted to base64 and uploaded to the ResQ work order as attachments
7. Success count shown — modal auto-closes after 2 seconds

---

### 1.5 Expense Receipt → QBO Bill

**Where:** Sync dashboard → 💰 Bill button on any WO row

**What it does:** Takes a receipt/invoice from a Service Fusion job expense and creates a QBO bill.

**How to use:**

1. Click **💰 Bill** on the WO row
2. Modal opens showing:
   - SF job number and ResQ code
   - Existing expenses on that SF job (amount, category, date)
3. Drop a receipt file (PDF or image) in the upload zone
4. Click **🔍 Scan & Create Bill**
5. Claude AI scans the receipt and extracts:
   - Vendor name, bill number, date
   - Line items with descriptions, quantities, unit costs
   - Category per item (equipment or service)
6. System auto-matches the vendor in QBO:
   - **If matched:** Bill created immediately with the right COGS accounts
   - **If not matched:** Shows extracted data and a text field to enter the correct QBO vendor name. Click **Create Bill** to retry with the corrected name
7. Bill is created in QBO with:
   - Equipment items → Equipment Sales COGS (account 42)
   - Service items → Service COGS (account 101)
   - Memo includes ResQ code + SF job number

---

### 1.6 Customer Onboarding

**URL:** https://pacer-billing.netlify.app/customer-approve.html

**What it does:** Creates a new customer in both QuickBooks and Service Fusion.

**Fields:**
- Business name, legal name, contact info (name, phone, email)
- Address (street, city, state, ZIP)
- Tax ID, CA Resale Certificate
- Payment terms (COD, Net 15, Net 30, Net 60, Credit Card)
- Notes

**On submit:** Customer created in QBO with proper sales terms, then in SF. Confirmation emails sent to the onboarding team.

---

### 1.7 Setup & Connections

**URL:** https://pacer-billing.netlify.app/setup.html

**Two connections:**
- **Connect to QuickBooks** — OAuth flow to authorize QBO access. Token auto-refreshes.
- **Connect to Service Fusion** — OAuth flow to authorize SF access. Token auto-refreshes with 3-tier caching (memory → blob → env var).

**When to re-connect:** If you see token errors ("invalid_grant", "Token refresh failed"), go to setup.html and reconnect. This gets a fresh token.

---

## 2. Melt Dashboard

**URL:** https://melt-dashboard.netlify.app
**Login codes:** `brix2026` (admin) or `melt2026` (viewer)

### 2.1 Dashboard Home

**Shows at a glance:**
- **KPI cards:** Total Paid, Total Invoiced, Total Balance, Total Credits
- **Invoice status breakdown:** Paid vs. Partial vs. Open counts
- **Store project cards:** Color-coded by status (Planned, In Progress, Completed)
- **Gantt chart:** Timeline of active projects with today indicator
- **Recent invoices/payments tabs**
- **Open work orders** from ResQ
- **Quick action buttons:** Generate Statement, Upload Files, Payment Plan, Equipment Hub
- **Last refresh timestamp** — data refreshes automatically every hour

---

### 2.2 Stores

**What it shows:** Grid of all Melt store locations from the Google Sheet schedule.

**Each store card:** Name, status badge (color-coded), progress percentage.

**Click a store** to see:
- Financial summary (equipment costs, service costs, paid vs. owed)
- Invoice status breakdown
- Three file tabs: Trackers (HTML status files), Drawings (CAD), Photos
- Invoice line items categorized as Equipment or Service
- Tracker data with extracted badges and status info

**General Equipment section:** Aggregate costs for warehouse/unassigned equipment.

---

### 2.3 Payments & Statements

**What it shows:** Complete payment ledger with all transactions in chronological order.

- All invoices (date, number, amount, balance, location)
- All payments received (date, amount, method)
- All credit memos
- Running balance projection

**Exhibit A Statement:**
- Click **Generate Statement** to create a professional formatted statement
- Includes: itemized invoices by store, payment history, credits, final balance
- Ready to print or share

---

### 2.4 Work Orders

**What it shows:** All Brix Beverage work orders from ResQ.

**Table columns:** Code, Title, Status, Service Category, Dates, Spend, Flags

**Flags detected:**
- **Urgent** (red) — urgent priority
- **Callback** — callback work order
- **On Hold** (orange) — paused
- **PM** (blue) — preventative maintenance (detected by maintenance plan, "PM" in title, or "preventive" keyword)

---

### 2.5 Inventory & Rent

**Two tabs:**

**Melt Installed Equipment:**
- Equipment list with warranty status (green = covered, orange = expiring, red = expired)
- Editable rent rate per item (default: $25 Brix items, $5 stainless)
- Monthly rent calculation
- **Create Monthly Invoice** button — generates QBO invoice for THE MELT MAIN with all rent line items

**Brix Warehouse:**
- Warehouse equipment inventory
- Sync to Google Sheets button

---

### 2.6 Files

**File browser** for uploaded documents organized by folder:
- store-trackers (HTML status files)
- equipment-specs (PDFs)
- drawings (CAD files)
- photos (installation/site photos)

**Features:**
- Upload via drag-and-drop with store name and folder selection
- Download any file
- Delete files
- Search/filter by name
- Thumbnail previews for images

---

### 2.7 Settings

**Access:** Admin login required (code in settings gate: `pacer2026`)

- **Monthly Equipment Rent Invoice** — Same rent editor, create QBO invoice
- **Email Recipients** — Team contact list (Sky, Whitney, Scott, Larry, Sloan, Accounting)
- **QBO Connection** — Re-authenticate QuickBooks button

---

### 2.8 QBO Connection

**Setup:** https://melt-dashboard.netlify.app/setup.html

**How it works:**
- Click Connect to QuickBooks → Intuit OAuth screen → authorize → token saved
- Access tokens cached for 50 minutes in blob storage
- Refresh tokens stored in Netlify env vars (survives deploys)
- Hourly cache refresh keeps data fresh without hitting QBO on every page load

**If invoice PDFs stop working:** The refresh token may have expired. Go to setup.html and reconnect.

---

## 3. How the Systems Connect

```
                    ┌──────────────┐
                    │  QuickBooks  │
                    │   Online     │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
     ┌────────▼───┐  ┌────▼─────┐  ┌──▼──────────┐
     │ APBG       │  │ Melt     │  │ Pacer       │
     │ Billing    │  │ Dashboard│  │ Finance     │
     └────┬───────┘  └──────────┘  └─────────────┘
          │
     ┌────┼────┐
     │         │
┌────▼───┐ ┌──▼────────────┐
│  ResQ  │ │ Service       │
│        │◄┤ Fusion        │
└────────┘ └───────────────┘
```

**Each site has its own independent QBO connection** (separate OAuth app, client ID, and realm). They do NOT share tokens.

**ResQ↔SF sync** runs only on APBG Billing (every 5 minutes).

**Data flow for a typical work order:**
1. Work order created in ResQ
2. Sync creates matching SF job (every 5 min)
3. Tech completes work in SF → sync marks visit complete in ResQ
4. Tech uploads photos → manual upload via sync.html to ResQ
5. SF job invoiced → sync submits vendor invoice to ResQ
6. Receipt added → scan via sync.html → QBO bill created

---

## 4. Automated Processes

| Process | Frequency | System | What it does |
|---|---|---|---|
| ResQ↔SF Sync | Every 5 minutes | APBG Billing | Syncs work orders, statuses, invoices |
| Melt Cache Refresh | Hourly | Melt Dashboard | Refreshes QBO data, ResQ data, Google Sheets |
| QBO Token Refresh | On demand (50-min cache) | Both | Auto-refreshes access tokens when expired |
| SF Token Refresh | On demand (3-tier cache) | APBG Billing | Memory → blob → env var fallback chain |
| Bill Email Intake | On email receipt | APBG Billing | Scans bill, sends approval link |

---

## 5. Account & Category Mapping

### COGS Accounts (Bill Creation)

| Category | QBO Account | Account ID | Used For |
|---|---|---|---|
| Service | Service COGS | 101 | Labor, repairs, installation, consulting, delivery, freight |
| Equipment | Equipment Sales COGS | 42 | Parts, materials, equipment, supplies, physical goods |

### Invoice Items (Invoice Creation)

| Item | Item ID | Account |
|---|---|---|
| Sales | 388 | Equipment Sales (32) |
| Service Provided | 365 | Service Income (35) |

### ResQ Line Item Types

| SF Category | ResQ Enum | Description |
|---|---|---|
| Products | ITEM_TYPE_PART | Physical parts and materials |
| Services | ITEM_TYPE_SERVICE_CHARGE | Service calls and fees |
| Labor | ITEM_TYPE_LABOUR | Hourly labor charges |
| Drive Time | ITEM_TYPE_TRAVEL | Travel/drive time |
| Expenses | ITEM_TYPE_OTHER | Miscellaneous expenses |
| Other Charges | ITEM_TYPE_OTHER | Additional charges |

---

## 6. Troubleshooting

### "invalid_grant" or "Token refresh failed"
**Cause:** OAuth refresh token expired or was invalidated (race condition, manual revoke, or another system overwrote it).
**Fix:** Go to the relevant setup page and reconnect:
- APBG Billing: `/setup.html` → Connect to QuickBooks
- Melt Dashboard: `/setup.html` → Connect to QuickBooks

### Service Fusion shows ✗ on sync dashboard
**Cause:** Only flags as disconnected for actual connection failures (token refresh errors, missing credentials). Job-level errors (like a missing customer) do NOT trigger this.
**Fix:** If truly disconnected, go to `/setup.html` → Connect to Service Fusion.

### Sync runs but WO not appearing in SF
**Cause:** The SF customer for that facility doesn't exist. Check the sync log for "422" errors mentioning customer name.
**Fix:** Create the customer manually in Service Fusion (e.g., "BRIX BEVERAGE: RESQ").

### Photos not transferring automatically
**Cause:** SF uses private S3 storage — photos can't be downloaded programmatically.
**Fix:** Use the 📸 Upload button on sync.html to manually upload photos to ResQ.

### Invoice PDF not loading on Melt Dashboard
**Cause:** QBO access token expired and refresh token is invalid.
**Fix:** Go to melt-dashboard setup page and reconnect QBO.

### Duplicate records of work in ResQ
**Cause:** Failed invoice submission retries can create empty ROW drafts.
**Fix:** Delete empty drafts from ResQ UI. The sync now reuses existing ROWs with line items.

### Bill created but "NO MATCHING INVOICE"
**Cause:** No QBO invoice found containing the job number in the last 6 months.
**Fix:** This is informational — the bill is still created. Invoice the job separately, or check if the job number on the bill matches what's on the invoice.

### Expense scan can't find vendor
**Cause:** The vendor name on the receipt doesn't match any QBO vendor.
**Fix:** Type the correct QBO vendor name in the override field and click Create Bill. If the vendor doesn't exist in QBO at all, create them first.
