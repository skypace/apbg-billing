# SOP-1 · Security & Access — Accounts, Roles, Credentials, PCI Posture

> Part II · SOP Manual · Owner: Sky Pace · Last reviewed: 2026-07-22

This SOP governs who gets accounts on APBG systems, how passwords and credentials are handled, and the hard boundaries around payment-card data and the voice-agent access codes. It applies to every APBG staff member who provisions users, touches an env var, or handles anything payment-adjacent. Customer-facing account setup is covered in [SOP-2 · Customer Lifecycle](#/22-sop-customer-lifecycle).

## Account provisioning & deprovisioning

### Policy

- Staff accounts on the shared Supabase auth project are created **only** through the gateway admin console at `https://alamedapointbg.com/admin.html` (superadmin/admin only, backed by `/api/admin-users`). Do not create staff auth users by SQL or ad-hoc scripts.
- Roles are assigned by a **superadmin** via `user_metadata.role`. The role determines which apps a user sees in the hub and waffle launcher.
- Customer portal users are provisioned from the Brix Order admin console (`https://orders.brixbev.com/admin` → customer detail → Users tab), never by SQL — see [SOP-2](#/22-sop-customer-lifecycle).
- Drivers are provisioned by granting the driver flag from `https://orders.brixbev.com/admin/audits` (Drivers panel — grant/revoke by email). Drivers need no customer membership; the flag alone gates the audit PWA.
- Never hard-delete staff records — set `status='inactive'` instead.

### Reference — gateway roles

| Role | Label | Access |
|---|---|---|
| `superadmin` | Super Administrator | Everything (melt, billing, finance, control, equipment, freshpet, resq) |
| `melt-super` | Melt Super User | Full Melt access except settings |
| `melt-project` | Melt Project Manager | Melt except payments |
| `melt-billing` | Melt Billing | Melt payments only |
| `melt-general` | Melt General | Melt equipment only |

The role→access map is duplicated server-side in the gateway's `apps.mjs` — anyone changing `auth.js` ROLES must update it in the same change.

### Procedure — provision a staff account

1. Sign in to `https://alamedapointbg.com` as superadmin/admin.
2. Open `/admin.html` → create user with email, name, role, and a temp password.
3. The temp-password generator is crypto-random and satisfies the password policy — do not substitute a hand-typed weak password.
4. Tell the user to sign in and change their password from the hub profile menu (the profile editor validates against the policy).
5. Record the new account and role in the onboarding note for the hire.

### Procedure — provision a driver

1. Open `https://orders.brixbev.com/admin/audits` → Drivers panel.
2. Enter the driver's email → Grant. If the user has no profile yet, a customer-less profile shell is created automatically.
3. Confirm the driver can open `https://orders.brixbev.com/audit` (branded `alamedapointbg.com/audit`) and see the customer search.
4. To revoke: same panel → Remove.

## Password policy

### Policy

- The shared Supabase project enforces **8+ characters with at least one lowercase, one uppercase, one digit, and one symbol**. Every password field in every APBG app must pre-validate against this policy client-side and map the raw GoTrue `weak_password` error to friendly copy.
- Generated temp passwords must be **crypto-random** (never `Math.random()`), 14–16 characters, guaranteed to include one character from each class.
- Every password entry point gets a show/hide eye toggle; every login point gets a "Forgot password?" flow.
- Password recovery links are minted server-side via `generateRecoveryLink` and point at the app's own `/set-password` page — never rely on GoTrue's `redirect_to`, which silently falls back to the shared project's Site URL (the gateway).

**Why:** in July 2026 both random temp-password generators emitted letters+digits only, so every password reset and new-user create 422'd against the four-class policy (brix-order 1.38); the same week, welcome-email links dumped customers on the gateway login instead of a set-password page because GoTrue ignored the redirect (1.37). These rules are the codified fixes.

### Procedure — reset a password for a user who is stuck

1. Portal customers: `https://orders.brixbev.com/admin` → customer → Users → "Resend welcome" (optionally with password reset). The email carries a one-time `/set-password` link.
2. Staff on the gateway: use the GoTrue `/recover` endpoint (documented in the gateway repo) or have them use the hub's forgot-password flow.
3. Never read a password to anyone over the phone; the link is the only transport.

## Credential handling

### Policy

- Secrets live **only** in Netlify env vars or Supabase secrets. Never in client code, never committed to a repo, never pasted into docs, tickets, or chat. Documents (including this handbook) name the env var, not the value.
- The Supabase **service_role key must never reach a browser** — client code uses the anon key only.
- Server-only secrets must never be `VITE_`-prefixed (Vite inlines those into the shipped bundle).
- The OAuth token caches `ops.qbo_token_cache` and `ops.sf_token_cache` are **never modified directly** — always go through the lease RPCs / Netlify Blobs.
- When a QBO or Service Fusion OAuth token dies (refresh failures), re-authenticate through `https://alamedapointbg.com/billing/setup.html`. That page is the single re-auth point for the shared token caches.
- One QBO realm (`9130352144155116`), **multiple distinct Intuit apps** connect to it. Each app has its own client_id and registered redirect URI. Never delete or "clean up" a redirect URI you don't recognize — it likely belongs to another app on the same realm.

**Why:** the shared SF refresh token silently started failing on 2026-06-29 (`Invalid refresh_token`) and the ResQ↔SF sync was down for days before anyone noticed — re-auth via setup.html is the recovery path, and knowing where tokens live (and not hand-editing the cache) is what keeps that recovery clean.

### Procedure — OAuth re-auth (QBO or Service Fusion)

1. Confirm the symptom: token-refresh errors in function logs, or Master Control health showing the sync down.
2. Open `https://alamedapointbg.com/billing/setup.html` as a superadmin.
3. Run the OAuth connect flow for the affected provider (QBO or SF). The callback writes the new token into the shared cache via the sanctioned path.
4. Verify: re-run the failing operation (e.g., a ResQ Sync tick from [Master Control](#/09-master-control)).

### Known credential expirations

Static tokens with a hard expiry date. When one lapses, the features it powers fail quietly — renew **before** the date, not after the breakage.

| Credential | Lives at | Expires | What breaks if it lapses | Renewal |
|---|---|---|---|---|
| `GITHUB_TOKEN` (classic PAT, `repo` scope) | apbg-billing Netlify env | **2027-01-01** | Handbook sweep + weekly drift emails, Live Architecture Mirror, Change Log tab, Auto-update button | Mint a new classic PAT at github.com/settings/tokens/new (`repo` scope) and replace the value at app.netlify.com/projects/apbg-billing/configuration/env |

The Monday drift-cron's sweep failures are the earliest symptom of a lapsed `GITHUB_TOKEN` — chapters flip to "unknown" with a rate-limit/not-found note. Add every new dated credential to this table when it's created (SOP-0 propagation rule).

## PCI posture — payment instrument data

### Policy

- **We never collect, transmit, store, or log raw card or bank account numbers in our code. No exceptions.** This is what keeps APBG at PCI SAQ A instead of SAQ D (~300 controls).
- Payment instrument **entry** happens only in one of two places: Bill & Pay's hosted window (embedded via `payersessionstart` iframe — data goes browser → B&P directly) or Intuit's tokenized hosted fields on the QBO Payments rail.
- The Bill & Pay API methods that accept raw instrument data (`paymentaccountadd`, and the `account.*` sub-block on `customerupdate`/`subscriptionadd`) are **never called** from our servers.
- `_lib/billandpay.ts` in brix-order is the **only module** allowed to call the Bill & Pay API. `paymentaccountinfo` is confined to its `listPaymentAccounts` function, which masks every account to last4 **inside the lib** — raw numbers are never returned, persisted, or logged anywhere in the codebase.
- Charging is **by reference only**: a saved `paymentaccount.internalid`, never an instrument.
- Legacy ACH data is not migrated out of Bill & Pay even though the API documents full routing/account fields — customers re-enter and re-authorize on the new rails (NACHA re-authorization + tokenize-at-Intuit posture).

**Why:** this boundary was designed deliberately and confirmed exhaustively against the full Bill & Pay API booklet (brix-order 1.68) — there is no PCI-safe raw-entry method, so any code that touches an instrument number would put the whole company in SAQ D scope. See [SOP-4 · Billing & Payments](#/24-sop-billing-payments) for the operational payment procedures.

## Voice-agent spoken codes

### Policy

- The phone-line access codes — `VOICE_TRAINING_CODE` (training mode), `VOICE_HQ_CODE` (HQ/MCP mode), and `VOICE_ASM_CODE` (ASM servers) — exist **only** as Netlify env vars. They are never written down (including in this handbook), never committed, never spoken to anyone who is not an owner.
- The agent (Ziggy) is built never to reveal the codes and never to mention gated capabilities unprompted; staff must hold the same line. If you believe a code has leaked, rotate it in the Netlify env immediately — rotation is env-only, no deploy of code changes required.
- Related voice-line secrets (`VOICE_BRAIN_TOKEN`, `RETELL_API_KEY`, `HQ_MCP_SERVERS`) follow the standard credential-handling policy above.

## Credential rotation & offboarding

> **Draft policy — proposed 2026-07-22, pending owner approval.**

### Draft policy — rotation cadence

- Rotate the voice-agent spoken codes and `VOICE_BRAIN_TOKEN` **quarterly**, and immediately on any suspected leak or any offboarding of a person who knew them.
- Rotate API credentials (`BILLANDPAY_*`, `RESEND_API_KEY`/`SENDGRID_API_KEY`, `ANTHROPIC_API_KEY`, `ADMIN_SYNC_TOKEN`, `BOT_SERVICE_SECRET`, `INTERNAL_PAY_SECRET`) **annually**, and immediately on suspected exposure.
- OAuth tokens (QBO, SF) self-rotate via refresh; re-auth via setup.html only when refresh breaks.
- Record each rotation (what, when, who) in the handbook change log or an ops note.

### Draft procedure — offboarding checklist

Run within one business day of a departure:

1. **Gateway account** — `https://alamedapointbg.com/admin.html`: delete the user (or downgrade the role if a transition period is agreed).
2. **Portal memberships** — `https://orders.brixbev.com/admin`: detach the user from every customer they were attached to; remove `is_superadmin` if set.
3. **Driver flag** — `/admin/audits` → Drivers panel → Remove, if they were a driver.
4. **Brixpense approver list** — remove their email from `ops.expense_settings.manager_emails` so purchase requests can no longer route to them.
5. **Voice line** — remove their phone number from any superadmin `customer_users.phone` caller-ID match; rotate every spoken code they knew.
6. **Shared credentials** — rotate any env-var secret they had direct access to (Netlify/Supabase dashboard access implies all of them — rotate the high-value ones per the cadence table and revoke their Netlify/Supabase/GitHub org access).
7. Confirm no personal email address remains in customer-facing routing (billing comms slots, alert recipients).

## Related

- [SOP-2 · Customer Lifecycle](#/22-sop-customer-lifecycle) — customer/portal user provisioning
- [SOP-4 · Billing & Payments](#/24-sop-billing-payments) — payment rails and the B&P bridge in operation
- [APBG Gateway — Operations Hub, Login, Roles & App Manager](#/01-gateway-hub)
- [Brix Order /admin — Staff Console](#/03-brix-order-admin)
- [AI Assistants — Chloe & Ziggy Phone Line](#/05-voice-ai-assistants)
- [SOP-9 · Data & Engineering](#/29-sop-data-engineering) — schema/secret rules for engineers
- Source docs: `skypace/apbg-gateway/CLAUDE.md`, `skypace/apbg-billing/CLAUDE.md`, `activespacescience/brix-order/CLAUDE.md`, `activespacescience/brix-order/docs/BILLANDPAY-API-CAPABILITIES.md`
