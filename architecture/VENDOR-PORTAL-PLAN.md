# Vendor Portal & Vendor Payments — Project Plan

> Status: **Phases 1 + 2 SHIPPED** (PR #384 and #385, merged 2026-08-20 —
> `ops.vendors` + Brixpense Vendors module, then the token-gated vendor intake
> at `/vendor-onboarding` with ACORD/W-9 OCR and the Monday auto-chase).
> **Phase 3 built** on the same branch: `ops.vendor_payments`, `vendor-pay.mjs`
> (superadmin), `stripe-payout-webhook.mjs`, and the Pay UI — code-complete and
> **dark until `STRIPE_PAYOUTS_KEY` + `STRIPE_PAYOUT_WEBHOOK_SECRET` are set**. **Payment rail decided 2026-08-20 (Sky): Stripe** —
> "I wanna use stripe payments as i already have stripe." Phase 3 rewritten below
> around **Stripe Global Payouts**; PayPal/Venmo are no longer planned rails
> (Stripe cannot send to Venmo/PayPal — those stay manual-record).
> Home: Brixpense (`app-expense/`) + apbg-billing Netlify functions + `ops.*`.
> ⚠ Companion rows for `ARCHITECTURE.md` + `projects/vendor-portal/` in
> `activespacescience/Skilliosis_Mytosis_Architecture` need manual apply — that repo
> is not in this session's GitHub grant (same limitation hit 2026-08-18).

## What this is

One vendor record per real-world vendor, connecting four things that today live in
four places (or nowhere):

1. **The books** — `ops.qbo_vendors` (daily mirror; Brixpense already bills against
   live QBO vendors via `findQBOVendor` in `expense-request-link-bill.mjs`).
2. **Compliance paper** — COI + W-9 in the existing compliance vault
   (`ops.insured_parties` + `ops.compliance_documents` + `compliance-docs` bucket,
   with its expiry engine and weekly digest cron). This plan LINKS to the vault, it
   does not duplicate it.
3. **How they get paid** — a payment *preference* + handle (Venmo @handle, PayPal
   email), never bank account numbers.
4. **Payment history** — a ledger row per payment, whichever rail moved the money.

Vendors never get logins. They interact through **token-gated one-time links**
(visitor-kiosk pattern: public page, service-role writes, nothing readable by the
anon key).

## Hard rules (carried from the earlier decisions)

- **No bank account numbers in Supabase, ever.** ACH details live with the payment
  rail (Melio / QBO Bill Pay); Venmo/PayPal need only a handle/email.
- **No full SSN/EIN columns.** Last-4 only; the full number lives inside the W-9
  PDF in the private staff-gated bucket.
- **No auto-pay.** Every payment is an explicit human click, same philosophy as the
  2026-08-14 Brixpense full gate. Superadmin-only at launch.
- **Soft compliance gate.** The upload page accepts documents that fall short of
  requirements and flags the shortfall for staff review — a non-compliant COI still
  gets FILED while you argue about it.
- Every new `ops.*` table registers a writer in `architecture/sync-manifest.json`
  (build gate) and any new pipeline gets a check in `ops.fn_sync_health_extra()`
  (repo rule: no unmonitored store).

## Phase 0 — Sky's decisions & accounts (blockers only for Phase 3)

| # | Decision | Status / default |
|---|---|---|
| 1 | **Payment rail** | **DECIDED (2026-08-20): Stripe.** Phase 3 uses **Stripe Global Payouts** — enable it on the existing Stripe account (Dashboard → Global Payouts; US senders GA) and put the account's secret key on the apbg-billing Netlify site as `STRIPE_SECRET_KEY` (brix-order holds its own copy — sites don't share env). Recipient bank details are collected by STRIPE (hosted recipient onboarding / payout links), never by us. Venmo/PayPal are not Stripe destinations → manual-record rails. |
| 2 | **Who can click Pay** | Superadmin only |
| 3 | **COI gate** | Soft (file + flag) |

Phases 1–2 have **zero blockers** — buildable immediately.

## Phase 1 — Vendor registry + Brixpense "Vendors" module (~1 session)

**Migration `ops.vendors`** (staff-only RLS both directions, same lesson as
`20260726a`):

- identity: `display_name`, `legal_name`, `vendor_type` (contractor / supplier /
  service / other), contact name/email/phone
- links: `qbo_vendor_id` (→ `ops.qbo_vendors` mirror), `insured_party_id`
  (→ `ops.insured_parties`; auto-created when missing)
- payment: `payment_method_pref` ('ach' | 'paypal' | 'venmo' | 'zelle_manual' |
  'check_manual' | null), `payment_handle` (Venmo @handle or PayPal email — the
  ONLY payment datum we store), `default_terms`
- compliance: `requirements` jsonb (`gl_each_occurrence`, `wc_required`,
  `auto_required`, `additional_insured_required`), `w9_status`, `ein_last4`,
  `onboard_status` (invited / docs_pending / complete)
- ops: `notes`, `active`, timestamps, `created_by`

**Brixpense → Vendors section** (`app-expense/src/pages/vendors/`, sidebar entry,
superadmin/admin):

- Roster: compliance chips per vendor (COI current / expiring ≤30d / expired /
  missing · W-9 on file · payable-via badge), search, add-vendor (pick from the
  `qbo_vendors` mirror, or create → writes the QBO Vendor through the existing
  hardened token chain and self-heals the mirror)
- Vendor detail: profile, requirements editor, linked documents (read through the
  compliance vault by `insured_party_id`), "Request documents" button (Phase 2),
  payments history (Phase 3)
- Compliance rollup: computed where displayed (vault convention), never stored

**Deliberately reused, not rebuilt:** document storage/expiry (compliance vault),
QBO vendor create/match (`expense-request-link-bill` patterns), staff gating
(`ops.fn_is_staff()` / superadmin JWT).

## Phase 2 — Token-gated vendor onboarding + document intake (~1–2 sessions)

**Migration `ops.vendor_onboard_tokens`**: `token_hash` (sha256 — raw token only in
the emailed link), `vendor_id`, `purpose` ('onboard' | 'docs_refresh'),
`expires_at` (14d), `used_at`, `created_by`. Service-role only. A freshness check
joins `ops.fn_sync_health_extra()` so a stuck chase pipeline pages like everything
else.

**Public page `public/vendor-onboard.html`** (visitor-kiosk recipe: deliberately
unauthenticated, all writes through service-role functions, served at
`alamedapointbg.com/vendor-onboarding?t=<token>` via a gateway proxy row):

1. Confirm business identity + contact
2. **W-9 upload** (or fill-in assist) — file to `compliance-docs` bucket under the
   vendor's party; OCR extracts name, entity type, EIN→last4, signature date
3. **COI upload** — OCR extracts carrier, policy #s, GL/WC/auto limits,
   effective/expiration, additional-insured wording; compared against the vendor's
   `requirements`; shortfalls flagged (soft gate), everything filed either way
4. **Payment preference** — pick ACH / PayPal / Venmo / check; Venmo/PayPal capture
   the handle; ACH shows "we'll set you up through our payment provider — no bank
   details here" (Melio's own vendor flow, or QBO Bill Pay, owns that)

**OCR**: new `netlify/functions/lib/vendor-doc-ocr.mjs` on the `expense-ocr-core`
recipe (same Claude client, new ACORD-25 + W-9 schemas/prompts).

**Emails (Resend, existing pipeline + comm-log conventions):**
- "Please send us your documents" invite with the token link (staff-triggered from
  the vendor detail)
- **Auto-chase cron**: extends the Monday `compliance-expiry-cron` — vendors with a
  COI expiring ≤30d (or expired, or missing against requirements) get a direct
  chase email with a fresh `docs_refresh` token; staff digest unchanged. Throttled
  to one chase per vendor per week; every send logged.

## Phase 3 — Payments (~1–2 sessions once Phase-0 creds exist)

**Migration `ops.vendor_payments`** (ledger; staff-only RLS): `vendor_id`,
`expense_request_id`, `qbo_bill_id`, `rail` ('stripe_payout' | 'venmo_manual' |
'zelle_manual' | 'check_manual' | 'qbo_billpay'), `amount`, `status` (initiated /
settled / failed / recorded), external payout id, `qbo_billpayment_id`, actor,
timestamps, `failure_reason`. `ops.vendors` gains `stripe_recipient_id` (the only
Stripe datum we hold — never bank details).

**"Pay" action** on approved/posted bills (PendingList, SFExpenses, vendor detail),
routed by the vendor's preference:

- **Stripe (ACH / debit / local rails)** — `vendor-pay-stripe.mjs` → **Stripe Global
  Payouts** on Sky's existing Stripe account. Recipient setup uses Stripe's hosted
  onboarding (or a payout link for one-offs): the VENDOR gives their bank details to
  Stripe directly; we store only the Stripe recipient id on `ops.vendors`. Webhook
  `stripe-payout-webhook.mjs` (signature-verified, same posture as the Resend/Svix
  intakes) flips ledger status; on success the function records a **QBO BillPayment**
  against the bill through the hardened billing token chain and nudges the mirror —
  books close themselves. Note: Global Payouts sends from a Stripe payments/top-up
  balance, so funding that balance is part of the ops runbook.
- **Manual rails** (Venmo/Zelle sent by hand, paper check, QBO Bill Pay) — "Record
  payment" dialog: writes the QBO BillPayment + ledger row so the bill reads paid
  everywhere. Venmo and Zelle stay human acts by design — Stripe cannot send to
  them and Zelle has no business API at all.

**Guardrails**: explicit click only; duplicate guard (refuse when the bill already
has a BillPayment or a live ledger row); confirm dialog restates vendor + handle +
amount; superadmin-only; every payment audit-trailed and comm-logged. Failed
payouts email `REPORT_TO` (same pattern as failed bill posts, #357) and land red in
a new `vendor_payments` health check.

**1099 note**: rail is recorded per payment. Stripe Global Payouts are direct bank
transfers (like ACH/check/Zelle) — they count toward OUR 1099-NEC duty, unlike
platform-reported PayPal/Venmo business payments. Confirm treatment with the
bookkeeper before relying on it.

## Phase 4 — later / optional

Bulk pay runs · vendor-facing payment-status page (token link, read-only) · Melio
partner-API embed · `/compliance` Vendors tab cross-links · handbook chapter +
SOP update (vendor onboarding runbook).

## Sequencing & estimates

| Phase | Depends on | Size |
|---|---|---|
| 1 — registry + module | nothing | ~1 session |
| 2 — onboarding page + OCR + chase | Phase 1 | ~1–2 sessions |
| 3 — payments | Stripe Global Payouts enabled + `STRIPE_SECRET_KEY` on this site, Phase 1 | ~1–2 sessions |

Phases 1–2 deliver the thing you asked for first (insurance, W-9, payment info
stored, vendor-fed); Phase 3 turns "payment info" into "payment button".

## New env vars (Phase 3)

`STRIPE_SECRET_KEY` (this Netlify site — brix-order's copy doesn't carry over) +
`STRIPE_PAYOUT_WEBHOOK_SECRET`. Each lands with its health check per the repo's
no-unmonitored-credentials rule.
