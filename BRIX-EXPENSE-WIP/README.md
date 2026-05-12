# Brix Expense — Work in Progress (transfer kit)

This folder holds the in-progress code for **Brix Expense** that was started in `skypace/apbg-billing` before we decided to move the project to its own repo (per the architectural conversation on 2026-05-12).

**Nothing in this folder is wired up.** It does not affect any build in `apbg-billing`. It exists so the work isn't lost on the way to the new repo.

## Why a new repo

See the full reasoning in `BRIX-EXPENSE-SPEC.md` at the repo root and the conversation that led here. Short version: different audience (every employee vs ops managers), different visual identity (Brix navy mobile-first vs ops dark dashboard), different deploy cadence, and isolation against the kind of cross-page accidents we already hit in `apbg-billing/app/`.

## What's here

| File | Where it should go in the new repo |
|---|---|
| `app/expense.ts` | `src/lib/expense.ts` — shared types, COGS account whitelist, tags, departments, managers, threshold, API wrappers for `process-inbound` / `approve-bill` / new `expense-request-*` endpoints |
| `app/expense.css` | Folded into `src/index.css` once Tailwind is installed natively (preflight ON) — drop the `.brix-expense` scope wrapper |
| `app/tailwind.config.js` | `tailwind.config.js` — drop `corePlugins.preflight: false` and the scoped `content` paths once it's in its own repo |
| `app/postcss.config.js` | `postcss.config.js` — copy as-is |
| `app/ui/*` | `src/components/ui/*` — these are minimal shadcn-style primitives (Button, Input, Card, Badge). Replace with native `npx shadcn@latest add button input card badge label select textarea dialog form` once the new repo is scaffolded |
| `netlify/expense-request-helpers.mjs` | `netlify/functions/expense-request-helpers.mjs` — Supabase service-role wrapper, Resend email sender, approval-email HTML template, single-use approval-token generator |
| `supabase/20260512a_brix_expense_requests.sql` | `supabase/migrations/20260512a_brix_expense_requests.sql` — applies to the **same Supabase project** (shared with apbg-billing). Apply via the Supabase MCP or Studio once Sky confirms |

## What's still to build in the new repo

The spec at `BRIX-EXPENSE-SPEC.md` (repo root) lists everything. Not yet started:

- `pages/expense/index.tsx` — landing (Expense vs Purchase Request)
- `pages/expense/ExpenseForm.tsx` — Mode A (receipt drop → OCR → review → submit)
- `pages/expense/PurchaseRequestForm.tsx` — Mode B (quote upload → manager picker)
- `pages/expense/ApprovalPage.tsx` — `/expense/approve/<token>` — manager review + signature pad + decision
- `pages/expense/PendingList.tsx` — submitter's + manager's queues
- `components/SignaturePad.tsx` — wraps `react-signature-canvas`
- Netlify functions: `expense-request-create.mjs`, `expense-request-decide.mjs`, `expense-request-notify.mjs` (helpers already in `netlify/expense-request-helpers.mjs`)

## Stack the new repo should start with

```
npm create vite@latest brix-expense -- --template react-ts
cd brix-expense
npm install @supabase/supabase-js react-hook-form zod @hookform/resolvers \
  react-signature-canvas lucide-react
npm install -D tailwindcss postcss autoprefixer @types/react-signature-canvas
npx tailwindcss init -p
npx shadcn@latest init
npx shadcn@latest add button input card badge label select textarea dialog form
```

## Open questions before building

Still unanswered from §11 of the spec:

1. Brix brand spec — exact hex / fonts / logo.
2. Manager Marco's email — confirm `marco@brixbev.com`.
3. Signature pad reference — the Melt dashboard implementation.
4. Resend `RESEND_API_KEY` env + verified sender on `alamedapointbg.com`.
5. Tag + Department lists — confirm the defaults in `app/expense.ts` (`TAGS`, `DEPARTMENTS`).
