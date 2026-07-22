# Brixpense — Expenses & Purchase Requests

> Part I · User Guide · Owner: Sky Pace · Last reviewed: 2026-07-22

Brixpense is the internal app for submitting expense receipts and purchase requests, getting purchase requests approved, and pushing approved purchases into QuickBooks as Bills. This chapter is for every employee who spends company money and for the managers who approve purchase requests.

## Where it lives

| Thing | Location |
|---|---|
| App | https://alamedapointbg.com/expense/ |
| Full user guide | https://alamedapointbg.com/expense/docs/brixpense/ (source: `apbg-billing/docs/brixpense/user-guide.md`) |
| Source code | `apbg-billing/app-expense/` (React 18 + Vite + Tailwind, builds to `public/expense/`) |
| Data | Supabase `ops.expense_requests` / `_request_attachments` / `_approvals` / `_settings` |
| Login | Supabase email + password — same account as Refractor and the gateway |

## The two submission types

| Type | When to use it | What happens |
|---|---|---|
| **Expense** | You already paid — you have a receipt. | **Auto-approves on submit.** No email, no approval workflow. Posted to QuickBooks right away; recorded in `ops.expense_approvals` as `decided_by='system (auto-approve)'`. |
| **Purchase Request (PR)** | You want to buy something and need sign-off first. | You **pick an approver** from a dropdown (required). They get a notification email and a row in their in-app Queue; they log in and decide at `/expense/review/:id`. Approved PRs wait for you to **Log Receipt**. |

There are **no magic links and no anonymous approval path**. The email an approver receives is a notification, not an authorization — approving always requires signing in to Brixpense with the shared Supabase login.

## Submitting an expense

1. Click **New Expense** from the home screen.
2. **Snap or drop the receipt** (phone camera, drag-and-drop, or file upload). Multiple files can attach to one expense.
3. **Receipt OCR** runs the image/PDF through the Claude API (the `process-inbound` function) and pre-fills vendor, total, date, and line items where visible. Always glance over the pre-fill — vendor and total are usually right, line items can drift.
4. Code the expense (see "Entity / Department / COGS coding" below).
5. Pick the **Paid with** payment account (credit card, bank, petty cash).
6. **Submit.** The expense auto-approves and posts to QuickBooks within seconds.

It shows up in your **History** ("Expenses, auto-approved"), in QuickBooks with the receipt attached, and in `ops.expense_requests` with `status='posted'`.

## Submitting a purchase request

1. Click **New Purchase Request**.
2. Fill in vendor, estimated total, what you're buying and why, plus entity / department / COGS coding.
3. **Pick an approver** from the dropdown. The list is the manager allowlist in `ops.expense_settings.manager_emails`. The `expense-request-notify` function validates your choice against that allowlist, flips the PR to `pending`, and emails the approver a link to `/expense/queue`.
4. **Submit.** Track it on your **Pending** page.

You cannot approve your own PR — enforced in the UI, in the API, and by row-level security.

### For approvers

You're an approver if your email is in `ops.expense_settings.manager_emails` (ask Sky to be added). Your **Queue** (`/expense/queue`) lists PRs waiting on you; **Review** opens `/expense/review/:id` with the full request, receipt preview, routing, Approve/Deny buttons, a notes box, and optional signature capture.

- **Approve** → PR moves to `awaiting_invoice`; the submitter is notified. Nothing posts to QBO yet.
- **Deny** → requires a note; the submitter gets an email with your reason. Terminal — a resubmission starts fresh (History → "Duplicate as new PR").

Guardrails enforced by `expense-request-decide` (Bearer JWT required): caller ≠ submitter, and the caller's email must match the PR's chosen `manager_email` (case-insensitive). RLS enforces the same pair.

### After approval: Log Receipt

When you've actually made the purchase, the PR row on your **Pending** page (status `awaiting_invoice`) shows a **Log Receipt** button. It opens the New Expense form pre-filled from the PR; you attach the real receipt, adjust final numbers, and submit. The new expense carries a `linked_pr_id` and the QBO record's PrivateNote is prepended with `PR approved by <name> on <date>` for the audit chain; the PR flips to `fulfilled`.

## Status reference

| Status | Meaning |
|---|---|
| `draft` | Created, notify not yet run |
| `pending` | PR awaiting the chosen approver |
| `denied` | Approver denied (with note) — terminal |
| `awaiting_invoice` | PR approved; waiting for Log Receipt |
| `fulfilled` | Receipt logged against the PR |
| `posted` | QBO bill/purchase created — terminal |

## Entity / Department / COGS coding

Every submission carries three routing fields that determine where the cost lands on the P&L:

- **Entity** — `brix` (Alameda Soda / Brix Beverage, CA), `freeflow` (FreeFlow Beverage Solutions, MA), or `shared` (split).
- **Department** — filtered by entity (e.g. delivery / service / reman / ops / freeflow / melt).
- **COGS / expense account** — the QBO account. The dropdown sorts likely accounts first based on department.

Canonical department → COGS mapping:

| Department | QBO Account ID | Account name |
|---|---|---|
| delivery | 1150040011 | B2B - Direct Labor (COGS) |
| service | 1150040012 | Service - Direct Labor (COGS) |
| reman | 1150040013 | Reman - Direct Labor (COGS) |
| ops (shared) | 1150040007 | Direct Labor |

When `cogs_account_id` is left null, the QBO posting falls back to the legacy Service COGS account (101). The entity → department → COGS cascade is not yet enforced on the form — pick deliberately.

## The QBO bill linkage

Posting to QuickBooks is done by the **`expense-request-link-bill`** function (Bearer-authenticated). It matches the vendor in QBO, builds `AccountBasedExpenseLineDetail` lines from the request's line items (or a single line at the total), and POSTs a real Bill. Three modes:

| Mode | Behavior |
|---|---|
| `create` (default) | Vendor match + create the QBO bill end-to-end; stamps `qbo_bill_id`, `status='posted'`. |
| `preview` | Dry-run — returns the payload that would be sent, writes nothing. |
| `link` | Legacy passive — records a `qbo_bill_id` created elsewhere. |

If a post fails (usually the vendor name matched no QBO vendor), the fix is creating the vendor in QBO and re-running the post — see the troubleshooting table in the full guide.

## Service Fusion expense landing

Not everything in Brixpense was typed in by hand. When an operator bills a Service Fusion job's 3rd-party receipt via the **`expense-to-bill`** function (the 💰 Bill action from the ResQ/SF workflow), the function creates the QBO bill **and** inserts a matching Brixpense row: `request_type='expense'`, `status='posted'`, `tag='Service Fusion'`, carrying the `qbo_bill_id`, job number, vendor, amount, line items, and customer, with the operator as submitter. These rows are the record of SF job expenses — don't re-submit them. (Related receipt-sweep functions `sf-receipt-*` / `sf-expense-sweep` feed the same landing.)

## Admin settings

Configuration lives in the **`ops.expense_settings`** key/value table: `manager_emails` (the approver allowlist), `departments`, `cogs_accounts`, `tags`, and the approval routing email. There is **no admin UI yet** — changes are direct Supabase edits, so ask Sky to add an approver or a new tag. Several `cogs_accounts` entries still have null QBO IDs and fall back to Service COGS (101) until mapped.

## Troubleshooting quick hits

| Symptom | Fix |
|---|---|
| OCR filled nothing in | Re-take the photo — bright, flat, whole receipt in frame |
| Approver dropdown empty | `manager_emails` not seeded / role issue — ask Sky |
| PR stuck on `pending` | Ping the approver; Sky can reassign in `ops.expense_requests` |
| No Log Receipt button | PR isn't `awaiting_invoice` yet — check its status in History |
| QBO purchase not created | Vendor didn't match a QBO vendor — create it in QBO, re-run the post |
| Login loops | Allow cookies for `gfsdpwiqzshhexkofiif.supabase.co` |

## Related

- Full user guide: https://alamedapointbg.com/expense/docs/brixpense/ (source: `apbg-billing/docs/brixpense/user-guide.md`)
- Architecture: `apbg-billing/architecture/BRIXPENSE.md` (note: its magic-link section predates the final in-app approval model — `apbg-billing/CLAUDE.md` is authoritative)
- [SOP-7 · Expenses & Purchasing — Brixpense Policy, Approvals, COGS Coding](#/27-sop-expenses-purchasing)
- [3rd-Party Billing (AP Tool)](#/08-ap-billing-tool) — the `expense-to-bill` Service Fusion source
- [BRIX Refractor (Margin Control)](#/06-refractor-margin-control)
