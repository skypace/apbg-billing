# Brix Expense — Co-Work Spec

**Status:** Draft for team review
**Owner:** Sky
**Replaces:** APBG 3rd Party Billing Loader (public/index.html + public/approve.html)
**Target stack:** React + shadcn/ui + Tailwind, mounted in the existing `apbg-billing` Vite SPA
**Backend:** Existing Supabase (ops schema) + Netlify Functions + QBO + Resend

---

## TL;DR

Rename and rebuild the **APBG 3rd Party Billing Loader** as **Brix Expense** — a mobile-first expense + purchase-request tool that anyone on the team can use. Same OCR receipt drop and QBO bill-creation flow we have today, plus:

- More COGS accounts in the dropdown (9 total, up from 2).
- A **TAG** field that opens a **Department** dropdown for cost allocation.
- A free-text **Note** on every entry.
- An **approval workflow** on anything over **$500**: the submitter picks a manager, the manager gets an email from Resend, opens an approval page, signs on-screen (signature pad), and either approves or denies.
- A second mode — **Purchase Request** — for pre-spend approvals: attach a quote, set the amount, route to manager, sign, store. When the real invoice arrives later, it links back to the PR and posts as a QBO bill.

Built as one PR. Brand colors + brand fonts come from the Brix brand spec (pending).

---

## 1. Current state — what exists today

The "APBG 3rd Party Billing Loader" is a vanilla-HTML tool at:

- `public/index.html` — drag-and-drop landing page for a vendor bill PDF/image.
- `public/approve.html` — review form: vendor, COGS account (2 options), customer, job number, line items, memo.
- `netlify/functions/process-inbound.mjs` — OCRs the upload.
- `netlify/functions/approve-bill.mjs` — creates the QBO bill, matches it to an invoice by job number, returns margin.

Auth is gated on `requireSuperadmin()`. Visual style: navy `#1F4E79` + amber accents, DM Sans.

**What's wrong with it for our needs today:**
- Only 2 COGS accounts hardcoded.
- No tag / department allocation.
- No approval workflow.
- No purchase-request mode.
- Mobile layout works but isn't truly mobile-first; touch targets are tight.
- Superadmin-only — drivers, techs, office staff can't submit their own receipts.

---

## 2. What "Brix Expense" does

Two top-level modes, picked from a landing screen:

### Mode A — Expense (you already paid; load the receipt)

1. Drop a receipt (PDF/photo) **or** enter manually.
2. OCR pre-fills vendor, date, total, line items (existing `process-inbound` flow).
3. User confirms: **vendor**, **COGS account** (9 choices), **tag**, **department** (shown only when tag is set), **customer/location** (optional), **job number** (optional), **memo**, **line items**.
4. If total **≤ $500** → create QBO bill immediately, return success + invoice match status (today's flow).
5. If total **> $500** → save as pending; route to manager for approval (Mode C below).

### Mode B — Purchase Request (pre-spend approval before you buy)

1. Upload **quote** PDF (or skip).
2. Enter **vendor**, **estimated amount**, **COGS account**, **tag**, **department**, **memo**.
3. Pick **manager** from a dropdown.
4. Submit → stored as `purchase_request` with status `pending`, manager emailed.
5. After approval, request lives in a "Approved — awaiting invoice" queue.
6. When the actual vendor invoice arrives (via Mode A — receipt drop), the system surfaces a "Link to PR #__" prompt; once linked, the bill posts to QBO and the PR is marked `fulfilled`.

### Mode C — Manager approval page (entered via emailed link)

- Magic-link URL sent via Resend from `alamedapointbg.com`.
- Page shows: requester, vendor, amount, account, tag, department, memo, attached quote/receipt.
- Buttons: **Approve** / **Deny**.
- **Signature pad** at the bottom (same component pattern as Melt dashboard signature flow).
- On approve: status → `approved`, signature image + timestamp + IP stored, submitter notified, bill creation proceeds (or queued for invoice linkage if PR).
- On deny: status → `denied`, optional reason note, submitter notified.

---

## 3. Users + access

| Role | What they can do |
|---|---|
| **Any authenticated staff** | Submit Expense, submit Purchase Request, view their own submissions. |
| **Manager** (listed below) | All of the above + approve/deny requests routed to them. |
| **Superadmin (Sky)** | All of the above + see all submissions, override status, view audit log. |

**Manager list (from Sky):**
- `Anthonyv@brixbev.com`
- `skypace@brixbev.com`
- `asloan@brixbev.com`
- `marco@brixbev.com` *(confirm — spec said `marco@brixbebev.com`)*
- `joel@brixbev.com`

---

## 4. COGS account dropdown

Expanded from 2 to **9** options. Real QBO Account IDs to be filled in by querying the QBO API.

| # | Label | Notes |
|---|---|---|
| 1 | Service COGS | existing (ID 101) |
| 2 | Equipment COGS | existing (ID 42) |
| 3 | Fuel | new |
| 4 | Office Supplies | new |
| 5 | Working Meals | new |
| 6 | Travel | new |
| 7 | Repair & Maintenance — Building | new |
| 8 | New Fountain Installs COGS | new |
| 9 | Ice Machine Rental COGS | new |

---

## 5. Tag + Department

The **TAG** field is a top-level cost-attribution dimension. When the user picks a tag, a **Department** dropdown appears underneath. This lets us roll up spend by project / event / vehicle / store *and* by which crew it should hit.

**Tags (proposed — confirm):**
project · event · vehicle · customer · store · general

**Departments (proposed — confirm):**
delivery · service · reman · ops · freeflow · melt

If Sky has a defined list inside `ops.staff_roles` or `ops.role_types`, we'll pull from there instead so it stays in sync with the roster.

---

## 6. Approval logic (the $500 gate)

| Total | Mode A path | Mode B path |
|---|---|---|
| **≤ $500** | Auto-create QBO bill on submit. | Still requires approval — PRs are always pre-spend, so always go through manager. |
| **> $500** | Status `pending`, manager emailed via Resend, signature required, then create bill. | Same as above. |

The $500 threshold is configurable in `ops.expense_settings` so it can be changed without a deploy.

---

## 7. Bill linkage (PR → real invoice)

After a Purchase Request is approved, the system tracks it as `awaiting_invoice`. When the actual vendor invoice arrives:

1. User drops the receipt via Mode A as usual.
2. Form surfaces "Looks like this matches PR #__ from <date> — link it?".
3. On link → bill posts to QBO with the PR's pre-approved account/tag/dept + signature attached, PR marked `fulfilled`.

Matching uses vendor + amount + date proximity (±14 days, ±5% on amount).

---

## 8. UI/UX direction

From the `ui-ux-pro-max` skill, **data-dense dashboard** style with **shadcn/ui** components:

- **Typography:** Fira Sans (body), Fira Code (totals + IDs).
- **Color tokens:** primary navy ≈ Brix navy, green CTA for "Approve" / "Submit", red for "Deny", amber for "Pending". *Exact hex values from Brix brand spec — pending.*
- **Components:** shadcn `Button`, `Input`, `Select`, `Form` (react-hook-form + Zod), `Dialog` (approve/deny confirmations), `DataTable` (TanStack Table for pending list), Lucide icons (no emojis).
- **Mobile-first:** 44×44 px minimum touch targets, ≥8 px gaps, 16 px body text, `touch-action: manipulation` to kill 300 ms tap delay.
- **Scoped CSS:** lives at `/expense/*` with its own Tailwind layer so it doesn't bleed into the dark-cyan Margin / Fleet / Ops pages.
- **Receipt upload:** big drop zone on desktop, full-screen camera capture on mobile (`<input type=file accept=image/* capture>`).

---

## 9. Tech architecture at a glance

```
app/src/pages/expense/
  index.tsx                ← Landing (Expense vs Purchase Request)
  ExpenseForm.tsx          ← Mode A
  PurchaseRequestForm.tsx  ← Mode B
  ApprovalPage.tsx         ← /expense/approve/:token — sig pad + decide
  PendingList.tsx          ← Submitter's queue
  ManagerQueue.tsx         ← Manager's inbox
app/src/components/ui/     ← shadcn primitives
app/src/components/SignaturePad.tsx
netlify/functions/
  expense-request-create.mjs
  expense-request-notify.mjs    ← Resend → manager
  expense-request-decide.mjs    ← approve/deny + sig + notify submitter
  expense-request-link-bill.mjs ← attach to PR + QBO bill create
supabase/migrations/
  ops_expense_requests.sql      ← tables + RLS
```

**New Supabase tables (ops schema):**
- `ops.expense_requests` — one row per submission (Expense or PR).
- `ops.expense_request_attachments` — receipts, quotes, supporting files.
- `ops.expense_request_approvals` — audit log (who, when, signature, IP, decision, note).
- `ops.expense_settings` — threshold ($500), manager list (or pulled from staff_roles).

---

## 10. Out of scope for v1

- OCR of the quote PDF itself (Purchase Request just stores the file; we don't extract).
- Multi-step approval chains (only single-manager approval — escalation is a future addition).
- Receipt-to-PR auto-matching beyond vendor/amount/date proximity (ML matching: later).
- Mobile push notifications (manager gets email only).

---

## 11. Open questions blocking the build

1. **Brix brand spec** — exact colors, fonts (override Fira if different), logo file path.
2. **Marco's email** — confirm `marco@brixbev.com` (spec had a typo).
3. **Signature pad reference** — where does the Melt dashboard signature implementation live? Want to mirror that UX exactly.
4. **Resend setup** — is `RESEND_API_KEY` already set in Netlify env, and is `alamedapointbg.com` verified as a sender on resend.com?
5. **Tag + Department lists** — confirm the proposed lists in §5, or supply the canonical lists.

---

## 12. Acceptance criteria for v1

- A driver on a phone can drop a fuel receipt, pick "Fuel" account, pick "vehicle" tag → "delivery" department, add a note, and submit in under 30 seconds.
- A submission ≤ $500 creates a QBO bill within 10 seconds and shows the invoice match (or "no match" warning).
- A submission > $500 emails the chosen manager within 30 seconds; the email contains a deep link to the approval page; the manager can sign and approve from their phone.
- A Purchase Request stores the quote, routes to manager, and shows up in "Approved — awaiting invoice" once signed.
- The new `/expense` route is touch-friendly at 375 px width with no horizontal scroll.
- None of the existing Margin / Fleet / Ops / Settings pages change visually.
