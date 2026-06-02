# ResQ ↔ SF Sync v2 — Scoping & Technical Design

> Companion to PRD.md. Status: **DRAFT for review**.

## 1. Current-state teardown (v1)

All in `apbg-billing` unless noted.

| Piece | File | Notes |
|---|---|---|
| Cron trigger | `netlify/functions/resq-sf-sync-cron.mjs` | Fires the background worker every 5 min. |
| Worker | `netlify/functions/resq-sf-sync-background.mjs` (~1,240 lines) | Poll-and-diff both directions. |
| Diagnostics/lookup | `netlify/functions/resq-sf-sync.mjs` | WO lookup + SF photo-download probing (`handleSfPhotos`). |
| ResQ auth/GQL | `netlify/functions/resq-helpers.mjs` | Username/password + CSRF cookie scrape. No rotation. |
| SF auth/REST | `netlify/functions/sf-helpers.mjs` | OAuth2 w/ refresh rotation (good). |
| Expense→bill | `netlify/functions/expense-to-bill.mjs` | Manual button: Claude OCR → QBO bill. |
| Operator console | `public/sync.html` | Table + manual photo-upload + manual bill widgets. |
| State | Netlify Blob `wo-mapping` (store `resq-sf-sync`) | One JSON object; per-WO read-modify-write under `sync-lock`. |

### What works and must be preserved

- **ResQ→SF job create + dedup**: `processNewWO`, `findSfJobsByPoNumber`,
  `pickBestSfJob`, `isSfProgressed/Unscheduled/Cancelled`, `cancelSfJob`.
  po_number = ResQ code (`R#####`) is the join key.
- **SF→ResQ status + visit completion**: `syncBidirectional`,
  `provideUpdateToResq` (startVisit / endVisit / captureVisitNotes fallbacks).
- **SF→ResQ invoice**: `buildAndSubmitInvoice` — the 5-mutation flow
  (createRecordOfWork → saveRecordOfWork → submitRecordOfWork →
  createOriginalVendorInvoice → createUpdatePayoutOffer). This is the crown
  jewel; migrate, don't rewrite.

### Concrete defects / debt found while reading

1. **Identity drift across files.** `SF_CUSTOMERS`/`FACILITY_MAP` in the worker
   vs `RESQ_CUSTOMER_MAP` in `expense-to-bill.mjs` disagree on the Starbird
   name (`STARBIRD CHICKEN: RESQ` vs `STARBIRD CHICKEN RESQ`). Three namespaces
   (ResQ facility kw, SF customer name, QBO customer name) maintained by hand.
2. **Photo transfer is a stub.** `transferSfPhotosToResq` only flags for manual
   upload. Its comment ("SF API does not expose file download endpoints. S3
   bucket is private") is **stale** — disproven by `brix-order` (see §4).
3. **Photo ordering bug.** ResQ attaches images at visit completion
   (`endVisit`/`captureVisitNotes` take `images: []`). v1 completes the visit
   with `images: []` and sets `visitCompleted`, then *later* tries to push
   photos and can't. v2 must fetch photos **before** ending the visit.
4. **Two AP paths.** `expense-to-bill.mjs` and Brixpense's
   `expense-request-link-bill.mjs` both create QBO bills with different account
   logic. v2 converges on one.
5. **Vendor eligibility short-circuit** (fixed in PR #124): `vendor?.name ||
   executingVendor?.name` dropped WOs where Brix is the executing (not primary)
   vendor.
6. **State scalability**: full 500-WO scan every 5 min; N SF GETs per WO;
   blob rewrite per WO. Doesn't scale and isn't queryable.

## 2. Target architecture

```
   SF webhook (job/expense changed)            ResQ poll (cursor: raisedOn/updatedAt high-water)
            │                                              │
            ▼                                              ▼
   sf-webhook.mjs  ──────────┐              resq-sf-sync-background.mjs (reconciler + ResQ→SF)
            │                │                             │
            ▼                ▼                             ▼
   ┌──────────────────────────  ops.* (system of record)  ───────────────────────────┐
   │  ops.sync_customers   one identity map: resq_facility_kw | sf_customer_name |     │
   │                       qbo_customer_name | qbo_cogs_account_id | entity            │
   │  ops.resq_sf_links    resq_wo_id, resq_code, sf_job_id, statuses, flags,          │
   │                       qbo_bill_id, brixpense_request_id, timestamps               │
   │  ops.sync_events      append-only audit (actor, action, payload, ts)             │
   │  ops.sync_log         existing — keep feeding it (APBG-OPS reads it)             │
   └───────┬───────────────────┬────────────────────────┬──────────────────────────┘
           ▼                   ▼                         ▼
   status push (both)    photos: SF→Supabase        expense → QBO bill (auto)
                         Storage → ResQ visit       → ops.expense_requests row
                                                    → Brixpense PAYMENT approval
```

### 2.1 Data model (new `ops.*` tables — must be added to `architecture/sync-manifest.json`)

- **`ops.sync_customers`** — the single identity map.
  `id, resq_facility_keywords text[], sf_customer_name text, qbo_customer_name
  text, qbo_customer_id text, qbo_cogs_account_id text, entity text, active bool`.
  Seeded from today's literals (reconciled to the *real* SF/QBO names).
  Read by the worker, `expense-to-bill`, and `sync.html`. **Kills defect #1.**
- **`ops.resq_sf_links`** — replaces the `wo-mapping` blob.
  `resq_wo_id (uniq), resq_code, sf_job_id, sf_customer_id→sync_customers,
  resq_status, sf_status, flags (visit_completed, photos_synced,
  invoice_submitted, sf_deleted), qbo_bill_id, brixpense_request_id,
  reconciled bool, created_at, last_sync_at`. PK/uniq lookups replace the
  3-page SF scan and the full-object rewrite.
- **`ops.sync_events`** — append-only `{link_id, direction, action, ok,
  message, payload jsonb, created_at}`. Powers the dashboard review queue and
  debugging (replaces the dedupe-report blob + log blob).

RLS: anon SELECT (dashboard reads), service-role writes — same posture as the
rest of `ops.*` (see APBG-OPS migration `0009_rls_lockdown.sql`).

### 2.2 Ingress

- **SF → ResQ: webhook.** New `sf-webhook.mjs` receiver. SF fires on job
  status change / job updated / (if available) expense added. Verify a shared
  secret (reuse the `INBOUND_EMAIL_SECRET` pattern). Look up the `resq_sf_links`
  row by `sf_job_id`, run only the handlers that apply (status push, photo
  sync, expense→bill). Near-real-time; no scan.
  - *If SF webhook coverage is insufficient* for some event types, the cron
    reconciler (below) still catches them within 5 min.
- **ResQ → SF: cursor poll.** Keep the cron, but (a) track a high-water mark
  (max `raisedOn`/`updatedAt` processed) so we only diff changed WOs, and (b)
  resolve existing links by PK instead of scanning SF. The cron also becomes
  the **reconciler/safety-net** for anything the SF webhook missed.

### 2.3 Photo pipeline (replaces the stub)

Reuse the **proven `brix-order` mechanism** (see §4):
1. `GET /jobs/:id?expand=pictures,signatures`.
2. For each non-private picture, resolve `file_location` →
   `servicefusion.s3.amazonaws.com/images/estimates/<file>` (signatures:
   `images/sign/<file>`); honor full URLs verbatim.
3. Anonymous GET the bytes (public-read S3). **Fallback**: the cookie-replay
   proxy (`get-sf-job-asset.ts` pattern, cookies in `orders.sf_portal_session`)
   for anything that 401s/returns HTML.
4. Mirror into Supabase Storage (reuse `sf-job-attachments` bucket +
   `sf_job_attachments` table that `brix-order` already created), for audit +
   dedup.
5. **Push into ResQ on visit completion** — fetch photos *first*, then call
   `endVisit` with `images: [...]` (fixes defect #3). If a post-completion
   attach mutation exists in ResQ's schema, use it for late-arriving photos.

### 2.4 Expense → QBO bill → Brixpense (auto)

On SF expense (webhook or job completion):
1. Pull the expense + receipt image from SF.
2. OCR via the existing Claude flow in `expense-to-bill.mjs` (extract vendor,
   lines, amounts, category).
3. Resolve vendor (QBO), customer + COGS account from `ops.sync_customers`.
4. **Create the QBO bill** with a hard idempotency key
   (`sf_expense_id` / `sf_job_id`+line hash) to prevent duplicates; attach the
   receipt; store `qbo_bill_id` on the link.
5. **Write an `ops.expense_requests`-compatible row** so the bill appears in
   the **Brixpense** queue as a payment to approve. Reuse Brixpense's existing
   approval model + `expense-request-link-bill` rather than a second path
   (converges defect #4). Automation = AP capture; Brixpense = payment gate.

Decision: **auto-create the bill, gate the payment in Brixpense** (per PRD).

### 2.5 Auth hardening

- Wrap `resqLogin` with ret/alerting: on failure, write a `sync_events` row +
  fire the existing health-alert path (APBG-OPS `health-alert` / billing
  `health-watchdog`). ResQ is the fragile dependency; make its failure loud.

## 3. Migration plan (incremental, each phase ships independently)

| Phase | Deliverable | Risk |
|---|---|---|
| **P1** | `ops.sync_customers` + read it from both files. Reconcile names to the real SF/QBO records. | Low. Pure win; kills name drift. |
| **P2** | `ops.resq_sf_links` + `ops.sync_events`. Dual-write (blob + tables), then cut reads over, then drop the blob. | Med. Data migration of the existing blob. |
| **P3** | `sf-webhook.mjs` receiver; cron demoted to reconciler + cursor. | Med. Needs SF webhook config + secret. |
| **P4** | Real photo pipeline (S3-first + cookie fallback), reorder visit completion. | Med. Depends on `brix-order` mechanism holding. |
| **P5** | Auto expense→QBO bill→Brixpense payment queue. | High. Money path — idempotency + Brixpense gate are mandatory. |
| **P6** | Retire manual widgets in `sync.html`; point dashboard at `ops.*`. | Low. Cleanup. |

P1 is the recommended first build regardless — it's the smallest change with
the biggest correctness payoff and it's a prerequisite for P5.

## 4. Proven prior art (`brix-order`)

- `netlify/functions/_lib/sf-attachment-sync.ts` — `resolveSfAssetUrl` +
  `fetchSfAssetBytes` + `syncJobAttachments`: the **public-S3 download** that
  disproves v1's "S3 is private" comment. Already runs on a daily schedule and
  on-demand. Mirrors to Supabase Storage `sf-job-attachments` + table
  `orders.sf_job_attachments`, with a paid-invoice purge (`purgePaidAttachments`).
- `netlify/functions/get-sf-job-asset.ts` + `orders.sf_portal_session` — the
  **cookie-replay proxy** fallback (host-aware "Bearer *or* Cookie, never both").
- `_lib/sf.ts` — SF OAuth (Consumer creds). Mirrors `apbg-billing/sf-helpers.mjs`.

Net: the hardest unknown (getting bytes out of SF) is already solved. v2
should lift this pattern, not reinvent it. Consider promoting it to a shared
lib if both repos keep using it.

## 5. Open questions

1. **SF webhooks**: which event types does our SF plan expose (job status,
   job updated, expense added)? Determines how much of P3 is webhook vs
   reconciler.
2. **Brixpense intake shape**: do we insert directly into `ops.expense_requests`
   or call a new `expense-request-from-sf` endpoint? (Prefer an endpoint so RLS
   + validation + sync-manifest stay centralized.)
3. **COGS mapping for SF expenses**: use `ops.sync_customers.qbo_cogs_account_id`
   per customer, or keep the category→account map (equipment/service)? Likely
   both: category first, customer default as fallback.
4. **Photo retention**: adopt `brix-order`'s purge-when-paid, or keep SF photos
   in ResQ only and treat Supabase Storage as a transient staging copy?
5. **Cross-repo home**: do these `ops.*` tables + the attachment lib live in
   `apbg-billing`, or get promoted to a shared sync package? (Affects
   `sync-manifest.json` ownership.)
