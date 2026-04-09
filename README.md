# APBG 3rd Party Billing

AI-powered bill processing and approval system for Alameda Point Beverage Group. Vendor bills arrive via email or web upload, Claude AI scans and extracts data, then routes through an approval workflow before creating entries in QuickBooks Online.

## Tech Stack

- **Frontend:** Vanilla HTML/JS (no framework, no build step)
- **Backend:** Netlify Functions v2 (serverless)
- **Storage:** Netlify Blobs
- **Accounting:** QuickBooks Online API
- **Field Service:** Service Fusion REST API
- **Maintenance:** ResQ GraphQL API
- **AI:** Anthropic Claude API (PDF scanning and data extraction)
- **Email:** SendGrid / Resend
- **Data:** Google Sheets

## Architecture

```
public/                  Static HTML pages served by Netlify
netlify/functions/       Serverless functions (ESM, .mjs)
netlify/functions/lib/   Shared library modules
```

No build step. Netlify serves `public/` as static files and deploys `netlify/functions/` as Lambda-compatible endpoints.

## Bill Processing Workflow

```
Vendor bill arrives (email or web upload)
         |
Claude AI scans the PDF -- extracts vendor, line items, amounts
         |
Approval email sent with signed review link
         |
Approver opens link -- edits vendor, account, location, job number
         |
Clicks "Approve & Create Bill"
         |
Bill created in QBO -- system searches invoices for job number
         |
MATCH --> Confirmation email with margin calculation
NO MATCH --> Warning email: "No invoice on file"
```

## Functions

### Core Bill Processing

| Function | Description |
|----------|-------------|
| `process-inbound.mjs` | Receives vendor bills (email/web upload), scans PDF with Claude AI, extracts vendor/amount/items, sends approval email with signed URL |
| `approve-bill.mjs` | Creates bill in QBO from approval form, matches against invoices, calculates margin |
| `approve-customer.mjs` | Creates new customer in QBO from approval form |
| `create-vendor.mjs` | Creates vendor in QBO on-the-fly |
| `create-invoice.mjs` | Creates QBO invoice |
| `decode-token.mjs` | Decodes HMAC-signed approval URL tokens |

### Query Endpoints

| Function | Description |
|----------|-------------|
| `get-vendors.mjs` | Lists QBO vendors |
| `get-customers.mjs` | Lists QBO customers |
| `get-departments.mjs` | Lists QBO departments |

### ResQ-SF Sync

| Function | Description |
|----------|-------------|
| `resq-sf-sync.mjs` | Dispatcher for bidirectional ResQ-to-Service Fusion sync |
| `resq-sf-sync-background.mjs` | Long-running (15 min timeout) background sync worker |
| `resq-sf-sync-cron.mjs` | Scheduled every 5 minutes, triggers background sync |
| `sf-fix-numbers.mjs` | Finds recent SF jobs with R-code numbers |

### Health & Monitoring

| Function | Description |
|----------|-------------|
| `health-watchdog.mjs` | Scheduled health check for QBO/SF/ResQ connectivity |
| `master-health.mjs` | Health dashboard API for control.html |
| `master-health-cron.mjs` | 12-hour keep-alive for health checks |
| `pacer-health.mjs` | Proxy health check for Pacer Finance |

### OAuth & Auth

| Function | Description |
|----------|-------------|
| `oauth-callback.mjs` | QBO OAuth callback |
| `sf-oauth-callback.mjs` | Service Fusion OAuth callback |
| `sf-token-debug.mjs` | SF token diagnostic/export endpoint |

### Shared Helpers

| Module | Description |
|--------|-------------|
| `qbo-helpers.mjs` | Shared QBO token management (refresh, cache, API wrapper) |
| `sf-helpers.mjs` | Service Fusion API wrapper |
| `resq-helpers.mjs` | ResQ API helpers (CSRF + GraphQL) |
| `email-helpers.mjs` | Email sending + HTML templates |
| `token-helpers.mjs` | HMAC-signed stateless tokens for approval URLs |
| `lib/master-health-core.mjs` | Core health check logic |

## HTML Pages

| Page | Description |
|------|-------------|
| `index.html` | PDF drop zone for uploading vendor bills |
| `approve.html` | Bill approval form (vendor, line items, account, job number) |
| `customer-approve.html` | New customer creation form |
| `setup.html` | OAuth connection management (QBO + Service Fusion) |
| `sync.html` | ResQ-SF sync dashboard with status, work orders, and logs |
| `control.html` | Master control dashboard (health status, token monitoring) |

## Scheduled Functions

| Function | Schedule | Purpose |
|----------|----------|---------|
| `resq-sf-sync-cron` | Every 5 minutes | Triggers bidirectional ResQ-SF work order sync |
| `health-watchdog` | Scheduled | Checks QBO/SF/ResQ connectivity, sends email alerts on failure |
| `master-health-cron` | 12-hour interval | Keep-alive ping for health monitoring |

## QBO Account Mapping

| COGS Account | Account ID | Use For |
|--------------|------------|---------|
| Service COGS | 101 | Labor, service calls, repairs, consulting |
| Equipment Sales COGS | 42 | Parts, materials, equipment, supplies |

## Invoice Matching

The system searches QBO invoices for the job number in:
1. Invoice number (DocNumber)
2. Private notes
3. Customer memo
4. Line item descriptions

Searches across the selected customer plus THE MELT, THE MELT MAIN, and THE MELT -EQUIPMENT (PAYMENT PLAN).

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `QBO_CLIENT_ID` | QuickBooks OAuth client ID |
| `QBO_CLIENT_SECRET` | QuickBooks OAuth client secret |
| `QBO_REALM_ID` | QuickBooks company ID |
| `QBO_REFRESH_TOKEN` | QuickBooks refresh token (auto-managed) |
| `QBO_ENVIRONMENT` | `production` or `sandbox` |
| `ANTHROPIC_API_KEY` | Claude API key for PDF scanning |
| `SENDGRID_API_KEY` | SendGrid email API key |
| `RESEND_API_KEY` | Resend email API key (alternative to SendGrid) |
| `APPROVAL_EMAIL` | Recipient for approval emails |
| `EMAIL_FROM` | Sender address for outbound emails |
| `TOKEN_SECRET` | HMAC secret for signing approval URLs |
| `RESQ_EMAIL` | ResQ login email |
| `RESQ_PASSWORD` | ResQ login password |
| `SF_CLIENT_ID` | Service Fusion OAuth client ID |
| `SF_CLIENT_SECRET` | Service Fusion OAuth client secret |
| `SF_REFRESH_TOKEN` | Service Fusion refresh token (auto-managed) |
| `NETLIFY_SITE_ID` | Netlify site ID (for env var updates) |
| `NETLIFY_ACCESS_TOKEN` | Netlify API token (for env var updates) |

## Branch Deploys

- **`main`** — Production (`pacer-billing.netlify.app`)
- **`dev`** — Testing (`dev--pacer-billing.netlify.app`)

Both branches share environment variables and blob storage.

## Local Development

No build step required. To run locally:

```bash
npm install
netlify dev
```

Functions are served at `http://localhost:8888/.netlify/functions/` and static files at `http://localhost:8888/`.
