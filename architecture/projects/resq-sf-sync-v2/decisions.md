# ResQ ↔ SF Sync v2 — Decisions Log

> One row per decision. "Confirmed" = agreed with Sky; "Proposed" = my
> recommendation pending sign-off.

| # | Decision | Status | Rationale |
|---|---|---|---|
| D1 | **One identity map** (`ops.sync_customers`) is the single source of truth for ResQ-facility ↔ SF-customer ↔ QBO-customer ↔ COGS account ↔ entity. Both `resq-sf-sync-background.mjs` and `expense-to-bill.mjs` read it. | Proposed | Kills the name-drift bug class (Starbird `: RESQ` vs ` RESQ`, PR #124). Prereq for auto-billing. |
| D2 | **State moves from the `wo-mapping` Netlify Blob to `ops.resq_sf_links` + `ops.sync_events`.** | Proposed | Queryable, auditable, PK lookups instead of full scans; same `ops.*` posture as the rest of the stack; lets `sync.html` + APBG-OPS read sync state directly. |
| D3 | **SF→ResQ becomes webhook-driven** (`sf-webhook.mjs`); **ResQ→SF stays cursor-polled**; the cron becomes a reconciler/safety-net. | Proposed | SF supports webhooks; ResQ (cookie-auth GraphQL) does not. Get realtime where we can, stay correct where we can't. |
| D4 | **Photo download uses `brix-order`'s public-S3 path first, cookie-replay proxy as fallback.** | Confirmed | Sky: "we figured a workaround out in brix-order." Proven in `_lib/sf-attachment-sync.ts` (S3) + `get-sf-job-asset.ts` (cookies in `orders.sf_portal_session`). v1's "S3 is private" comment is stale. |
| D5 | **Fetch SF photos BEFORE ending the ResQ visit, and attach them to `endVisit`.** | Proposed | Fixes the v1 ordering bug — v1 ends the visit with `images:[]` then can't push photos after. |
| D6 | **SF expenses auto-create a QBO vendor bill; the PAYMENT is approved in Brixpense.** | Confirmed | Sky chose "auto-create, pay via Brixpense." Automation captures the AP liability; a human still authorizes the money. |
| D7 | **Converge on ONE AP path.** SF-sourced bills flow into Brixpense's existing approval model (`expense-request-*` + `ops.expense_requests`), not a parallel pipeline. | Proposed | `expense-to-bill.mjs` and `expense-request-link-bill.mjs` already both create QBO bills; don't add a third. |
| D8 | **Hard idempotency on bill creation** keyed on `sf_expense_id` (or `sf_job_id`+line hash), recorded on `ops.resq_sf_links`. | Proposed | Auto-posting bills is the highest-risk change; duplicate AP is the worst failure. Idempotency + Brixpense gate are mandatory mitigations. |
| D9 | **Preserve the v1 crown jewels**: ResQ→SF create/dedup (`processNewWO`, `pickBestSfJob`, po_number join) and the 5-mutation SF→ResQ invoice flow (`buildAndSubmitInvoice`). Migrate, don't rewrite. | Proposed | They encode hard-won ResQ GraphQL knowledge; rewriting risks regressions for no benefit. |
| D10 | **Build order: P1 (identity map) first**, independent of the rest. | Confirmed | Smallest change, biggest correctness payoff, and a prerequisite for P5. |
| D11 | **ResQ auth failures become loud** (write `sync_events` + trigger health-alert) rather than silent. | Proposed | ResQ cookie/CSRF login is the fragile single point of failure; SF is OAuth-rotated. |
| D12 | **Plan-first**: PRD/scoping/decisions authored before code, per the architecture-handbook convention. | Confirmed | Sky chose "write the plan first." |

## Cross-repo / architecture-handbook impact (mirror to `Skilliosis_Mytosis_Architecture/ARCHITECTURE.md`)

This project introduces architecture-level changes that the handbook tracks:

- **New `ops.*` tables**: `ops.sync_customers`, `ops.resq_sf_links`,
  `ops.sync_events` — add to `apbg-billing/architecture/sync-manifest.json`
  (the build lint will otherwise fail) and to ARCHITECTURE.md's data inventory.
- **New ingress**: `sf-webhook.mjs` (a new external→us webhook from Service
  Fusion) — new env var category (`SF_WEBHOOK_SECRET` or reuse
  `INBOUND_EMAIL_SECRET`).
- **New cross-repo dependency**: `apbg-billing` reuses `brix-order`'s SF
  attachment mechanism (`sf-job-attachments` bucket, `orders.sf_portal_session`,
  the public-S3 resolver) — candidate to promote to a shared lib.
- **New cross-tool dependency**: SF sync now writes into the **Brixpense**
  approval queue (`ops.expense_requests`).

> ⚠ The architecture repo was **not in this session's GitHub scope**, so
> ARCHITECTURE.md was not updated automatically. Apply the change log row
> manually (or via the ASM MCP) when this plan is approved.
