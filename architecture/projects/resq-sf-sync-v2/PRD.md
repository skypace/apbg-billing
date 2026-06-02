# ResQ ↔ Service Fusion Sync v2 — PRD

> Status: **DRAFT for review** · Owner: Sky · Drafted: 2026-06-02
> Home of record: this doc should be mirrored into
> `activespacescience/Skilliosis_Mytosis_Architecture/projects/resq-sf-sync-v2/`.
> It lives in `apbg-billing` for now only because that repo holds the v1 code
> and was the in-scope repo for the drafting session.

## Problem

The ResQ ↔ Service Fusion sync (`apbg-billing/netlify/functions/resq-sf-sync-background.mjs`,
driven by a 5-minute cron) keeps the two systems loosely aligned but still
leans on **manual steps** and a **fragile state model**:

- **Photos are manual.** `transferSfPhotosToResq` is a stub — it detects that
  an SF job has pictures and tells the operator to upload them to ResQ by hand
  via `sync.html`. (The stub's comment claims SF exposes no download endpoint;
  that is no longer true — see Decisions.)
- **Expense → bill is manual.** `expense-to-bill.mjs` is a dashboard button:
  the operator opens a job, drops in a receipt, Claude OCRs it, and a QBO bill
  is created one at a time.
- **No payment loop.** Once a bill exists in QBO there is no structured
  approve-and-pay step; Brixpense already solves this for internal expenses
  but is not wired to SF-sourced bills.
- **State is a single JSON blob** (`wo-mapping` in Netlify Blobs), read-modified-
  written per work order under a lock blob. No history, no queryability, and it
  has already produced cross-file drift bugs (e.g. the Starbird customer-name
  mismatch — see PR #124).
- **Customer identity is hand-maintained in two places that disagree.** The
  ResQ-facility → SF-customer → QBO-customer mapping is duplicated as string
  literals in `resq-sf-sync-background.mjs` and `expense-to-bill.mjs`, and the
  literals don't match (`STARBIRD CHICKEN: RESQ` vs `STARBIRD CHICKEN RESQ`).

## Vision

A **fully automated, event-driven, auditable** bridge between ResQ and Service
Fusion, with QuickBooks and Brixpense closing the financial loop — **no manual
data entry** in the happy path.

1. When a job changes in **SF**, it pushes to **ResQ** (status, completion,
   photos, the vendor invoice).
2. When a work order changes in **ResQ**, it pushes to **SF** (job create,
   status).
3. **SF photos** are pulled and pushed into ResQ automatically (attached to the
   visit on completion).
4. **SF expenses** are captured automatically into a **QBO vendor bill** with
   the correct COGS account + customer, mirroring the receipt image.
5. The **payment** of that bill is approved through **Brixpense** — automation
   captures the AP liability; a human still says "pay it."

## Goals

- G1. Eliminate manual photo upload. SF pictures land in ResQ automatically.
- G2. Eliminate manual receipt→bill entry. SF expenses become QBO bills
  automatically, with the receipt attached.
- G3. Route SF-sourced bills through Brixpense for payment approval.
- G4. Make the sync near-real-time in the SF→ResQ direction (webhook), and
  efficient (cursor-based) in the ResQ→SF direction.
- G5. Move sync state out of a JSON blob into queryable `ops.*` tables with a
  full event/audit trail.
- G6. Establish **one** customer-identity source of truth across ResQ, SF, and
  QBO, killing the name-drift class of bug permanently.

## Non-goals

- Not replacing the proven ResQ→SF job-create / dedup logic or the 5-mutation
  SF→ResQ invoice flow — those are preserved and migrated, not rewritten.
- Not building a new UI framework. `sync.html` stays as the operator console;
  it just reads from `ops.*` instead of blobs and loses the manual widgets.
- Not changing ResQ auth from cookie/CSRF to something else (out of our
  control); we only harden and monitor it.
- Not introducing customer-facing surfaces — this is internal ops plumbing.

## Users

- **Ops (Dani et al.)** — want jobs, photos, and invoices to "just sync,"
  and to approve payments in one place (Brixpense).
- **Finance / Sky** — want every SF cost captured as a QBO bill with the right
  account/customer, and a clean approve-to-pay trail.
- **Engineering** — want a queryable, debuggable sync with an audit log instead
  of a blob and a wall of `console.log`.

## Success metrics

- 0 manual photo uploads per week (currently every completed job with photos).
- 100% of billable SF expenses auto-captured as QBO bills within one sync cycle.
- SF→ResQ status latency p95 < 60s (webhook) vs up to 5 min today.
- Every sync action visible in `ops.sync_log` / an events table — no more
  blob-archaeology to answer "what happened to WO R12345?".
- Zero customer-name-drift incidents after the identity map ships.

## Risks (summary — detail in scoping.md)

- **Auto-posting bills** risks duplicate/incorrect AP if OCR or matching is
  wrong. Mitigation: strict idempotency keys + Brixpense as the human payment
  gate; bills are captured but money never moves without approval.
- **ResQ has no webhooks** (cookie-auth GraphQL); ResQ→SF stays polled. The
  realtime win is one-directional.
- **SF S3/cookie download** depends on undocumented SF behavior already proven
  in `brix-order`; if SF changes it, the photo pipeline needs the cookie
  fallback (also already built in `brix-order`).
