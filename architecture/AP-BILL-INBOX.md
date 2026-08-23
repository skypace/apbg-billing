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
                     9. Land an UNPAID BILL in ops.expense_requests
                        (as_bill=true, tag='AP Inbox'; 'pending' once
                         routed, 'draft' when nobody matched)
                    10. Route it to an owner's approval queue; email them
                                            ▼
        the owner approves — /expense/queue, or /expense/bills for staff
                                            ▼
                    11. Post to QuickBooks (unlocked by the approval)
                        → expense-request-link-bill → the QBO Bill
```

## Whose queue it lands in

`resolveBillRouting()` in `lib/ap-inbox.mjs`. First match wins, and every answer
carries the reason, so the queue can say *why* a bill went where it went.

| # | Rule | Used for |
|---|---|---|
| 1 | `sender_routes[sender]` | Explicit override — point one person's bills at somebody else |
| 2 | **the sender**, if they are an internal Brixpense login | The normal case: your bill, your queue |
| 3 | `vendor_routes` matched against the OCR'd vendor | Vendor mail — whoever owns that spend |
| 4 | `department_approvers` matched against the OCR'd GL account | Vendor mail with no vendor rule |
| 5 | `default_approver` | The catch-all, so an invoice can't sit unowned |
| 6 | *unassigned* | Nothing matched — held in the AP Inbox for staff to assign |

Rung 6 is the floor on purpose. `default_approver` ships **NULL**: inventing one
would quietly make a single person responsible for every invoice a stranger
sends us, and a visible pile beats a wrong owner.

Rung 2 is only reached for a login that actually has **Brixpense access**
(`hasBrixpenseAccess()`, mirroring the gateway's `billing` bucket). The Supabase
project is shared — brix-order customers and distributor partners have logins
here too — so matching on "is a login" alone would hand a customer's invoice a
staff owner and a spot in an approval queue.

## ⚠ Rung 2 is a review gate, not separation of duties

When the bill routes back to its sender, **the sender approves their own bill**.
That is worth something real — it forces a human to check the OCR against the
actual document before it can become a QBO transaction — but it is not a second
pair of eyes, and it should not be described as one.

`expense-request-decide` blocks self-approval for everything else and keeps
doing so; the exception is scoped to `tag='AP Inbox'` expense rows, and a
self-review is stamped into `approved_by` as `"<email> (own emailed bill)"`
rather than hidden.

**Want real separation of duties?** Put the sender in `sender_routes` pointing
at somebody else. No rebuild needed.

## The approval gate

`require_approval` (default **on**) means a routed bill lands as `status='pending'`
and **Post to QuickBooks stays disabled until it is approved**. Two surfaces:

- **`/expense/queue`** — the existing Approvals queue. It selects on
  `(manager_email, status='pending')` regardless of request type, so an emailed
  bill shows up there next to the purchase requests with no change to that page.
  This is the path for an owner who is not AP staff; RLS
  (`expense_requests_select` on `manager_email`) makes the row theirs to see and
  update.
- **`/expense/bills`** — the AP desk's oversight view (superadmin/admin, matching
  `ops.fn_is_staff()`). Approve is offered only to the person the bill is waiting
  on, so it can't be quietly cleared by whoever opened the page.

Turning `require_approval` off makes the approval advisory: bills still route,
but AP can post without waiting.

## The one rule

**Nothing in this pipeline posts to QuickBooks.** That is the 2026-08-14 gate,
and this channel does not get an exception — the whole point of the address is
that people outside the company can mail it, and an email from outside must not
be able to create a QBO transaction. Every bill waits for an approval **and** an
explicit **Post to QuickBooks** click — the latter is also where QBO vendor
matching and GL coding actually happen.

That rule is what makes the open sender policy safe. `allow_senders` is empty by
default, because a vendor emailing us an invoice is the point; the worst a
stranger can do is put a row in a review queue.

## Failure is a status, never a silence

Every email lands a row in `ops.bill_email_intake` whatever happens to it, and
each failure is re-runnable from the queue ("Try again").

| Status | Means | Fix |
|---|---|---|
| `drafted` | Bill created and routed | The owner approves, then it posts |
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
  "ack_sender": true,

  "require_approval": true,
  "default_approver": null,
  "sender_routes":        { "joel@brixbev.com": "anthonyv@brixbev.com" },
  "vendor_routes":        { "pro mechanical":   "anthonyv@brixbev.com" },
  "department_approvers": { "service":          "anthonyv@brixbev.com" }
}
```

- `allow_senders` — empty means anyone. Entries match a full address
  (`ar@vendor.com`) or a whole domain (`vendor.com`).
- `ack_sender` — send the sender a "we received your invoice" confirmation.
  It says plainly that it is not an approval or a payment.
- `sender_routes` / `vendor_routes` / `department_approvers` — the routing
  ladder above. Keys are matched lowercase; vendor and department keys match as
  substrings of the OCR'd vendor name / GL account label.
- `require_approval` — whether approval gates posting.

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

## Paying them

Vendor Portal Phase 3 (`vendor-pay.mjs` + `PayBillPanel`) landed on main while
this was in flight, and it pays any POSTED `ops.expense_requests` row — which is
exactly what an AP-inbox bill becomes. So the panel is mounted here too:

- **Pay** appears on a posted bill with no payment recorded (superadmin only —
  `/api/vendor-pay` refuses everyone else, so the trigger is hidden rather than
  left to 403).
- Bills already paid show the rail they went out on.
- The **Awaiting payment** filter is the pay-run list: posted to QuickBooks,
  no payment recorded.

The full lifecycle of an emailed bill is therefore: **arrives → OCR'd → routed →
approved → posted to QuickBooks → paid**, each step a deliberate human click
after the first.
