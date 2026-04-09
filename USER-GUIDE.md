# APBG 3rd Party Billing -- User Guide

AI-powered vendor bill processing for Alameda Point Beverage Group. Upload a bill, let Claude AI extract the data, review and approve, and the bill is created in QuickBooks automatically.

---

## Submitting Bills

**URL:** Landing page (`index.html`)

1. Open the billing site homepage
2. Drag and drop a PDF onto the upload zone, or click to browse for a file
3. Claude AI scans the PDF and extracts:
   - Vendor name
   - Bill/invoice number and dates
   - Every line item (description, quantity, unit cost)
   - Category per line item (equipment or service)
   - Total amount, subtotal, and tax
   - Any job numbers, PO numbers, or work order references
4. You are redirected to the approval page with everything pre-filled

**Email intake:** Bills can also arrive via email. When a vendor emails a bill to the configured address, the system scans it automatically and sends an approval email to the finance team with a secure review link.

---

## Approving Bills

**URL:** `approve.html` (reached via approval email link or redirect from upload)

1. Click the review link from the approval email
2. The form loads pre-filled with AI-extracted data. Review and adjust as needed:
   - **Vendor** -- Searchable dropdown of all QBO vendors. If the vendor does not exist, click "Create New Vendor" to add one on the fly
   - **Account** -- Select the COGS account:
     - Service COGS (account 101) for labor, service calls, repairs
     - Equipment Sales COGS (account 42) for parts, materials, equipment
   - **Location/Customer** -- Searchable dropdown of Melt locations and other customers
   - **Job Number** -- The Service Fusion or ResQ job/work order number, used to match the bill to an existing invoice
   - **Line Items** -- Add, remove, or edit individual lines. Quantity times unit cost auto-calculates the amount
   - **Department** -- Assign to the appropriate QBO department
3. Click **Approve & Create Bill**
4. The system:
   - Creates the bill in QuickBooks Online
   - Searches the last 6 months of invoices for a match on the job number
   - If a match is found: displays the margin (invoice revenue minus bill cost)
   - If no match: shows a warning that no invoice is on file (the bill is still created)
   - Sends a confirmation email with all details

---

## Adding New Customers

**URL:** `customer-approve.html`

Use this form to create a new customer in QuickBooks Online.

**Fields:**
- Business name and legal name
- Contact info: name, phone, email
- Address: street, city, state, ZIP
- Payment terms: COD, Net 15, Net 30, Net 60, Credit Card
- Notes

On submit, the customer is created in QBO with the specified sales terms. A confirmation email is sent to the team.

---

## ResQ-SF Sync Dashboard

**URL:** `sync.html`

Manages the bidirectional sync between ResQ (maintenance platform) and Service Fusion (field service management).

**What you see:**
- Status cards showing ResQ connection, SF connection, active work order count, and last sync time
- Work order table with ResQ code, title, facility, SF job number, statuses, and action buttons
- Sync log with detailed step-by-step output from the last run

**Automatic sync:** Runs every 5 minutes via a scheduled cron job. No manual action needed for routine operation.

**Manual controls:**
- **Run Sync Now** -- Triggers an immediate sync cycle (runs in the background, polls for results)
- **Refresh Status** -- Reloads the dashboard data without running a full sync

**Work order lifecycle:**

| ResQ Status | SF Status | What Happens |
|---|---|---|
| NOT_YET_SCHEDULED | Unscheduled | SF job created automatically |
| SCHEDULED | Scheduled-Service | Status synced both ways |
| COMPLETED / NEEDS_INVOICE | Completed-Service | Visit marked complete, photos flagged |
| AWAITING_PAYMENT | Invoiced | Invoice submitted to ResQ |
| CLOSED | Invoiced | Done, hidden from dashboard |

Completed work orders (CLOSED, AWAITING_PAYMENT, WAITING_FOR_COORDINATOR_APPROVAL) are hidden from the table automatically. The stat card shows active versus total count.

**Additional actions on each work order row:**
- Upload photos to ResQ (drag and drop images/PDFs)
- Create a QBO bill from an expense receipt (AI scans the receipt and creates the bill)

---

## Master Control Dashboard

**URL:** `control.html`

PIN-protected admin panel for monitoring system health across all sites.

**Features:**
- Health status indicators for Melt Dashboard, APBG Billing, and Pacer Finance
- Token keep-alive monitoring (QBO and SF connection status)
- Reconnect buttons for QuickBooks and Service Fusion when tokens expire
- Last check timestamps and error details

---

## OAuth Setup

**URL:** `setup.html`

Use this page to establish or re-establish connections to external services.

**Two connections:**
- **Connect to QuickBooks** -- Initiates the Intuit OAuth flow. Tokens auto-refresh after initial authorization.
- **Connect to Service Fusion** -- Initiates the SF OAuth flow. Tokens are cached in a three-tier system (memory, blob storage, environment variable) for reliability.

**When to reconnect:** If you see "invalid_grant" errors, "Token refresh failed" messages, or health checks showing a service as disconnected, visit this page and click the relevant Connect button to get a fresh token.

---

## Troubleshooting

**Bill created but "NO MATCHING INVOICE"**
This is informational -- the bill was still created in QBO. It means no invoice was found containing that job number in the last 6 months. Create the invoice separately or verify the job number matches.

**Vendor not found during bill scan**
The vendor name on the receipt did not match any QBO vendor. Type the correct vendor name in the override field and retry, or create the vendor first.

**Service Fusion shows disconnected**
Go to `setup.html` and click Connect to Service Fusion to get a fresh OAuth token.

**QuickBooks shows disconnected**
Go to `setup.html` and click Connect to QuickBooks to re-authorize.

**Sync runs but work order not appearing in SF**
Check the sync log for 422 errors. Usually means the SF customer for that facility does not exist yet. Create the customer in Service Fusion manually.
