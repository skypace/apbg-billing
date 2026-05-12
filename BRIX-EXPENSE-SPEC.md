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

**What's working today and MUST carry forward to Brix Expense:**
- Drop-a-PDF receipt → OCR → pre-filled review form (`process-inbound` Netlify function).
- Live QBO vendor list, with search-as-you-type and **fuzzy auto-match** of the OCR-extracted vendor name against the QBO list (`get-vendors` function).
- Live QBO customer list with search-as-you-type (`get-customers` function).
- **Inline "+ Create new vendor"** when no match exists (`create-vendor` function).
- **SF / ResQ job # → matching invoice → margin and margin % display** (`approve-bill` function returns `invoiceMatch.margin` + `invoiceMatch.marginPct`). This is the single most valuable feature of the existing tool — it turns an expense into a P&L data point on submission.
- Line-item editor with live total recalc.
- QBO bill creation on submit, with success vs "no matching invoice" warning states.

**What's missing today and needs to be added:**
- Only 2 COGS accounts hardcoded — needs the 9-option whitelist (§4).
- No tag / department allocation (§5).
- No approval workflow (§6).
- No purchase-request mode (§2 Mode B).
- No signature pad on approvals.
- Mobile layout works but isn't truly mobile-first; touch targets are tight.
- Superadmin-only — drivers, techs, office staff can't submit their own receipts.
- Visual quality: weak. The new build uses the data-dense shadcn/ui look (§8) with Brix brand colors.

---

## 2. What "Brix Expense" does

Two top-level modes, picked from a landing screen:

### Mode A — Expense (you already paid; load the receipt)

1. Drop a receipt (PDF/photo) **or** enter manually.
2. OCR pre-fills vendor, date, total, line items (existing `process-inbound` flow). OCR also fuzzy-matches the vendor name against the live QBO vendor list and auto-selects when confidence is high.
3. User confirms / fills these fields. **Live QBO data drives every dropdown — vendors, customers, and accounts are fetched on page load via existing Netlify functions; no hardcoded lists except for the COGS account whitelist in §4 below.**

   | Field | Required | Notes |
   |---|---|---|
   | **Vendor** | yes | Search-as-you-type against live QBO vendor list. "+ Create new vendor" inline if no match (existing `create-vendor` function). |
   | **COGS account** | yes | 9-option whitelist (§4). |
   | **Customer / location** | yes | Search-as-you-type against live QBO customer list. |
   | **SF / ResQ job #** | **yes for service expenses** | This is the key — it's how we match the bill to the invoice that recovered the expense. Existing `approve-bill` function returns the matching invoice + computed margin and margin %. The new form must keep this behavior. For non-service expenses (fuel, office supplies, travel, etc.) the job # field is optional. |
   | **Bill #** (vendor invoice #) | optional | Free text. |
   | **Due date** | optional | Defaults to OCR-extracted due date. |
   | **Tag** | yes | §5. |
   | **Department** | yes when tag is set | §5. |
   | **Memo / Note** | optional | Free text. |
   | **Line items** | ≥ 1 | Description / qty / unit cost; total recomputes live. |

4. **Submit:**
   - If total **≤ $500** → create QBO bill immediately via existing `approve-bill` function. Return the QBO bill # **and** the matched invoice + margin display (existing UX — keep it). If no invoice matches the job #, show the existing warning card.
   - If total **> $500** → save as `pending`; route to manager for approval (Mode C). Bill creation happens **after** the manager signs and approves.

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

## 7b. QBO data wiring (must work end-to-end on day one)

All QBO data is **live, not cached client-side**. The page loads the same Netlify functions the existing tool uses:

| Need | Source | Notes |
|---|---|---|
| Vendor list | `GET /.netlify/functions/get-vendors` | ~1.5 K rows. Search-as-you-type is client-side over the loaded list. |
| Customer list | `GET /.netlify/functions/get-customers` | ~11.8 K rows. Same client-side search. |
| Create vendor | `POST /.netlify/functions/create-vendor` | Inline-create when no match. |
| Submit bill (≤$500 or post-approval) | `POST /.netlify/functions/approve-bill` | Creates the QBO bill, returns `{ bill, invoiceMatch: { number, margin, marginPct, customerName, total } }`. |
| OCR a receipt | `POST /.netlify/functions/process-inbound` | Returns `{ approveUrl, billData }` with `vendorName / billNumber / billDate / total / lineItems[] / dueDate / notes / category`. |
| Decode the OCR token | `GET /.netlify/functions/decode-token?token=…` | Returns `{ billData }` for the URL-token handoff. |

**QBO connection health surface:** the page shows a live status pill in the header — `QBO connected — 1,512 vendors, 11,843 customers` or `QBO error: <message>`. If QBO is disconnected (token expired, pacerfinance offline, network), submit is disabled and the user sees an actionable error, not a silent fail. This is also how the existing tool behaves; it must continue to work that way.

**Auth:** `requireAuthenticated()` (not `requireSuperadmin()` like today). The existing `authedFetch` wrapper in `public/auth.js` is what wires the JWT — the React app will use the equivalent already in `app/src/lib/auth.ts`.

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

**Parity with the existing 3rd Party Billing Loader (must all still work):**
- [ ] Drop a vendor-bill PDF or image → OCR pre-fills vendor / bill # / date / total / line items / due date / notes.
- [ ] QBO vendor + customer dropdowns load live (with the existing status pill: `QBO connected — N vendors, M customers`); search-as-you-type works.
- [ ] OCR-extracted vendor name fuzzy-matches against the live QBO vendor list and auto-selects when confident.
- [ ] "+ Create new vendor" inline action works (calls `create-vendor`, appends to local list, auto-selects).
- [ ] SF / ResQ job # field is present; on submit (service expenses), the matched-invoice card displays vendor, bill #, total, matched invoice #, customer, and **margin + margin %**.
- [ ] If no invoice matches the job #, the warning card is shown ("Bill created — no matching invoice"), telling the user to submit the job for invoicing manually.

**New features:**
- [ ] 9-option COGS account whitelist (§4).
- [ ] Tag selector + conditional Department selector (§5).
- [ ] Free-text Note field on every submission.
- [ ] Submissions ≤ $500 post a QBO bill immediately; > $500 route to the chosen manager.
- [ ] Manager receives a Resend email from `alamedapointbg.com` within 30 seconds of submission; the email links to a signed approval page.
- [ ] Approval page renders on a phone, captures a signature on a 200 px-tall canvas, and on Approve → posts the QBO bill and notifies the submitter; on Deny → notifies the submitter with the deny reason.
- [ ] Purchase Request mode: quote upload, amount, manager picker, signature on approval, lives in `awaiting_invoice` until linked to a real bill.

**UX bar:**
- [ ] Driver on a phone (375 px) can drop a fuel receipt, pick **Fuel** / **vehicle** / **delivery** / note, and submit in under 30 seconds.
- [ ] No horizontal scroll at 375 / 768 / 1024 / 1440 px.
- [ ] 44 × 44 px minimum touch targets, 8 px minimum gap between them.
- [ ] Status pill, line-item table, and totals use Fira Code so numbers align cleanly.
- [ ] Visual feels like a real product — not a form on a white page. Cards with subtle elevation, clear section headers, the Brix logo in the top-left, and the margin display rendered in a prominent currency-formatted band on success.

**Non-regression:**
- [ ] None of the existing Margin / Fleet / Operations / Reports / Plans / Customers / Inventory / Settings pages change visually.
- [ ] The legacy `public/index.html` + `public/approve.html` stay in place during v1 rollout as a fallback. Once Brix Expense is signed off, we 301-redirect `/billing/` to the new route in a follow-up PR.
