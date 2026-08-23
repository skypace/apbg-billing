# AP Bill Inbox — `bills@alamedapointbg.com`

A general inbox for vendor bills. Forward one, or let a vendor mail it in
directly; it is read, coded, and queued in Brixpense for a human to post.

```
vendor invoice ──email/forward──▶ bills@alamedapointbg.com
                                            ▼
                            Resend inbound (email.received webhook)
                                            ▼
                   netlify/functions/bill-email-intake.mjs
                     1. Svix signature check (RESEND_AP_INBOX_SECRET)
                     2. Recipient must be the configured inbox
                     3. Drop auto-replies / bounces
                     4. Dedup on the Resend email id
                     5. Record ops.bill_email_intake, hand off
                                            ▼
             netlify/functions/bill-email-process-background.mjs
                     6. Read the attachment (Resend receiving API)
                     7. OCR it — lib/expense-ocr-core.mjs, the SAME
                        extractor human receipt uploads use
                     8. Store the PDF in the expense-attachments bucket
                     9. Land an UNPAID BILL DRAFT in ops.expense_requests
                        (as_bill=true, status='draft', tag='AP Inbox')
                    10. Email the AP notify list; acknowledge the sender
                                            ▼
        Brixpense → AP Inbox (/expense/bills, staff-only)
                    11. A HUMAN reviews it and clicks Post to QuickBooks
                        → expense-request-link-bill → the QBO Bill
```

## The one rule

**Nothing in this pipeline posts to QuickBooks.** That is the 2026-08-14 gate,
and this channel does not get an exception — the whole point of the address is
that people outside the company can mail it, and an email from outside must not
be able to create a QBO transaction. Every draft waits for an explicit
**Post to QuickBooks** click, which is also where QBO vendor matching and GL
coding actually happen.

That rule is what makes the open sender policy safe. `allow_senders` is empty by
default, because a vendor emailing us an invoice is the point; the worst a
stranger can do is put a row in a review queue.

## Failure is a status, never a silence

Every email lands a row in `ops.bill_email_intake` whatever happens to it, and
each failure is re-runnable from the queue ("Try again").

| Status | Means | Fix |
|---|---|---|
| `drafted` | Bill draft created, waiting for review | Review and post it |
| `received` / `processing` | In flight | Wait; it self-refreshes |
| `no_attachment` | The email genuinely had no readable file | Ask for the PDF, or key it in by hand |
| `attachment_fetch_failed` | Resend refused the attachment read | Read `diagnostics` — usually the API key |
| `ocr_failed` | Claude couldn't read the document | Open the PDF and fill the bill in |
| `sender_rejected` | Blocked by the sender rules | Adjust `block_senders` / `allow_senders` |
| `ignored` | Dismissed by staff | — |
| `failed` | Anything else, with the message | Read `status_detail` |

`no_attachment` and `attachment_fetch_failed` are deliberately **different
statuses**. They look identical from the outside and have completely different
fixes — one is the sender's problem, the other is ours. Collapsing them is
exactly how brix-order lost a purchase order for a day to a send-only Resend key
(session 1.111): the fetch helper swallowed the 401 and the queue read
"no attachment" while the PDF sat in Resend the whole time. Every failed Resend
read is now quoted verbatim into `diagnostics`, with the variable to set named.

## Configuration

`ops.expense_settings` key `ap_inbox` — editable from the app, no deploy:

```json
{
  "enabled": true,
  "inbox": "bills@alamedapointbg.com",
  "notify": ["service@brixbev.com"],
  "allow_senders": [],
  "block_senders": [],
  "ack_sender": true
}
```

- `allow_senders` — empty means anyone. Entries match a full address
  (`ar@vendor.com`) or a whole domain (`vendor.com`).
- `ack_sender` — send the sender a "we received your invoice" confirmation.
  It says plainly that it is not an approval or a payment.

## Environment (Netlify, apbg-billing, functions scope)

| Var | Required | Why |
|---|---|---|
| `RESEND_AP_INBOX_SECRET` | **yes** | This webhook's Svix signing secret. The intake fails closed (503) without it. May hold a comma-separated list, which is the only way to rotate. |
| `RESEND_INBOUND_API_KEY` | **yes** | A **FULL-ACCESS** Resend key. Reading inbound mail is a different permission from sending — a sending key 401s every attachment read. Kept separate from `RESEND_API_KEY` so breaking the reader can never take outbound invoices down. |
| `ANTHROPIC_API_KEY` | yes | Bill OCR. Already set. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Intake rows + attachment storage. Already set. |
| `AP_INBOX_SUBMITTER_ID` | no | Fallback submitter uuid when the sender is not an internal login. |

> ⚠ **Resend mints a separate signing secret per webhook endpoint**, shown once
> at creation and never retrievable afterwards. This route therefore **cannot**
> share `RESEND_INBOUND_SECRET` (which belongs to the vendor-email-intake
> route). The code falls back to it so a misconfigured site still runs, but
> signature verification will fail on every email unless the secrets match.

## Who the bill gets attributed to

`ops.expense_requests.submitted_by` is NOT NULL, so the processor resolves a
submitter in this order:

1. **The sender**, when their address is a real internal login — so a bill Joel
   forwards shows up as Joel's in Brixpense. This is what people expect when
   they ask whether a forwarded bill "goes back to the sender".
2. `AP_INBOX_SUBMITTER_ID`.
3. The most recent AP Inbox / Service Fusion row's submitter.

A vendor mailing in from outside falls to 2 or 3 and is labelled
"AP Inbox (email)". The *notifications* always go to the `notify` list, which is
the AP desk — not to whoever happened to forward it.

## Coexistence with the other inbound channels

Resend fires `email.received` for the **whole domain**, so every webhook on
`alamedapointbg.com` — `vendor-email-intake`, the brix-order Order Desk and EDI
routes, the melt ones — sees this mail too and ignores it by recipient. That is
the same arrangement the vendor routes have relied on since 2026-07-22. It also
means the per-endpoint signing secret is the only thing cryptographically
separating the channels, which is why this one has its own variable.

## Go-live checklist

1. ✅ Migration `20260823024339_bill_email_intake.sql` — **applied live**.
2. **Resend → Webhooks → Add**: endpoint
   `https://apbg-billing.netlify.app/.netlify/functions/bill-email-intake`,
   event `email.received`. **Copy the `whsec_…` shown at creation — it is not
   retrievable later.**
3. **Netlify env**: set `RESEND_AP_INBOX_SECRET` to that value and
   `RESEND_INBOUND_API_KEY` to a full-access Resend key. Read both back after
   writing — the Netlify MCP has silently dropped env writes before.
4. **Redeploy** (a functions-scope env change needs a deploy with real content;
   Netlify skips empty commits).
5. Brixpense → **AP Inbox** → **Check the intake**. It reports *armed*, not
   *verified* — see below.
6. Forward a real bill and confirm it lands.

> The check reports **armed**, not verified, on purpose. A 401 from the intake
> proves only that *some* secret is configured; a wrong secret answers
> identically. Only a real forwarded email proves the secret matches what Resend
> signs with. A check whose passing state is indistinguishable from a
> misconfiguration is worse than no check — it turns a visible gap into a false
> all-clear.

## Not built (deliberate)

**Paying the bills from here.** `ops.expense_requests` already carries
`payment_method` / `payment_reference` / `paid_at` / `qbo_billpayment_id`, and no
UI writes any of them today. Running an actual pay run — select approved bills,
cut the payment, write the QBO BillPayment — is a separate build on top of this
queue, not a side effect of it.
