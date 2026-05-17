# Brixpense — User Guide

> **Live URL:** `alamedapointbg.com/expense/`
> **This guide:** `alamedapointbg.com/expense/docs/brixpense/`
> **Editable source:** `apbg-billing/docs/brixpense/user-guide.md` on GitHub. The viewer fetches this file at runtime — edit it, push, and the guide updates on the next Netlify deploy.

Brixpense is the internal app for submitting receipts and purchase requests, getting approvals, and pushing approved purchases into QuickBooks as Bills. It's the same Supabase login you use for everything else on alamedapointbg.

There are two kinds of submissions:

| Type | When to use it | What happens |
|---|---|---|
| **Expense** | You already paid for it — submitting a receipt so we can record the cost and reimburse you if needed. | Auto-approved on submit. Posted to QuickBooks as a Purchase right away. No email goes to anyone. |
| **Purchase Request (PR)** | You want to buy something but haven't yet — you need pre-approval. | Routes to an approver you pick from a dropdown. They get an email + see it in their queue. Once approved, you come back, click **Log Receipt**, and it becomes a real expense in QuickBooks. |

---

## Getting started

### Sign in

1. Open **alamedapointbg.com/expense/**.
2. Email + password — same login as Margin Control and the gateway.
3. You'll land on the home screen with two big buttons: **New Expense** and **New Purchase Request**.

If your email isn't recognized, ask Sky or Whitney to add you in the admin panel.

### Sidebar (left)

- **Home** — landing screen
- **New** — start an expense or PR
- **Pending** — your in-flight submissions (PRs awaiting approval, expenses still processing)
- **History** — everything you've ever submitted
- **Queue** — *(approvers only)* — purchase requests waiting on you
- **Settings** — *(admins only)* — manager allowlist, payment accounts, tags, COGS accounts

---

## Submitting an expense (you already paid)

**Use this when:** you bought something, you have the receipt, and you want it on the books.

### Step-by-step

1. Click **New Expense** from the home screen.
2. **Snap the receipt.** Phone camera, drag-and-drop, or file upload — all work.
3. Brixpense runs the receipt through **OCR** (Claude API) and pre-fills:
   - Vendor name
   - Total amount
   - Date
   - Line items if visible
4. Check the auto-filled fields. Edit anything that looks wrong.
5. **Entity** — `Brix / Alameda Soda`, `FreeFlow`, or `Shared`. This determines which legal entity owns the expense.
6. **Department** — filtered based on entity (e.g. FreeFlow gets `service` / `reman` / `ops` / `freeflow`; Brix gets `delivery` / `service` / `ops` / `melt`).
7. **COGS / expense account** — what bucket this hits in QuickBooks. The dropdown sorts the most likely accounts first based on the department you picked.
8. **Paid with** — which payment account (credit card, bank, petty cash) you used.
9. **Submit.**

The expense auto-approves and gets posted to QuickBooks as a Purchase within seconds. You'll see a success toast. No email goes to anyone.

### Where it shows up

- Your **History** page — under "Expenses, auto-approved."
- QuickBooks — as a Purchase transaction with the receipt attached as an attachment (visible on the QBO record).
- `ops.expense_requests` in Supabase — `status='posted'`, `decided_by='system (auto-approve)'`.

---

## Submitting a purchase request (you need pre-approval)

**Use this when:** you want to buy something and need someone with budget authority to sign off first.

### Step-by-step

1. Click **New Purchase Request** from the home screen.
2. Fill in:
   - **Vendor** — who you'd be paying
   - **Estimated total** — your best guess
   - **What you're buying** — line items, descriptions, why
   - **Entity / Department / COGS** — same as for an expense
3. **Approver** — pick one from the dropdown. This list is the **manager allowlist** from `ops.expense_settings.manager_emails`. Whoever you pick gets:
   - An email with a link to `/expense/queue`
   - A row in their personal Queue page
4. **Submit.**

You'll see your request on the **Pending** page with status `pending`. You can't approve your own PR — that's enforced both in the UI and in the database.

### What happens next

The approver gets an email and signs into Brixpense. They see your PR in their **Queue** with a Review button.

If they **approve** — your PR moves to `awaiting_invoice`. You'll get notified, and the row on your **Pending** page now shows a **Log Receipt** button (see "After your PR is approved" below).

If they **deny** — your PR moves to `denied`. You'll get an email with their note explaining why.

---

## For approvers: reviewing a purchase request

**You're an approver if** your email is in `ops.expense_settings.manager_emails`. If it isn't and you think it should be, ask Sky.

### The Queue page

`/expense/queue` lists every PR awaiting your decision. Each row shows submitter, vendor, total, date, and a **Review** button.

### The Review screen

`/expense/review/:id` opens the full PR:

- Submitter, vendor, total, line items, memo
- Receipt preview (if attached)
- Entity / Department / COGS routing
- **Approve** and **Deny** buttons + a notes textbox
- Optional **Signature** capture

### Approve

Click **Approve**. The PR flips to `awaiting_invoice` and the submitter gets notified. No QBO posting happens yet — Brixpense holds the PR until the submitter logs the actual receipt (see next section).

### Deny

Type a note explaining why, then click **Deny**. The submitter gets an email with your note. The PR is final at this point; if they want to resubmit, they need to start fresh.

### Guardrails

- You **cannot approve your own PR** — the API rejects it with `403 self_approval_forbidden`.
- You **must be in the allowlist** — the API checks `lower(caller.email) == lower(manager_email)` against the chosen approver. RLS enforces the same.
- No magic-link tokens, no anonymous approval path — approvers always sign in.

---

## After your PR is approved: Log Receipt

**Use this when:** an approved PR is `awaiting_invoice` and you've now actually purchased the thing. Closes the requisition→bill loop without forcing POs.

### How to find it

The **Pending** page shows your approved PRs in the `awaiting_invoice` status. Each one has a **Log Receipt** button on the right.

### What clicking Log Receipt does

Opens the New Expense form, **pre-filled from the PR** — vendor, total, COGS, department, customer, job, tag, memo, even line items. You snap the actual receipt, tweak any final numbers that differ from the original estimate, and submit.

The new expense gets:
- A `linked_pr_id` pointing back at the original PR
- The QuickBooks Purchase PrivateNote prepended with `PR approved by <name> on <date> | linked PR: <short>` so auditors can trace the chain

And the original PR row gets flipped to `status='fulfilled'` so it stops showing in your Pending list.

---

## History

Everything you've ever submitted, newest first. Filter by status (draft / pending / approved / denied / awaiting_invoice / fulfilled / posted), date range, or vendor.

Click any row to open the detail page. From there you can re-open it as a new expense (useful for recurring vendors), see the QBO Purchase if posted, or download the receipt attachment.

---

## Tips & shortcuts

- **Mobile-first.** Snap a receipt on your phone right after a purchase. It takes less than a minute end-to-end.
- **Receipt OCR isn't perfect.** Always glance over the auto-filled fields before submitting. Vendor and total are usually right; line items can drift.
- **Multiple receipts on one expense.** Drop additional files in the receipt area before submitting. They all attach to the same Brixpense row and the QBO Purchase.
- **Resubmit a denied PR.** Open it from History → click "Duplicate as new PR." Pre-fills everything; you just change what you need and pick a fresh approver.
- **Tax / no-tax line items.** Brixpense doesn't track tax separately by default — if you need a line broken out, add a second line item for the tax portion (vendor field "Sales tax").

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| OCR didn't fill anything in | Receipt photo was blurry or skewed | Re-take the photo. Bright, flat, the whole receipt in frame. |
| Approver dropdown is empty | Your role doesn't have access to the allowlist, OR `ops.expense_settings.manager_emails` hasn't been seeded | Ask Sky to seed `manager_emails` in `ops.expense_settings` |
| "You cannot approve your own request" | Self-approval is blocked at the API + RLS | Pick a different approver, or have someone else approve |
| PR stuck on `pending` | Approver hasn't acted, or their email bounced | Ping them directly, or ask Sky to reassign in `ops.expense_requests` |
| Submitted PR but Log Receipt button doesn't show | PR is still `pending` or `denied` — the button only appears on `awaiting_invoice` rows | Wait for approval, or open the PR in History to see its current status |
| QBO Purchase wasn't created after auto-approve | Vendor name didn't match any QBO vendor (or QBO API was throttling) | Open the row in History, check the error in the audit log. Usually the fix is creating the vendor in QBO and re-running the post via the admin Master Control panel. |
| Login loops | Browser blocked Supabase third-party cookies | Allow cookies for `gfsdpwiqzshhexkofiif.supabase.co` |

If you hit something not on this list, message Sky on Slack with a screenshot of the row + the URL.

---

## How the plumbing works (for the curious)

| Component | Lives at |
|---|---|
| Brixpense React SPA | `apbg-billing/app-expense/` → built into `public/expense/` → served at `/expense/` |
| Supabase tables | `ops.expense_requests`, `ops.expense_request_attachments`, `ops.expense_request_approvals`, `ops.expense_settings` |
| Receipt OCR | Anthropic Claude API via the `process-inbound` Netlify Function |
| Approval routing email | Resend (or SendGrid) via the `expense-request-notify` Netlify Function |
| Approve / Deny endpoint | `expense-request-decide` — Bearer JWT auth, self-approval + allowlist guards, RLS belt-and-suspenders |
| QBO Bill creation | `expense-request-link-bill` — Vendor match + POST `/bill` to QuickBooks, with PR audit notes in PrivateNote |

Detailed architecture is in [`architecture/BRIXPENSE.md`](https://github.com/skypace/apbg-billing/blob/main/architecture/BRIXPENSE.md).

---

## Change log

| Date | Change |
|---|---|
| 2026-05-17 | Initial scaffold. Covers Sign-in, Submit an Expense, Submit a PR, Approve/Deny, Log Receipt, History, Tips, Troubleshooting. |
