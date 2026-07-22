# SOP-7 · Expenses & Purchasing — Brixpense Policy, Approvals, COGS Coding

> Part II · SOP Manual · Owner: Sky Pace · Last reviewed: 2026-07-22

This SOP sets the rules behind Brixpense (https://alamedapointbg.com/expense/): when a purchase needs pre-approval, who may approve, and how every dollar gets coded to the right entity and COGS account. It's for everyone who spends company money and for the managers on the approver allowlist. The how-to-use-the-app walkthrough is the [Brixpense user guide chapter](#/07-brixpense) — this chapter is the policy.

## Expense vs. purchase request

### Policy

- An **Expense** is a record of fact: you already paid, you have the receipt. Expenses **auto-approve on submit** and post to QuickBooks as a Purchase within seconds — no email, no approval workflow. The approval record is stamped `decided_by='system (auto-approve)'`.
- A **Purchase Request (PR)** is pre-authorization: you want to buy something and haven't yet. PRs **require a named approver before the purchase happens**. The submitter picks the approver from the allowlist dropdown; the request sits at `pending` until decided.
- **You may not approve your own PR.** Enforced at the API (`403 self_approval_forbidden`) and again by RLS — do not attempt to route around it by picking yourself.
- Approval is **in-app and authenticated only**: the approver signs in with the shared Supabase login and decides at `/expense/review/:id`. The notification email is a pointer, not an authorization — there are no magic-link tokens and no anonymous approval path.
- After approval, a PR is `awaiting_invoice`; the submitter closes the loop with **Log Receipt** once the purchase is actually made. The resulting expense carries `linked_pr_id` and a QBO PrivateNote audit line ("PR approved by \<name\> on \<date\> | linked PR: \<short\>"), and the PR flips to `fulfilled`.
- A **denied** PR is final. To try again, duplicate it as a new PR with a fresh approver.

### Procedure (PR lifecycle, condensed)

1. Submitter files the PR: vendor, estimated total, line items/why, entity + department + COGS, and a chosen approver.
2. `expense-request-notify` validates the approver against the allowlist, flips status to `pending`, emails the approver a link to `/expense/queue`.
3. Approver signs in, reviews at `/expense/review/:id`, and approves (→ `awaiting_invoice`) or denies with a note (→ `denied`).
4. Submitter purchases, then clicks **Log Receipt** on the Pending page — the expense form pre-fills from the PR; snap the real receipt, correct final numbers, submit.
5. The expense posts to QBO; the PR flips to `fulfilled`.

## Approver allowlist

### Policy

- The approver dropdown is exactly `ops.expense_settings.manager_emails`. Only people on that list can be chosen, and the decide endpoint verifies `lower(caller.email) == lower(manager_email)` — being a manager in real life is not enough; the email must be on the list.
- Changes to the allowlist go through Sky (Brixpense admin Settings, or the `ops.expense_settings` seed). Adding an approver is an access-control decision, not a convenience edit.
- If the approver dropdown is empty, the allowlist hasn't been seeded or your role can't read it — ask Sky; do not submit the PR as an expense to skip the queue.

## Entity coding

### Policy

Every submission is coded to the legal entity that owns the cost. The entity values (preserved verbatim from the business rules):

- `entity = 'brix'` or `'AS'` — **Alameda Soda / Brix Beverage** (CA S-corp)
- `entity = 'freeflow'` or `'FF'` — **FreeFlow Beverage Solutions** (MA S-corp)
- `entity = 'shared'` — **split between both**

The department dropdown filters by entity (e.g. FreeFlow offers `service` / `reman` / `ops` / `freeflow`; Brix offers `delivery` / `service` / `ops` / `melt`). When in doubt whether a cost is shared, ask before submitting — recoding after QBO posting is manual cleanup.

## Department → COGS account mapping

### Policy

The department you pick drives which QBO COGS account the cost hits. The canonical mapping:

| Department | QBO Account ID | Account Name |
|---|---|---|
| delivery | 1150040011 | B2B - Direct Labor (COGS) |
| service | 1150040012 | Service - Direct Labor (COGS) |
| reman | 1150040013 | Reman - Direct Labor (COGS) |
| ops (shared) | 1150040007 | Direct Labor |

Legacy AP-tool mappings (**Service COGS 101**, Equipment Sales COGS 42) remain the default fallback in `expense-request-link-bill` when `cogs_account_id` is null — a submission with no COGS account picked lands on Service COGS 101, so pick the account rather than relying on the fallback.

## Receipts

### Policy

- **Attach the receipt.** For expenses it's the point of the submission; for fulfilled PRs it's what Log Receipt exists for. Multiple receipts can attach to one submission.
- OCR (Claude API via `process-inbound`) pre-fills vendor, total, date, and visible line items — it **assists, it doesn't decide**. Always review the auto-filled fields before submitting; vendor and total are usually right, line items can drift.
- Receipts attach to both the Brixpense row and the QBO Purchase record, so auditors see them in QuickBooks directly.
- Brixpense doesn't track tax separately — break out a "Sales tax" line item if you need the tax portion visible.

## QBO bill linkage

### Policy

- Posted submissions become real QuickBooks records via `expense-request-link-bill`: `create` mode (default) matches the vendor and POSTs the bill; `preview` is a dry run; `link` is the legacy passive mode. If the vendor name doesn't match any QBO vendor, the post fails — create the vendor in QBO and re-run the post (via Master Control) rather than renaming the submission to force a match.
- **Service Fusion 3rd-party bills land in Brixpense automatically.** The AP tool's 💰 Bill action (`expense-to-bill`), after creating the QBO bill, inserts an `ops.expense_requests` row: `request_type=expense`, `status=posted`, tagged **`Service Fusion`**, carrying the `qbo_bill_id`, job number, vendor, amount, line items, and customer, with the operator as `submitted_by`. These rows are records of an already-booked bill — do not re-submit or "approve" them; the insert is non-fatal by design and never undoes the bill.

## Purchase authorization thresholds

> **Draft policy — proposed 2026-07-22, pending owner approval.** Brixpense currently enforces *who* approves (allowlist + no self-approval) but not *amount tiers*. Proposed tiers below — amounts are placeholders for the owner to set; today any allowlisted approver may approve any amount.

| Tier | Estimated total | Required authorization (proposed) |
|---|---|---|
| 1 | Up to $\<A\> | Expense allowed directly (record of fact) if already company-card-paid per normal policy; otherwise any allowlisted approver |
| 2 | $\<A\>–$\<B\> | PR required, any allowlisted approver |
| 3 | Over $\<B\> | PR required, approved by an owner (Sky or Whitney) |

Until amounts are set, the operating rule stays: **if you haven't paid yet and it isn't a routine consumable, file a PR.**

## Related

- [Brixpense — Expenses & Purchase Requests](#/07-brixpense) — the app walkthrough (submit, queue, Log Receipt, troubleshooting)
- [3rd-Party Billing (AP Tool)](#/08-ap-billing-tool) — where SF 3rd-party bills originate before landing here
- [SOP-4 · Billing & Payments](#/24-sop-billing-payments) — customer-side money
- [SOP-9 · Data & Engineering](#/29-sop-data-engineering) — `ops.expense_*` table ownership and the sync manifest
- Source: `apbg-billing/docs/brixpense/user-guide.md`
- Source: `apbg-billing/CLAUDE.md` (approval model, entity split, COGS mapping — canonical)
- Source: `apbg-billing/architecture/BRIXPENSE.md` (app architecture; note its "magic-link" wording is stale — the in-app model in CLAUDE.md is live)
