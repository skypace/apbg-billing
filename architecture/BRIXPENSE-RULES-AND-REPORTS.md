# Brixpense — inboxes, bill rules, and expense reports

Three changes that go together: the app has clear inboxes, familiar bills code
themselves, and expenses can be bundled into reports that cross payment types.

## The inboxes

| Surface | What it is | Who sees it |
|---|---|---|
| **My Inbox** (`/expense/inbox`) | What is waiting on **you** — approve, post, or fix a rejected post | You, scoped by RLS to rows where you are the submitter or the named owner |
| **Service Fusion** (`/expense/sf-expenses`) | Expenses landed off SF jobs | Staff |
| **Expense History** (`/expense/pending`) | Everything you have filed — the archive (was "Previous Expenses") | You |
| **Vendor Inbox** (`/expense/bills`) | The **master** inbox: every bill emailed to `bills@`, including anything unassigned | **Everyone in Brixpense** |
| **Expense Reports** (`/expense/reports`) | Books that bundle expenses across payment types | Everyone in Brixpense |
| **Bill Rules** (`/expense/rules`) | Auto-populate rules | Read: everyone in Brixpense · Write: staff |

### "Everybody should have access" — and what that has to mean

The Vendor Inbox is the shared pile, so it is deliberately **not** staff-only:
unassigned vendor mail is everybody's problem, and a queue two people can see
is a queue that stops being worked.

But this is a **shared Supabase project** — brix-order customers,
sub-distributor partners and Melt users all authenticate against it, and a
vendor invoice carries our costs, our GL coding and our vendor relationships.
So "everybody" means **everybody in Brixpense**, not every login.

That is `ops.fn_has_brixpense()`: superadmin always; an explicit
`user_metadata.modules` array must contain `billing`; otherwise the legacy role
map (admin, finance). It mirrors the gateway's `grantsAccess()` for the
`billing` bucket and `hasBrixpenseAccess()` in `lib/ap-inbox.mjs`.

Verified against every login shape on the project:

| Login | Vendor Inbox |
|---|---|
| superadmin / admin / finance | ✅ |
| `modules: ['billing']`, any role | ✅ |
| `modules: ['orders']` only | ❌ |
| brix-order customer · distributor · bare login | ❌ |

The API uses the **same predicate**, not a parallel role list:
`requireBrixpense()` authenticates with `requireAuth`'s role check off
(`allowedRoles = null`) and then applies `hasBrixpenseAccess()`. A hard-coded
role list would have drifted from the RLS the first time someone was granted
access by module rather than by role.

## Bill rules

A rule **matches** on what we can see about an inbound bill and **sets** the
coding somebody would otherwise retype every month.

```
when   vendor contains "pro mechanical"
then   GL "Service Expense" (101) · department service · tag 3rd Party Service
```

Matching is deliberately boring and inspectable: case-insensitive substring on
text, inclusive bounds on amount, **all** stated conditions must hold, lowest
`priority` wins. No regex — a bad one in a config field is a support call
nobody can debug — no scoring, no ML.

Rules that matter to get right, and are tested:

- **A rule fills BLANKS.** What OCR read off the actual document — vendor,
  amount, date — always wins. A rule's memo is boilerplate; the document's is
  about this bill.
- **An amount bound never claims a bill whose amount we could not read.** An
  un-OCR'd total is unknown, not zero.
- **A GL account id never travels without its label.** A row that displays one
  account and posts to another is worse than no rule at all.
- **A bare domain matches the domain; a full address matches only that person.**
  Substring matching on hostnames would let `acme.com` match
  `notacme.com.evil.net`.
- **A rule with no conditions is refused** — by the endpoint and by a DB CHECK.
  It would silently claim every bill that arrives.

**Test before you trust.** The rule editor replays a draft against the last 100
real expenses and shows what it would have claimed and coded, and warns when a
rule matches more than half of them. That is the difference between a rule you
can reason about and one you find out about later.

### Recurring

Mark a rule recurring with a period and a usual amount, and a bill outside the
tolerance is **flagged for review** — never blocked. This is what catches a
monthly service that quietly triples. The rule also records what it has
actually been seeing (`match_count`, `last_matched_at`, `last_amount`), which
is what makes it useful next month rather than a one-time autofill.

### ⚠ A rule never posts anything

Auto-populate fills the form. A human still clicks **Post to QuickBooks**. The
2026-08-14 gate is not something a config row may bypass — a rule that could
post would turn "a vendor emailed us a PDF" into "a vendor wrote to our general
ledger".

`expense_requests.applied_rule_id` records which rule coded a bill, so "why
does this have that account" is always answerable.

## Expense reports (books)

A **book** bundles expenses that belong together for reporting, **across
payment types**: a card charge, a check, an emailed vendor bill and an SF job
expense can all sit in one book tied to a job or a tag.

Membership is **explicit**, not a saved filter — the point is grouping things a
filter cannot express ("these five, which happen to share a job"). Totals break
out **by payment type**, by GL account and by entity, because payment type is
the axis an expense report has to be read on and no single column carries it.

- Add expenses with the built-in search (vendor / tag / job / date range).
- **Download CSV** for anyone who wants it in a spreadsheet.
- **Close** a book to freeze it; reopen to change it.
- Deleting a book removes the grouping only — **no expense is ever touched**.

One CSV detail worth keeping: leading `=`, `+`, `-` and `@` are prefix-quoted,
because vendor names come off OCR'd PDFs and Excel treats those as formulas.

## Schema

`20260823040853_brixpense_inboxes_rules_books.sql` (applied live)

| Object | Purpose |
|---|---|
| `ops.fn_has_brixpense()` | "in Brixpense" as a SQL predicate |
| `ops.expense_rules` | the rules; staff write, Brixpense reads |
| `ops.expense_requests.applied_rule_id` | which rule coded this bill |
| `ops.expense_books` / `_book_items` | report books and their membership |
| `ops.v_expense_book_totals` | per-book totals (`security_invoker`) |
