# Pacer Billing v3 — Email-to-Bill Automation

Complete vendor bill processing system: email a bill → Claude scans it → Whitney approves → Bill created in QBO → matched to existing invoice → margin calculated.

## How It Works

```
Vendor bill arrives (email or web upload)
         ↓
Claude scans the PDF — extracts vendor, line items, amounts
         ↓
Approval email sent to Whitney with "Review & Approve" link
         ↓
Whitney opens link → edits vendor, account, location, job number
         ↓
Clicks "Approve & Create Bill"
         ↓
Bill created in QBO → System searches invoices for job number
         ↓
MATCH → Confirmation email with margin calculation
NO MATCH → Warning email: "No invoice on file"
```

## Setup Steps

### 1. Deploy to Netlify
Add these files to the pacerfinance repo, or deploy as standalone:
```bash
netlify deploy --prod --site pacer-billing --dir public --functions netlify/functions
```

### 2. Add Environment Variables
The following env vars are needed on the Netlify site:

| Variable | Purpose | Notes |
|----------|---------|-------|
| QBO_CLIENT_ID | QBO OAuth | Already on pacerfinance |
| QBO_CLIENT_SECRET | QBO OAuth | Already on pacerfinance |
| QBO_REALM_ID | QBO company ID | Already on pacerfinance |
| QBO_REFRESH_TOKEN | QBO auth token | Already on pacerfinance |
| QBO_ENVIRONMENT | production | Already on pacerfinance |
| ANTHROPIC_API_KEY | Claude API for PDF scanning | Get from console.anthropic.com |
| SENDGRID_API_KEY | Email sending | OR use RESEND_API_KEY |
| APPROVAL_EMAIL | Who gets approval emails | Default: wgrandell@brixbev.com |
| EMAIL_FROM | Sender address | Default: billing@brixbev.com |
| TOKEN_SECRET | Signs approval URLs | Optional — falls back to QBO_CLIENT_SECRET |

### 3. Set Up Email Receiving (for email-based intake)

**Option A: SendGrid Inbound Parse (recommended)**
1. Create SendGrid account → Settings → Inbound Parse
2. Add domain (e.g., billing.brixbev.com)
3. Set MX records per SendGrid instructions
4. Set webhook URL: `https://pacer-billing.netlify.app/.netlify/functions/process-inbound`
5. Enable "POST the raw, full MIME message"

**Option B: Mailgun Inbound Routes**
1. Create Mailgun account → add domain
2. Set up Route: match `bills@billing.brixbev.com` → forward to webhook URL
3. Webhook: `https://pacer-billing.netlify.app/.netlify/functions/process-inbound`

**Option C: Manual forwarding (no setup needed)**
- Use the web upload page at `https://pacer-billing.netlify.app/`
- Drop a PDF → approval email sent automatically

### 4. Password Protect (optional but recommended)
In Netlify dashboard → Site Configuration → Access Control → set a password.

## URLs
- **Home / Upload**: `https://pacer-billing.netlify.app/`
- **Manual Approval Form**: `https://pacer-billing.netlify.app/approve.html`
- **Inbound Webhook**: `https://pacer-billing.netlify.app/.netlify/functions/process-inbound`

## Files

| File | Purpose |
|------|---------|
| `process-inbound.mjs` | Receives email/upload, scans PDF with Claude, sends approval email |
| `approve-bill.mjs` | Creates QBO bill, searches for matching invoice, sends confirmation |
| `decode-token.mjs` | Decodes signed approval URL for the review page |
| `email-helpers.mjs` | Email sending + HTML templates (approval, confirmation, warning) |
| `token-helpers.mjs` | HMAC-signed stateless tokens (no database needed) |
| `qbo-helpers.mjs` | QBO OAuth token refresh + API wrapper |
| `get-vendors.mjs` | Lists QBO vendors for dropdown |
| `get-customers.mjs` | Lists Melt + Starbird customers for dropdown |
| `create-vendor.mjs` | Creates new vendor in QBO on the fly |
| `index.html` | Landing page with PDF drop zone |
| `approve.html` | Full approval form (from email link or manual entry) |

## QBO Account Mapping

| COGS Account | ID | Use For |
|--------------|----|---------|
| Service Expense | 101 | Labor, service calls, repairs |
| Equipment Sales COGS | 42 | Parts, materials, equipment |

## Invoice Matching Logic
The system searches QBO invoices for the job number in:
1. Invoice number (DocNumber)
2. Private notes
3. Customer memo
4. Line item descriptions

Searches across: the selected customer, THE MELT, THE MELT MAIN, and THE MELT -EQUIPMENT (PAYMENT PLAN).
