# Companion Apps — Fountain DAM, Melt, APBG Ops, ERLS, MCP Servers

> Part I · User Guide · Owner: Sky Pace · Last reviewed: 2026-07-22

This chapter is a quick reference to the APBG systems that don't get their own handbook chapter (yet): the Fountain brand-asset library, the Melt equipment portal, the APBG Ops KPI dashboard, the Brix ERLS leasing platform, the headless ResQ sync engine, and the MCP servers wired into Claude. For each: what it is, where it lives, who uses it, and where to read more. Where our documentation is thin, this chapter says so and points at the repo and the architecture handbook instead of guessing — the master system map is [`activespacescience/Skilliosis_Mytosis_Architecture/ARCHITECTURE.md`](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md).

| App | URL | Repo | Users |
|---|---|---|---|
| Fountain DAM | https://fountain-dam.netlify.app (linked from the hub `fountain` tile) | `skypace/DAM-Fountain` | Marketing / sales / anyone needing brand art |
| Melt Dashboard | https://alamedapointbg.com/melt/ | `skypace/melt-dashboard` | Melt account team (melt-* roles) |
| APBG Ops | https://alamedapointbg.com/operations/ | `skypace/APBG-OPS` | Owners + ops (operations / ops-* roles) |
| Brix ERLS (Leasing/Rental) | Railway-hosted (see repo) | `skypace/APBG-Leasing-Rental` | Ops/finance managing rental & lease contracts |
| apbg-resq-sync | Headless (managed from /control) | `skypace/apbg-resq-sync` | Superadmins via Master Control |
| pacerfinance MCP | https://pacerfinance.netlify.app | `skypace/pacerfinance` | Claude sessions (QBO + Zoho tools) |
| Pacer-outlook MCP | https://pacer-outlook.netlify.app | `skypace/Pacer-outlook` | Claude sessions (Outlook tools) |

## Fountain DAM (brand asset library)

**What:** The in-house digital asset management app for Brix Beverage + Alameda Soda brand art (logos, can shots, equipment photos, hero images, sell sheets). It replaced the paid Brandox subscription, which was retired 2026-07-04 after its JS-only portal proved unreadable server-side.

**Where:** Standalone React/Vite app at **https://fountain-dam.netlify.app** — its own SPA and Netlify functions with a `dam` Postgres schema, but it **shares the `brand-assets` Supabase Storage bucket and the same Supabase auth** as the rest of APBG (sign in with your normal APBG credentials). It graduated out of an apbg-billing page (2026-07-05); the gateway's `/fountain` route now 301-redirects to the new site, so old bookmarks still work, and the `fountain` tile on the hub points there directly.

**Who uses it:** anyone with the `billing` access bucket per the gateway registry — practically, marketing/sales staff pulling brand art, and the Refractor Proposal Builder's Brand Library reads the same bucket.

**Docs/source:** `skypace/DAM-Fountain`. This handbook has no UI walkthrough for it — the app is young; check the repo README and the architecture handbook for current state.

## Melt Dashboard

**What:** The Melt equipment portal — statements, payment schedule, invoices, applied payments, stores, and equipment tracking for The Melt account.

**Where:** **https://alamedapointbg.com/melt/**, proxied from `melt-dashboard.netlify.app` (repo `skypace/melt-dashboard`). It shares the APBG Supabase auth project and its health is monitored on the Master Control grid (QuickBooks · Data Cache · ResQ checks). It runs its **own** Intuit app against the shared QBO realm — reconnect its QBO from its own card on Master Control, never from another app's setup page.

**Who uses it:** the melt-* roles, with per-role tab/section grants (e.g. `melt-billing` sees payments only, `melt-general` sees equipment only) — see the role table in [APBG Gateway](#/01-gateway-hub).

**Docs/source:** `skypace/melt-dashboard` and the architecture handbook. A detailed user chapter is a candidate for a future handbook revision; this handbook does not document its screens.

## APBG Ops (Key Company Metrics)

**What:** The PACER operational KPI dashboard — company metrics, roster, and the FleetComplete/HR integrations that moved out of apbg-billing.

**Where:** **https://alamedapointbg.com/operations/** (repo `skypace/APBG-OPS`). Registered on the gateway as the first-class `operations` app (2026-07-02), so maintenance banners/lockouts and access-walls target it correctly.

**Who uses it:** owners and ops staff — the `operations` access bucket: superadmins, the legacy `operations` role, and the ops-* roles (ops-super / ops-delivery / ops-service / ops-reman / ops-viewer). The ops-* driver roles also see the CO₂ Audit tile, which lives in brix-order (see [CO₂ Cylinder Audit PWA](#/04-driver-cylinder-audit)).

**Docs/source:** `skypace/APBG-OPS`; historical scoping in apbg-billing's `PACER-KPI-SPEC.md` / `PACER-OPS-README.md`. No screen-level walkthrough exists here — consult the repo.

## Brix ERLS — APBG-Leasing-Rental

**What:** The equipment rental / lease-support / contract / billing platform ("Brix Equipment Platform"). Its day job: turn active rental and lease contracts into **one QBO invoice per contract, every month** — contracts pulled from QBO recurring transactions, a nightly job (05:00 UTC) generating billing runs for `auto`-mode contracts, a 15-minute pusher posting them to QBO as invoices, and QBO webhooks + CDC polling reconciling payments. Service Fusion stays the source of customers/jobs; this platform owns pricing, contracts, terms, and billing orchestration; QBO owns the accounting records.

**Where:** A separate **Railway-backed** stack, unlike everything else on Netlify: a monorepo with a Next.js frontend (`apps/web`), FastAPI backend (`apps/api`), and Celery/Redis workers, on PostgreSQL. Operator entry points: the per-contract "Run billing" button, Integrations → "Pull rental customers + history", and Swagger admin endpoints under `/api/admin/*`. A public URL is not recorded in the sources this chapter is grounded on — check Railway or the architecture handbook.

**Who uses it:** ops/finance staff who manage rental and lease contracts. The hub has an `erls` tile; the Master Control maintenance table includes a `leasing` app key.

**Docs/source:** `skypace/APBG-Leasing-Rental` — README (billing flow + ten non-negotiable engineering rules) and `docs/` (field maps, deployment checklist). ⚠ **Repo quirk:** the default branch is `claude/equipment-rental-platform-Tj6Il`, **not** `main` — anyone cloning or PR-ing this repo should target that branch until the platform stabilizes and merges back to `main`.

## apbg-resq-sync (headless sync engine)

**What:** The ResQ ↔ Service Fusion ↔ QBO sync engine: watches ResQ work orders, creates the matching SF jobs, pushes photos, and submits ResQ invoices, with state-machine idempotency and a quarantine lane for stuck WOs. It replaced apbg-billing's in-repo sync (decommissioned 2026-06-28).

**Where:** Supabase edge functions on a **15-minute pg_cron** — there is no UI of its own. It is operated entirely from **Master Control → ResQ Sync** (https://alamedapointbg.com/control): sync engine on/off, Observe vs WRITE mode, run a tick, drive a single WO, reconcile, and the SF connection for RESQ's own Connected App. It depends on the `ops.sync_customers` facility map — an unlinked facility means its work orders are skipped. Full operating instructions: [Master Control](#/09-master-control).

**Who uses it:** nobody directly — superadmins manage it via Master Control.

**Docs/source:** `skypace/apbg-resq-sync`; control plane in `apbg-billing/netlify/functions/resq-sync-control.mjs`.

## MCP servers wired into Claude

MCP servers give Claude sessions live tool access to our business systems. Two are ours:

### pacerfinance — QBO + Zoho MCP

**What:** MCP server exposing QuickBooks Online and Zoho Books tools to Claude. Also covers the Service Fusion connector per the Master Control MCP panel.

**Where:** **https://pacerfinance.netlify.app** (repo `skypace/pacerfinance`). Its health shows on the Master Control grid as "MCP Pacer Finance" (QuickBooks · Zoho Books via the `pacer-health` probe), and its system authorizations are managed from **Master Control → MCP Connectors → Manage MCP Connections** (`/pacer/connect.html`). Tokens are stored server-side in Supabase and refresh automatically. It runs its own Intuit app against the shared realm (callback `pacerfinance.netlify.app/qbo-oauth-callback`).

**Who uses it:** Claude sessions doing finance work; indirectly, the voice agent's HQ mode in brix-order bridges to it.

**Docs/source:** `skypace/pacerfinance`.

### Pacer-outlook — Outlook MCP

**What:** MCP server for Outlook email: the live tools are `outlook_search_emails`, `outlook_scrub_vendor_docs`, and `outlook_extract_attachments`.

**Where:** **https://pacer-outlook.netlify.app** (repo `skypace/Pacer-outlook`). Note the repo's own CLAUDE.md flags that the deployment source for the live MCP is **unverified** — confirm the repo is actually what's serving it before changing anything.

**Known issues (per its CLAUDE.md and brix-order session notes, current as of this review):**

- The **M365 token is expired** — re-authenticate at **https://pacer-outlook.netlify.app/outlook/auth** when Outlook tools start failing.
- The MCP endpoint has **no API-key gate** — a hardening fix is pending in `skypace/Pacer-outlook`. Treat the endpoint as sensitive until that lands.

**Who uses it:** Claude sessions doing email/vendor-doc work; the voice agent's HQ mode also bridges to it.

**Docs/source:** `skypace/Pacer-outlook`.

### Other MCP endpoints

The architecture handbook is the source of truth for the full MCP inventory (including the ASM tool endpoints on `asm-mcp-tools.netlify.app` used for cross-repo doc updates). This chapter only covers the two business-system servers above; consult `ARCHITECTURE.md` before wiring anything new.

## Related

- [APBG Gateway — Operations Hub, Login, Roles & App Manager](#/01-gateway-hub) — how these apps are surfaced, role-gated, and themed
- [Master Control](#/09-master-control) — health cards, MCP connector authorization, and the ResQ Sync control plane
- [CO₂ Cylinder Audit PWA — Driver Field Guide](#/04-driver-cylinder-audit) — the driver tool the ops-* roles see on the hub
- [SOP-9 · Data & Engineering](#/29-sop-data-engineering) — schema/secrets rules that apply across all of these repos
- Source docs: `activespacescience/Skilliosis_Mytosis_Architecture/ARCHITECTURE.md` (master map); `skypace/apbg-gateway` `CLAUDE.md` (Fountain graduation, co2audit tile, operations app); `skypace/apbg-billing` `CLAUDE.md` (cross-repo references); `skypace/APBG-Leasing-Rental` `README.md` + `CLAUDE.md`; `skypace/Pacer-outlook` `CLAUDE.md`
