# Vendor Email → Service Fusion Ticket Automation

Red Bull and Freshpet service emails become Service Fusion jobs automatically,
and the send list gets an email every time the SF job's status changes.
**Fully event-driven — no crons.**

## Flow

```
Red Bull email ──forward──▶ rbfreeflow@alamedapointbg.com ─┐
Freshpet email ──forward──▶ freshpet@alamedapointbg.com  ──┤
                                                           ▼
                                    Resend inbound (email.received webhook)
                                                           ▼
                            netlify/functions/vendor-email-intake.mjs
                              1. Svix signature check (RESEND_INBOUND_SECRET)
                              2. Route by recipient (ops.vendor_email_routes)
                              3. Parse: Red Bull reactive WOs are parsed
                                 DETERMINISTICALLY (stable labeled format);
                                 Claude is the fallback + the other vendors
                              4. SF job payload built per the route's mapping
                              5. CONFIRM GATE (route.require_confirmation,
                                 default ON): send list gets the parsed
                                 summary + WO preview with ✓ Create / ✕
                                 Decline links (single-use token). The SF job
                                 is only created when someone clicks Create.
                              6. Ticket recorded (ops.vendor_email_tickets)
                              7. "Ticket created" email → route.send_list

Red Bull SF-job mapping (per Sky, 2026-07-22):
  Customer    = FF REDBULL SERVICE (sub-customer). SF derives the master
                (FREEFLOW BEVERAGE SOLUTIONS) from the customer record itself —
                sending parent_customer on POST /jobs 422s (verified live), so
                the intake does NOT send it. Billing rolls to the master via
                the customer record ("Invoice sub customer" unchecked).
  PO number   = "ZD <zendesk #> / SF <vendor's SF job #>"
  Description = ISSUE REPORTED + DESCRIPTION call-log + LOCATION CONTACT +
                ZENDESK LINK + LOCATION DETAILS + NTE lines (verbatim blocks)
  Job notes   = MANUFACTURE DATE · SERVICE YEARS · ZENDESK TICKET LINK
  Plus structured job location (location_name/street_1/city/state_prov/
  postal_code) + contact_first_name so dispatch sees the real site.
  Status Unscheduled.

Accept / Decline / update audiences:
  - Pending-confirmation email → route.send_list (internal; service@brixbev.com).
  - ✓ Create → SF job created; ACCEPTANCE email ("accepted and received —
    you will receive updates through completion and billing") → the original
    submitter + route.vendor_notify_list (Red Bull: cokraska@freeflowbev.com).
  - ✕ Decline → reason picker page (territory / NTE / equipment / duplicate /
    access / other + notes); recorded on the ticket; decline email → the same
    vendor recipients + the internal send list.
  - SF status changes (via sf-status@) → vendor recipients + internal send
    list, every transition, all the way through billing statuses.

SF job status changes ──SF notification email──▶ sf-status@alamedapointbg.com
                                                           ▼
                                     same webhook, status branch:
                              1. Parse job # + new status (regex, Claude fallback)
                              2. Match ops.vendor_email_tickets by sf_job_number
                                 (non-vendor jobs are ignored silently)
                              3. Event logged (ops.vendor_ticket_events)
                              4. Status-update email → route.send_list
```

Status updates work without polling because **Service Fusion itself sends the
event**: SF's notification emails, pointed at `sf-status@alamedapointbg.com`,
are the trigger. SF has no API webhooks — this is the only event-driven
signal it offers.

## Tables (`ops.*`, migration `20260722a_vendor_email_tickets.sql`)

| Table | Purpose |
|---|---|
| `vendor_email_routes` | One row per inbound address: vendor, SF customer, SF category, send list, parser hints. Seeded with the two live routes. |
| `vendor_email_tickets` | One row per processed email (deduped on Resend email id): raw text, parsed JSON, SF job id/number, status, last SF status. |
| `vendor_ticket_events` | Append-only log of relayed status changes + who was notified. |

All service-role only (RLS enabled, no anon policies). Writer registered in
`sync-manifest.json` as `vendor-email-intake`.

## Go-live checklist

1. **Apply the migration** (`supabase/migrations/20260722a_vendor_email_tickets.sql`)
   to the live project (`gfsdpwiqzshhexkofiif`).
2. **Resend — enable receiving** on `alamedapointbg.com` (Domains → the MX
   record Resend shows for inbound). Sending is already verified; receiving
   needs the MX.
3. **Resend — create the webhook**: endpoint
   `https://apbg-billing.netlify.app/.netlify/functions/vendor-email-intake`,
   event `email.received`. Copy its **signing secret** (`whsec_…`).
4. **Netlify env** (apbg-billing site, functions scope):
   - `RESEND_INBOUND_SECRET` = the signing secret from step 3 (required — the
     function 503s without it and 401s bad signatures).
   - `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` —
     already set on this site.
   - Optional: `VENDOR_INTAKE_MODEL` (default `claude-sonnet-5`),
     `VENDOR_STATUS_INBOX` (default `sf-status@alamedapointbg.com`).
5. **Set the SF customer per route** (jobs can't be created until this is set;
   until then emails are recorded as `needs_route_config` and the send list is
   alerted):
   ```sql
   update ops.vendor_email_routes set sf_customer_name = '<EXACT SF CUSTOMER NAME>'
   where inbox = 'rbfreeflow@alamedapointbg.com';
   update ops.vendor_email_routes set sf_customer_name = '<EXACT SF CUSTOMER NAME>'
   where inbox = 'freshpet@alamedapointbg.com';
   ```
6. **Set the send lists** (default `{service@brixbev.com}`):
   ```sql
   update ops.vendor_email_routes
   set send_list = '{service@brixbev.com,someone@brixbev.com}'
   where inbox = 'freshpet@alamedapointbg.com';
   ```
7. **SF Settings → Job Categories**: confirm `Service Call` exists (or set a
   different `sf_job_category` per route). Unknown categories are retried
   without — the ticket is never lost, but tagging silently drops.
8. **SF Settings → Notifications**: add a job status-change email notification
   to `sf-status@alamedapointbg.com`. This is the status-update trigger — no
   SF notification, no status relays.
9. **Forwarding**: set the Red Bull and Freshpet source inboxes to forward to
   their respective `@alamedapointbg.com` addresses.
10. **Test**: forward a real Red Bull email → confirm the SF job + the
    "ticket created" email; change the job's status in SF → confirm the
    status-update email.

## Failure behavior

- **Unparseable email** → ticket still created with the subject as the issue
  summary (parse never blocks the SF job).
- **SF create fails** → ticket recorded `sf_failed`, send list alerted with
  the error; re-forward the email after fixing (dedup is per Resend email id,
  so a re-forward is a fresh id).
- **Route missing `sf_customer_name`** → `needs_route_config` + alert.
- **Status email for a non-vendor job** → ignored silently (SF notifies for
  every job; only vendor-email tickets are relayed).
- **Send-list email fails** → logged, never undoes the ticket/event.
- **Infra blip (Supabase/SF token)** → 500 → Resend retries the webhook;
  dedup makes retries safe.
