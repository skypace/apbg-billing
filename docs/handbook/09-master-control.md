# Master Control — Health, ResQ Sync, Linked Customers, Maintenance & Sweeps

> Part I · User Guide · Owner: Sky Pace · Last reviewed: 2026-07-22

Master Control at **https://alamedapointbg.com/control** is the superadmin operations panel for the whole APBG stack: system health, OAuth token status, per-app maintenance banners/lockouts, the ResQ ↔ Service Fusion sync engine, the ResQ facility → customer map, credit-card/expense reconciliation, MCP connector authorization, and (new this release) the handbook staleness sweep. This chapter walks each section top to bottom. It is for superadmins only — the page gates on `requireSuperadmin()` and every backing endpoint re-checks the same.

The page itself lives in `apbg-billing` (`public/control.html`), served through the gateway. It auto-refreshes health and ResQ sync status every 60 seconds.

## System health grid + Refresh All

The top of the page is a card grid, one card per monitored system, each with an overall pill (HEALTHY / DEGRADED / DOWN / UNKNOWN) and per-dependency dot rows:

| Card | Health source | Checks |
|---|---|---|
| APBG 3rd Party Billing | `apbg-billing` `health-watchdog` function | QuickBooks · Service Fusion · ResQ |
| Melt Equipment Dashboard | `melt-dashboard` `/api/health` | QuickBooks · Data Cache · ResQ |
| MCP Pacer Finance | `apbg-billing` `pacer-health` function | QuickBooks · Zoho Books |

- **↻ Refresh All** re-probes everything on demand; the "Last check" stamp updates. Probes also run automatically every 60 s.
- `health-watchdog` and `pacer-health` are superadmin-gated; the page sends your session token. A 401/403 renders a neutral "Sign in as superadmin to view" state — it is **not** an outage.
- When a check is red, a **Reconnect** button appears inline (and 🔑 buttons in the card footer) that opens the correct OAuth authorize URL for that system — QuickBooks (Intuit) for apbg-billing and melt-dashboard, Service Fusion for apbg-billing. Complete the OAuth flow in the new tab, then Refresh All. Remember: each surface is its **own** Intuit app against the shared QBO realm `9130352144155116` — reconnect from the card that is red, not from a different app's setup page.

## Token Keep-Alive status

A tile per system showing whether its token/cache activity is alive: last activity time and an age badge (green under 2 h, amber under 6 h, red beyond, ❌ Down if unreachable). This is a fast "are the background refreshes still running" glance; the fix for a dead one is usually the Reconnect flow above or the app's own setup page (https://alamedapointbg.com/billing/setup.html for the AP tool's QBO/SF tokens).

## Service & Maintenance (per-app banner / lockout)

Puts any APBG app into a **banner** (dismissible notice) or **lockout** (full-screen block) state with your service note. State lives in the gateway's `public.app_maintenance` table, written via the gateway `POST /api/maintenance` (superadmin JWT), and rendered inside every app by the embedded `appswitcher.js`. Users see the effect within ~30 seconds. What users experience is described in [APBG Gateway](#/01-gateway-hub).

The row list is **registry-driven**: every app registered in the gateway's app registry gets a row automatically (plus the core infrastructure rows — All apps, Operations Hub, Master Control, the Handbook), so any app in the portal can be cut off from here without a code change. Apps that share one surface collapse onto one row (User Guides + SOPs → Handbook; Inventory → Refractor); external third-party links (Trello, Service Fusion's own site) have no row because we can't lock a site we don't run.

### Put an app into maintenance

1. In the Service & Maintenance table, find the app row (or `all` for everything).
2. Set **Mode** to `Banner` (users can keep working) or `Lockout` (app fully blocked; superadmins get an admin bypass).
3. Fill **Title** (e.g. "Scheduled maintenance") and the **Service note** users will read.
4. Click **Save**. The row's pill flips to BANNER or LOCKED and the change propagates within ~30 s.

### Take it out

1. Set the row's Mode back to **Live (off)** and click **Save**. The pill returns to LIVE.

A specific app's lockout wins even if the global key is off; lockout always wins over banner.

## ResQ Sync

Controls the ResQ ↔ Service Fusion ↔ QBO sync **engine**, which does not run here — it lives in `skypace/apbg-resq-sync` as Supabase edge functions on a 15-minute pg_cron. This panel is its control plane, proxied through `netlify/functions/resq-sync-control.mjs` → `ops.resq_sync_set_write / _set_active / _status` RPCs (service-role only; every action superadmin-gated). The old in-repo sync (`sync.html` + 5-min cron) was decommissioned 2026-06-28.

### Service Fusion connection card

The sync uses **RESQ's own SF Connected App** with an isolated token (`ops.resq_sf_token_cache`) — separate from the AP tool's SF token. The card shows: Connected / Not connected / token-expired-will-auto-renew, access-token expiry, refresh count, who last refreshed, and the last error. **Connect / ↻ Reconnect** fetches a secret-gated `sf-connect` URL and opens SF authorization in a new tab — approve there, then click ↻ Refresh.

### The two switches

| Switch | States | Meaning |
|---|---|---|
| **Sync engine** | 🟢 Running (every 15 min) ↔ ⏸ Paused | Enables/disables the pg_cron jobs. Pausing stops all automatic polling until resumed (confirm-gated). |
| **Mode** | 👁 Observe only ↔ ✍️ WRITE | Observe = reads only, records what it *would* do. WRITE = actually creates SF jobs, pushes photos, and submits ResQ invoices. Both directions confirm-gated. |

### Status tiles and controls

Tiles: **Last tick** (with success/failure; goes amber if stale >30 min while crons are on), **Last watchdog**, **Open WOs**, **Errored**, **Quarantined** (🔒 rows are held by the engine's state machine and need attention).

- **▶ Run a tick now** — triggers one full discovery tick immediately (same as a cron fire), attributed to your email in the engine's logs.
- **⚡ Drive this WO** — enter a ResQ code (e.g. `R1046442`) and drive just that work order through the pipeline. Use after fixing whatever blocked it.
- **🔗 Reconcile ResQ ↔ SF** — a read-only cross-check of the last ~50 open WOs assigned to us against SF: shows matched / **no SF job** / errors per WO with facility names. Runs ~60–90 s (the browser calls the edge endpoint directly because it outlives a Netlify function). Rows with "— none —" in the SF column are the ones to investigate — usually an unlinked facility (next section).
- **↻ Refresh** — reload the status snapshot.

Below the controls, a **recent work orders** table shows each tracked WO's ResQ code, SF job, last action, last error, and age.

## Linked Customers

The **ResQ facility → SF/QBO customer map** (`ops.sync_customers`), read live by the sync engine. This is the single most important table for ResQ work: **a work order whose facility matches no linked customer is silently skipped — no SF job is ever created.** When a new ResQ facility comes online, link it here first.

Each row maps a QBO customer (e.g. THE MELT RESQ) to: an **SF customer record (by id)**, **ResQ facility keywords** (comma-separated; matched against the WO's facility name), and a LINKED/OFF status with Unlink/Re-link.

### Link a new facility

1. If the customer appears under **Available "RESQ" customers to link** (auto-listed from QBO), click **+ Link** and enter the ResQ facility keyword(s) when prompted.
2. In the row's SF column, type a name in **search Service Fusion…** and click **Find**, then **Use** on the right result — this stores the real **SF customer id**, so SF-side name drift can't break job creation. Alternatively paste the SF customer # directly and **Save #**.
3. Adjust the **ResQ facility keywords** so they match the facility names on that customer's WOs — and *only* those.
4. Verify with **Reconcile ResQ ↔ SF** in the panel above: the facility's WOs should now show SF jobs on the next ticks.

Two hard-won cautions (both caused real outages):

- **Exact SF names matter.** The Melt/Starbird "matched no SF customer" outage was a single dropped colon (`STARBIRD CHICKEN: RESQ`). Linking by SF **id** via the search is the fix — prefer it over typing names.
- **Broad keywords hijack matches.** A `brix` keyword on a warehouse row was capturing other customers' WOs. Keep keywords specific to the facility.

## Card & Expense Match

Merges the **QBO credit-card/expense feed** with **Brixpense** records so every card charge has a receipt/context on file. Pick a **From/To** date range (defaults to the last 45 days) and click **Load / Refresh** (QBO can take ~20 s). Results come in four buckets:

| Bucket | Meaning | Action |
|---|---|---|
| 🤝 Suggested merges | Same amount, dates within 14 days (with vendor-similarity %) | **Merge ✓** to link the charge to the Brixpense record |
| 🧾 Charges with NO Brixpense record | Card charge with no receipt/context filed | **Import to Brixpense →** creates a Brixpense record (lands as already-posted; nothing re-posts to QuickBooks) |
| 📭 Brixpense records with no QBO charge | Submitted but never hit the books as a Purchase | Investigate in Brixpense |
| ✅ Already merged | Linked pairs | **Unlink** if a match was wrong |

See [Brixpense](#/07-brixpense) and [SOP-7 · Expenses & Purchasing](#/27-sop-expenses-purchasing) for the policy side.

## MCP Servers

The MCP servers (PACER Finance QBO/Zoho/SF, Pacer Outlook, ASM MCP Tools, the Retell voice bridge) authenticate callers with **OAuth 2.1 through Supabase Auth** on the shared project — each server publishes discovery metadata at `/.well-known/oauth-protected-resource`, consent happens at `alamedapointbg.com/oauth/consent` with your gateway login, and each server enforces its own `MCP_ALLOWED_EMAILS` allowlist (a valid login alone is not enough).

The panel shows a **live status row per server**: green = discovery served and pointing at our authorization server; amber = partially converted or discovery missing; red = unreachable.

Two different "reconnects" — pick the right one:

1. **A Claude connector lost access** (claude.ai says the connector needs authorization): remove & re-add the connector in claude.ai → Settings → Connectors, then approve at the consent page when the browser lands there. Nothing to click in Master Control — the flow is client-initiated.
2. **A server lost its provider tokens** (QBO/Zoho/SF calls failing inside the MCP): **Provider Connections →** (`/pacer/connect.html`) re-runs the provider OAuth the server itself holds. Those tokens are stored server-side and refresh automatically — reconnect only when a light goes red.

See [Companion Apps](#/11-companion-apps) for what the MCP servers are.

## APBG Handbook & SOP Sweep

The **APBG Handbook** panel has three parts: the library link, the sweep, and the auto-update button.

### Handbook library link

Opens the handbook viewer — the document you are reading. The markdown source lives in `apbg-billing` at `docs/handbook/`, and the viewer is served at **https://alamedapointbg.com/margin/docs/handbook/** through the gateway (the `/margin/docs/*` proxy route; directly, `apbg-billing.netlify.app/docs/handbook/`). Beyond the user guides and SOPs, the library carries:

- **[Architecture & Data](#/12-architecture-overview)** — Mermaid diagrams of how the apps, data stores, and pipelines fit together.
- **[Live Architecture Mirror](#/13-architecture-live)** — the master `ARCHITECTURE.md` rendered straight from GitHub at view time (`handbook-architecture` function; admin sign-in required). A live fetch can't drift the way a copy would.
- **[Change Log](#/90-change-log)** — an automatic feed of every commit across all APBG repos (`handbook-changelog` function). Git is the logger; nothing is entered by hand.

### Run sweep

Every chapter registers its **source documents** in `docs/handbook/manifest.json` (repo + path per source) along with a `last_reviewed` date. The **Run sweep** button calls the `handbook-sweep` Netlify function, which:

1. Reads the manifest.
2. For each chapter, fetches the latest GitHub commit date touching each registered source file.
3. Flags the chapter **stale** when any source has commits newer than the chapter's `last_reviewed` date.
4. Reports the results in the panel: which chapters are stale, which sources moved, and when.

For each stale chapter the sweep produces a **copy-paste update prompt** — a ready-made instruction for a Claude session naming the chapter file, its changed sources, and the review-date bump — so bringing a chapter current is a paste, not a research project. After a chapter is re-verified against its sources, update its `last_reviewed` in the manifest (that's what clears the stale flag).

### Auto-update (one button → draft PR)

When the sweep finds stale chapters, an **Auto-update** button appears. It calls `handbook-autoupdate-background`, which for each stale chapter: pulls the current chapter and the changed source files from GitHub, has Claude rewrite the chapter against them (same structure, grounded, review date bumped), then commits everything to a new branch and opens a **draft PR** on `apbg-billing`. Runs in the background (~1–3 minutes); the PR appearing at github.com/skypace/apbg-billing/pulls is the result.

**It never merges anything.** Per [SOP-0](#/20-sop-governance), SOP and user-guide text always gets human review before it goes live — the automation ends at a ready-to-review PR. Needs `GITHUB_WRITE_TOKEN` (or a write-scoped `GITHUB_TOKEN`) and `ANTHROPIC_API_KEY` on the Netlify site.

The sweep also runs **automatically every Monday 15:00 UTC** (`handbook-sweep-cron`): when anything is stale it emails a digest to service@brixbev.com (override with `HANDBOOK_ALERT_TO`) pointing back to this panel — so drift gets noticed even if nobody presses the button. A fresh handbook sends nothing.

Superadmin only, like everything else on this page. The governance rules around who reviews what and how often live in [SOP-0 · Policy Governance](#/20-sop-governance).

## Activity Log

The bottom of the page is a rolling log (last 100 lines, newest first) of everything the panel did this session: health probe results, maintenance saves, ResQ sync actions and tick results, card-match loads/merges, and errors — color-coded (green ok, blue info, amber warn, red error). It is per-session (not persisted); use it to confirm an action landed before walking away.

## Related

- [APBG Gateway — Operations Hub, Login, Roles & App Manager](#/01-gateway-hub) — how banners/lockouts appear to users; superadmin role
- [Brixpense — Expenses & Purchase Requests](#/07-brixpense) — where Card & Expense Match imports land
- [3rd-Party Billing (AP Tool)](#/08-ap-billing-tool) — the QBO/SF OAuth setup page behind token issues
- [Companion Apps](#/11-companion-apps) — apbg-resq-sync and the pacerfinance MCP servers this page controls
- [SOP-0 · Policy Governance](#/20-sop-governance) · [SOP-6 · Service, Maintenance Windows & Incident Response](#/26-sop-service-maintenance)
- Source docs: `skypace/apbg-billing` `public/control.html`, `netlify/functions/resq-sync-control.mjs`, `CLAUDE.md` (ResQ sync decommission + control-panel changelog); sync engine in `skypace/apbg-resq-sync`
