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

## ⚠ There is no second pair of eyes on an emailed bill

With the approval gate off (the default), the person who emails a bill in is
the same person who posts it. The only thing standing between an inbound PDF
and a QuickBooks Bill is **one human clicking Post to QuickBooks** — which is a
real check, because they see the OCR beside the original document, but it is
not separation of duties and should not be described as one.

Two knobs if that ever needs to change, neither requiring a deploy:

- `sender_routes` — point one person's bills at somebody else, so the poster
  and the sender differ.
- `require_approval: true` — reinstate an explicit approval before posting.
  (When both are on, `expense-request-decide`'s self-approval block stays open
  only for `tag='AP Inbox'` expense rows, and a self-review is stamped into
  `approved_by` as `"<email> (own emailed bill)"` rather than hidden.)

## The approval gate — OFF by default

`require_approval` ships **false** (Sky, 2026-08-23: *"it doesn't need approval"*).

Routing still does all the work that was asked for — the bill is **owned by,
notified to, and visible to** the right person — it just lands ready to post
rather than waiting on a click that, in the common case of a sender owning
their own bill, only they were going to make anyway.

| `require_approval` | Owned bill lands as | Who sees it | Can post? |
|---|---|---|---|
| **false** (default) | `approved` | the owner's **Previous Expenses** (`/expense/pending`), which already has a Post to QuickBooks button for approved+unposted expenses | immediately |
| `true` | `pending` | the owner's **Approvals** queue (`/expense/queue`) | only after they approve |

Unassigned mail lands `draft` in the AP Inbox either way.

`approved` here is the **same auto-approve every other Brixpense expense gets
on submit** — not a rubber stamp of a human decision. `approved_by` records
`system (AP inbox — no approval required)` so the row says so plainly.

**Nothing about the QuickBooks gate changes.** Posting is still an explicit
human **Post to QuickBooks** click (the 2026-08-14 rule) — the approval flag
only decides whether a *second* click has to happen first.

Turning it back on needs no deploy: flip `require_approval` in
`ops.expense_settings.ap_inbox`. The approval machinery stays wired
(`expense-request-decide`'s narrow self-approval exception, the Approve button,
the Waiting-on-you filters), it is simply dormant.

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
| `drafted` | Bill created and routed | The owner reviews it and posts it |
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

  "require_approval": false,
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
- `require_approval` — **false** by default. `true` makes posting wait for an explicit approval.

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
posted to QuickBooks → paid** — with an approval step in the middle only if
`require_approval` is switched on.

---

## The watcher

The AP inbox is **event-driven**, so the usual "no run in N hours" heartbeat
means nothing here — a quiet day is a quiet day, and colouring on it would flap
exactly the way the `sf_token` check did before 2026-08-06. What is genuinely
broken is an email we **accepted and then failed to finish**: the webhook
recorded the row, the background processor never completed it, and a real vendor
invoice sits in a table nobody opens.

`ops.fn_ap_inbox_health()` (wired into `ops.fn_sync_health_extra()`, which the
15-minute `health-alert` cron emails on red/yellow) reads it that way:

| | |
|---|---|
| **red** | mail accepted but still `received`/`processing` after 30 min, or a processor run logged `error` in the last 24h |
| **yellow** | mail we could not read (`no_attachment` / `attachment_fetch_failed` / `ocr_failed` / `failed`) that has **no expense request and has not been dismissed** |
| **green** | everything else, with the count drafted in the last 24h |

Yellow counts only **unresolved** held mail, so dismissing a row from the queue
clears the light. A permanent amber is a light people stop reading.

`bill-email-process-background` writes `ops.sync_log` (`source: 'brixpense'`,
`sync_type: 'ap_inbox'`) on every run **that had work** — an empty sweep is not
an event and logging one would make the last-run timestamp meaningless.

> ⚠ Zero mail ever received reads **green**, with the detail saying so. Postgres
> cannot tell "nobody has emailed a bill yet" from "the Resend webhook was never
> pointed here", so it states the ambiguity rather than picking a colour.

## Duplicate bills

The only dedup used to be on the Resend email id, which catches a webhook replay
and nothing else. The duplicate that costs money arrives by a **second road**:
the vendor re-sends "just in case", or emails it AND someone photographs it, or
a Service Fusion job expense and an emailed bill describe one purchase. Every
one of those has a different email id.

`ops.fn_bill_duplicate_candidates` holds the rules, so the automated and human
paths cannot drift:

- **exact** — same vendor, same bill number. That is the same invoice.
- **likely** — same vendor, same amount, within ten days, and no bill number to
  separate them — *unless both rows carry a job number and the job numbers
  differ*, which proves it is different work.

Deliberately **not a unique constraint**. A hard constraint would reject the
legitimate cases too (a corrected re-issue, a vendor who restarts numbering each
year, an OCR misread a human is about to fix) and a pipeline that throws on
insert loses the document. Hold it, say why, let a human decide.

Where it bites:

| Where | What happens |
|---|---|
| Intake (`bill-email-process-background`) | Stamps `duplicate_of` + `duplicate_reason`. An **exact** match drops an otherwise-auto-approved bill back to `draft`, so it cannot be one click from a QBO Bill. Clearable the same way a held OCR row is: open it, Submit, it re-approves. |
| Posting (`expense-request-link-bill`) | Re-checked here, because the row may have sat for days and the twin may have arrived since. An exact match **whose twin is already in QuickBooks** refuses with `409 possible_duplicate`; the client asks, and `confirmDuplicate: true` is recorded in `duplicate_cleared_by`, not just obeyed. Two *unposted* drafts are a tidiness problem, not a money problem, and refusing both would be the pipeline arguing with itself. |

**Validated against live data before shipping.** Replayed over every expense on
file, the amount rule produced three clusters and the job-number discriminator
sorted them correctly:

| Vendor | Amount | Rows | Jobs | Verdict |
|---|---|---|---|---|
| ARTURO SANTIAGO | $375.00 | 2 | 1 | **real** — QBO Bills 173048 + 173049, the pair recorded on 2026-08-14 |
| DESERT BEVERAGE | $133.90 | 2 | 2 | two distinct calls |
| ERIC SERRANO | $170.00 | 2 | 2 | two distinct calls |

A flat-rate contractor bills the same number over and over, so amount alone is a
weak signal; the job number is what makes the flag worth reading.

## Due dates and aging

`ops.expense_requests` had no due date at all, so Brixpense could hold an unpaid
vendor bill indefinitely with nothing anywhere saying it was late. QuickBooks
knows once the bill is posted — the window this covers is the one **before**
that, where the bill is ours and invisible.

- OCR now extracts `due_date` and `payment_terms` **separately**, reporting only
  what is printed. It never derives one from the other; that arithmetic happens
  downstream where the invoice date is certain.
- A **printed** date always beats one computed from terms. `due_date_source`
  records which we had (`printed` | `terms` | `manual`).
- `ops.v_ap_aging` (security_invoker, so RLS decides who sees whose payables)
  buckets unpaid bills: `current` · `1-30` · `31-60` · `61-90` · `90+` ·
  `no due date`.

> ⚠ **Three copies of the terms→date logic exist** — `ops.fn_due_date_from_terms`
> (backfills history), `netlify/functions/lib/due-date.mjs` (stamps bills as they
> arrive) and `app-expense/src/lib/dueDate.ts` (fills the field while you type).
> `tests/due-date.test.mjs` pins them to one table of cases; **add a case there
> before changing any of them.** The first version of all three shared a bug:
> `2/10 Net 30` read the discount percent as the term and made the bill due two
> days after the invoice date — instantly and permanently overdue. They now
> prefer the number after `net`.

Anything unrecognised returns **null**, not a guess. A wrong due date is worse
than none: no date shows as "no due date" and gets looked at, whereas a wrong one
turns a genuinely overdue bill green.
