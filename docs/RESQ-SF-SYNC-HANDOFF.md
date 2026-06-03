# ResQ ↔ Service Fusion Sync — Handoff

**Repo:** `skypace/apbg-billing` · **Dashboard:** `alamedapointbg.com/billing/sync.html`
**Dev branch:** `claude/trusting-goldberg-VkzQb` · **Last sync work:** 2026-06-03 (PRs #127–#143)

> This documents the ResQ↔Service Fusion (SF) sync work that this session
> started on — the "Starbird/Melt" customer-matching fix and the sync v2
> lifecycle — before the session pivoted to Brixpense. It's a snapshot for
> whoever picks the sync work back up.

---

## 1. What this is

A reconciliation pipeline between two field-service systems:

- **ResQ** — where work orders (WOs) originate for The Melt / Starbird (cookie
  login, GraphQL). Source of truth for the WO + the customer-facing invoice.
- **Service Fusion (SF)** — where our techs/subcontractors actually do the job
  (OAuth2 *Consumer* creds). Source of truth for job status, photos, and the
  3rd-party cost.

The sync creates the SF job from a ResQ WO, mirrors status back, pushes SF job
photos into ResQ, and drives the close-out (3rd-party bill → ResQ invoice).
The hourly **cron is the safety-net reconciler**; on-demand single-job sync is
the fast path.

---

## 2. The Starbird/Melt customer-matching saga (the original bug)

This is what the work started on. Symptom: Melt/Starbird WOs **"matched no SF
customer"**, so SF jobs couldn't be created.

Root causes + fixes:

- **SF customer matching moved from name-guessing to explicit id linking.**
  `ops.sync_customers` gained **`sf_customer_id`**. Master Control →
  **Linked Customers** (`public/control.html`) now has a live SF customer
  **search** (`sync-customers?sfSearch=`) so an operator links a row to the
  real SF record by id, plus a manual "SF #" field. (PR #128)
- **`resolveSfCustomerName` resolves a linked id by matching it inside the SF
  list-search results** — the SF "get customer by id" GET endpoint is
  unreliable, so we search and match within the list. (PR #132)
- **Hard-coded backstops for the two live names:** `THE MELT RESQ` and
  `STARBIRD CHICKEN: RESQ`. **Note the colon** — the seeded row had dropped it
  (`STARBIRD CHICKEN RESQ`), which was the actual root cause of the outage. (PR #133)
- **Unlinked the `BRIX WAREHOUSE EQUIPMENT` row** — its broad `brix` keyword
  sorted first and hijacked every match.
- **SF job creation uses `customer_name`, NOT `customer_id`** — SF's `/jobs`
  endpoint returns 422 on `customer_id`. (PR #131) Creating *by id* against
  `/customers` also 401s; the working path is name-based. (PR #130)

**If matching breaks again:** check `ops.sync_customers.sf_customer_id` is set
for the customer, confirm the exact SF name (colons/spacing matter), and verify
no broad-keyword row is sorting ahead of it.

---

## 3. Lifecycle (operator workflow on sync.html)

```
ResQ WO  ──create/dedup──▶  SF job
                              │
        SF status: "Completed - Service"
                              │  (auto, in sync loop)
                              ▼
                 ResQ visit started + SF photos pushed to ResQ
                              │
                   operator clicks 💰 Bill
                              ▼
        QBO bill created  +  expense lands in Brixpense (ops.expense_requests)
                              │
                   operator clicks 🔒 Close
                              ▼
              SF job → "Invoiced"  ──triggers──▶  ResQ invoice submission
```

- **💰 Bill** and **🔒 Close** are deliberately **separate** buttons (PR #141):
  bill first (enter the 3rd-party cost), then close (which submits the ResQ
  invoice). `🔒 Close` = `resq-sf-sync?closeJob=<code>` → sets SF job to
  `Invoiced`.

---

## 4. Files

### Netlify functions (`netlify/functions/`)
| File | Role |
|---|---|
| `resq-sf-sync.mjs` | Authed entrypoint. `?syncOne=<resqCode>` (single WO), `?closeJob=<code>` (→ Invoiced), full-list sync. Dashboard calls this. |
| `resq-sf-sync-background.mjs` | Core logic. Exports **`syncSingleByCode(resqCode)`** — same create/dedup + status/invoice logic as the cron, for one WO. (PR #127) |
| `resq-sf-sync-cron.mjs` | Hourly safety-net reconciler. Unchanged by the on-demand work. |
| `sf-webhook.mjs` | Secret-gated manual trigger: `{resq_code}` / `{sf_job_id}`. **Internal/manual only — SF has no native webhook**, this is not a Zapier target. (PR #127) |
| `sync-customers.mjs` | `?sfSearch=` live SF customer search for the control-panel linker. |
| `expense-to-bill.mjs` | 💰 Bill action: QBO bill + Brixpense landing row. |
| `sf-helpers.mjs` / `resq-helpers.mjs` | SF OAuth + ResQ GraphQL clients. |
| `sf-oauth-callback.mjs` | SF OAuth handshake. |

### Libs (`netlify/functions/lib/`)
| File | Role |
|---|---|
| `sf-assets.mjs` | Lists a SF job's pictures, fetches bytes **host-aware** (public S3 = anon; `api.*` = Bearer; `admin.*` = Cookie via `orders.sf_portal_session`), relays each through the **`resq-photo-relay`** public Storage bucket (short filename), and pushes them as **after-images to the ResQ visit** (`addAfterImagesToVisit`); starts a visit via the WO appointment when none exists. (PRs #134–#138) |
| `resq-sf-links.mjs` | Phase-2 mirror writer (`ops.resq_sf_links` / `sync_events`). **Dormant** — skips cleanly when no service-role key. |
| `sync-customers.mjs` | Customer link helpers. |

### Frontend
- `public/sync.html` — the dashboard (⚡ Sync this WO now, 💰 Bill, 🔒 Close).
  Manual photo UI was **removed** (#139) — photo push is automatic now.
- `public/control.html` — Master Control → Linked Customers (SF search + link).

---

## 5. Data & storage

- **`ops.sync_customers`** — customer link table; `sf_customer_id` added.
- **`ops.resq_sf_links` / `ops.sync_events`** — Phase-2 mirror tables. **Dormant**
  until `SUPABASE_SERVICE_ROLE_KEY` is set on the apbg-billing Netlify site
  (the cron has no user JWT to write with). Activating = just add the env var.
- **`orders.sf_portal_session`** — the SF portal cookie (refreshed externally by
  Make); read for `admin.*`-host photo fetches.
- **`resq-photo-relay`** — **public** Supabase Storage bucket. Photos are relayed
  here because **ResQ stores the image ref in a `varchar(100)`** — inline base64
  data-URLs overflow it, so ResQ gets a short public URL instead. (PR #137)

---

## 6. Infra / env

- **`SUPABASE_SERVICE_ROLE_KEY`** — now used by apbg-billing functions (previously
  anon-only) to: read `orders.sf_portal_session`, upload to `resq-photo-relay`,
  and write the Brixpense expense-landing row. If unset, the Phase-2 mirror stays
  dormant but sync still runs off the Netlify Blob.
- **SF** — OAuth2 **Consumer** credentials (not App). `/jobs` wants `customer_name`.
- **ResQ** — cookie login; **no longer read-only** — we write back via GraphQL
  mutations `startVisit` + `addAfterImagesToVisit`.
- **QBO** — realm `9130352144155116` for the 💰 Bill step.
- **sf-webhook secret** — gates the manual trigger.

---

## 7. Gotchas

- **SF customer name must be exact**, colons included (`STARBIRD CHICKEN: RESQ`).
- **`/customers` by id = 401; `/jobs` with `customer_id` = 422.** Use the
  list-search + `customer_name` path.
- **ResQ image ref is `varchar(100)`** — never hand ResQ a data-URL; relay a
  short public URL.
- **Photo push is incremental** (#143): only new pics are pushed, and it keeps
  re-checking until the WO is invoiced. It sits in the `needsPhotoTransfer` slot
  — *after* visit-complete, *before* invoice-submit.
- **Cron is the reconciler, not the trigger.** Don't rely on it for timeliness;
  use `?syncOne=` / the dashboard button for that.

---

## 8. Open items / next steps

- **Activate the Phase-2 mirror** (`ops.resq_sf_links` / `sync_events`) by setting
  `SUPABASE_SERVICE_ROLE_KEY` on the apbg-billing Netlify site, then verify
  `lib/resq-sf-links.mjs` starts writing.
- **Payment features on `ops.expense_requests`** (`payment_account_*`) were called
  out as the next step after the SF→Brixpense landing (#140) — partly addressed
  later in `20260603a_expense_payment_fields.sql`.
- **No automated tests** on the sync path — it's been validated by live runs
  against Melt/Starbird WOs.

---

## 9. PR index

| PR | What |
|---|---|
| #127 | Sync v2 P3 — on-demand single-job sync (`syncSingleByCode`, `sf-webhook`). |
| #128 | Link Melt/Starbird customers to real SF record by id (control-panel SF search). |
| #130 | Create SF jobs by SF customer id (bypass `/customers` 401). |
| #131 | `/jobs` needs `customer_name` not `customer_id` (422 fix). |
| #132 | Resolve SF customer name via the working list search. |
| #133 | Hard-code SF names for Melt + Starbird (the dropped-colon root cause). |
| #134–#138 | SF photos → ResQ: host-aware fetch, start visit via appointment, relay via public bucket. |
| #139 | Remove manual photo controls (push is automatic). |
| #140 | Land SF expense + QBO bill into Brixpense (`ops.expense_requests`). |
| #141 | Separate 🔒 Close button → SF job to `Invoiced`. |
| #142 | Change-log for the above. |
| #143 | Incremental photo sync (push only new pics, keep checking until invoiced). |
