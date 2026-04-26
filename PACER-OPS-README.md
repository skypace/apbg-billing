# PACER Ops Dashboard — Architecture Handoff

See the full document in the repo. This is the source of truth for Claude Code.

## Quick Links
- **Supabase Project**: gfsdpwiqzshhexkofiif (APBG-BILLING)
- **Schema**: `ops` (13 tables, 5 edge functions, 4 cron jobs)
- **QBO Realm**: 9130352144155116
- **SF API**: api.servicefusion.com/v1 (OAuth2 + expand=techs_assigned)

## What's Running Autonomously
- QBO invoices + P&L syncing nightly
- SF jobs syncing every 30 min with tech names
- Stale invoice alerts emailing daily at 7am Pacific
- QBO line items backfilling (temporary)

## Build Instructions for Claude Code
1. Read PACER-OPS-ARCHITECTURE.md in this repo
2. Connect to Supabase (ops schema)
3. Build Next.js app with roster management CRUD + KPI dashboard
4. Deploy to Netlify
