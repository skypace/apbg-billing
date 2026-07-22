# SOP-6 · Service, Maintenance Windows & Incident Response

> Part II · SOP Manual · Owner: Sky Pace · Last reviewed: 2026-07-22

This SOP covers three related operational muscles: handling customer service requests, announcing planned maintenance to app users, and responding when something breaks. It's for service ops, superadmins, and anyone on call when a health dot goes red.

## Customer service requests

### Policy

- Every service request — however it arrives — must end up as a **Service Fusion job with the correct category** and a notification to **service@brixbev.com**. No side channels, no "I'll just call the tech."
- Intake channels all feed the same pipeline: the portal service-request form, Mr. Bubbles (portal chat), and Chloe on the AI phone line (510) 800-6281 all file through the shared create-ticket path; staff taking a call or email file it in the portal on the customer's behalf.
- SF job categories are fixed: `equipment_issue` → **Service Call**, `refill` → **Product Delivery**, `scheduling`/`other` → **Service Call**. These categories must exist in SF Settings → Job Categories. *Why: the original push mapped to categories that don't exist in SF ('Equipment Service', 'Refill', …) — SF 422s unknown categories, so even the manual push button was silently broken until 2026-07-19 (session 1.71).*

### Procedure

1. The request is filed (portal / bot / staff-entered). The system inserts the ticket, **auto-pushes the SF job inline**, and emails service@brixbev.com.
2. Check the notification email: "✓ Already in Service Fusion as Job #N" means done — schedule and dispatch in SF as normal.
3. If the auto-push failed, the email instead carries a signed **Push to Service Fusion** retry button — click it. (The push is idempotent on `sf_job_id`; it will not create duplicates.)
4. If the retry also fails, treat it as an incident (SF token or API-shape problem — see below). The ticket row is preserved regardless.

## Planned maintenance windows

### Policy

- Any planned work that degrades or takes down an app is announced **before** it starts, via **Master Control → Service & Maintenance** (https://alamedapointbg.com/control): a **banner** for degraded service, a full **lockout** for down, always with a service note saying what's happening and when it ends.
- The setting is per-app (or the global `all` key) and is written via the gateway `POST /api/maintenance` (superadmin only); every app renders it through the embedded `appswitcher.js`. A lockout shows even to logged-out users; superadmins get a "Dismiss (admin)" bypass so they can work during the window.
- **Take the banner/lockout OFF as soon as the work is done.** A stale maintenance flag is itself an incident — users can't tell a forgotten banner from a real outage.

### Procedure

1. Open https://alamedapointbg.com/control → **Service & Maintenance** (superadmin).
2. Pick the app (or `all`), choose **banner** or **lockout**, write the note (what + expected end time). Save.
3. Verify the target app shows it (any non-superadmin session, or dismiss-check as admin).
4. Do the work.
5. Return to Master Control and set the mode back to **off**. Verify.

## Incident response

> **Draft policy — proposed 2026-07-22, pending owner approval.** Structure below is grounded in incidents actually worked (sessions 1.18, 1.26, 1.61 in brix-order; the 2026-06-29 SF token failure; the Melt/Starbird linked-customer outage) — the sequence is proposed as the standing playbook.

### Detect

Signals, in the order they usually arrive:

- **Health dots** on the gateway hub (https://alamedapointbg.com) — driven by `health-watchdog` + `pacer-health`; superadmin-only.
- **Master Control** health/status panels at https://alamedapointbg.com/control.
- **Alert emails** to service@brixbev.com (audit approvals, payment returns, sync alerts).
- **User reports** ("my order won't submit", "no email arrived").

### Diagnose

1. Check the Master Control health grid and the ResQ Sync live status.
2. Pull **Netlify function logs** for the affected site (e.g. https://app.netlify.com/projects/brix-order/logs/functions) — most root causes surface there as a single log line.
3. Check **Supabase logs** for the shared project (`gfsdpwiqzshhexkofiif`) if the failure smells like the database or an edge function.
4. Match against the known failure classes below before inventing a new theory.

### Known failure classes and their fixes

| Symptom class | Likely cause | Fix |
|---|---|---|
| SF or QBO calls failing with auth errors; sync stalled | **Expired/invalid OAuth token.** The shared SF refresh token in `ops.sf_token_cache` failed with `Invalid refresh_token` from 2026-06-29 and took the ResQ↔SF sync down until re-auth. | Re-authenticate at https://alamedapointbg.com/billing/setup.html (QBO + SF OAuth setup). Never edit the token cache tables directly — lease RPCs only. |
| Supabase returning 5xx | **Upstream Supabase outage**, not a token problem — the auth helper deliberately distinguishes 5xx from auth failures so you don't burn time re-authing. | Check Supabase status/dashboard; wait it out or escalate to Supabase. |
| SF rejects a previously-working payload with 422 | **SF changed its API shape.** It has done this twice: fee lines as products broke every order for two weeks (1.18), and the customers-create payload shape changed under us (1.26); SF also removed `/items` entirely. | Check the current official spec at https://docs.servicefusion.com/api.json before changing code. Also remember the account rule: always pass an explicit `sort` on `GET /jobs` (default sort hangs). |
| Emails not arriving | Provider-side failure or a code bug swallowing the send. | Open the **Resend dashboard first** (https://resend.com/emails) — actual send/bounce log — then Netlify function logs for the sender. |
| Sudden flood of alert emails | **First-run backfill of a newly-credentialed integration.** The first B&P returns sync blasted 54 alert emails for 2022–2026 historical bounces (1.61). | Don't panic-disable; verify they're historical, bulk-acknowledge, and add/verify an age guard (the returns sync now auto-clears returns older than 14 days). Expect a backlog whenever new credentials light up an integration. |
| ResQ WOs silently not syncing to SF | **Unlinked facility** — a WO whose facility matches no row in `ops.sync_customers` is skipped, no SF job. | Link it in Master Control → **Linked Customers** (see below). |

### Communicate

- If customers or staff are affected, put up a **banner** (or lockout) via Service & Maintenance with an honest note — same mechanism as planned maintenance.
- For customer-specific fallout (missed emails, stuck orders), use the existing resend/retry admin tools rather than ad-hoc promises.

### Post-mortem

- Every incident gets a dated entry in the owning repo's `CLAUDE.md` change log: symptom, root cause, fix, and any new standing rule. *Why: the change logs are the institutional memory — every failure class in the table above is findable there, and this handbook is rebuilt from them.*
- If the incident changed architecture (new service, new env var category, new dependency), update `Skilliosis_Mytosis_Architecture/ARCHITECTURE.md` in the same change (see [SOP-9](#/29-sop-data-engineering)).

## ResQ sync operations

The ResQ ↔ Service Fusion sync runs as Supabase edge functions in `skypace/apbg-resq-sync` on a 15-minute pg_cron, operated entirely from **Master Control → ResQ Sync**.

### Policy

- **Write mode** vs read-only and **Sync enabled** are the two switches. Read-only lets the sync observe without creating SF jobs — use it when diagnosing; write mode is the normal state.
- A facility must be linked in **Linked Customers** (`ops.sync_customers`) before its WOs sync — unlinked facilities are skipped with no SF job. *Why: the Melt/Starbird "matched no SF customer" outage traced to a seeded row that had dropped a colon from the SF name, and a broad `BRIX WAREHOUSE EQUIPMENT` keyword hijacking matches — linking is now by SF record id, via the live SF search in the panel.*

### Procedure (routine checks and interventions)

1. Open https://alamedapointbg.com/control → **ResQ Sync**. Check live status.
2. To push one work order through immediately: use **drive a WO** with its ResQ code.
3. To force a full pass: **run a tick** (the cron remains the safety-net reconciler).
4. Onboarding a new facility: **Linked Customers** → search the live SF customer → link the row (or enter the SF # manually).
5. If jobs aren't being created at all, check the switches first, then the SF token class of failure above.

## Related

- [Master Control](#/09-master-control) — the panel all of this runs from
- [SOP-3 · Orders & Fulfillment](#/23-sop-orders-fulfillment) — order-side SF failure handling
- [SOP-9 · Data & Engineering](#/29-sop-data-engineering) — token-cache rules, architecture-handbook updates
- [APBG Gateway](#/01-gateway-hub) — health dots, appswitcher, maintenance rendering
- Source: `apbg-billing/CLAUDE.md` (control panel + ResQ sync entries)
- Source: `apbg-gateway/CLAUDE.md` (app_maintenance table + /api/maintenance)
- Source: `brix-order/CLAUDE.md` sessions 1.18, 1.26, 1.61, 1.71
