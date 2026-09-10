# Recovered edge-function sources (2026-09-10)

## The rule this exists to enforce

**A deployed Supabase edge function must have a source file in a repo.**

If it does not, the deployed copy is the only copy: nobody can read what it
does, review a change to it, or restore it if the platform loses it. This
repo has been bitten by the softer version of that three times already —
`sync-qbo` (repo copy diverged from deployed, session 1.65 in brix-order),
`qbo-stripe-deposit` (repo at v1 while v2 was live, 2026-09-04), and
`v_inventory_drift` (SQL applied straight through the MCP with no migration
file, 2026-09-02). This is the same failure with the volume turned up.

## What happened

An audit on 2026-09-10 compared the 52 functions deployed on
`gfsdpwiqzshhexkofiif` against every tracked file in the six repos cloned at
the time (APBG-OPS, apbg-billing, apbg-gateway, brix-cashapp, brix-order,
melt-dashboard). **Eighteen had no source anywhere.** Most were applied
directly through the Supabase MCP by a session that never committed the
file — some as far back as April 2026, two of them the day before the audit.

All eighteen are now in this directory, pulled from the deployed source via
`get_edge_function`.

⚠ **The nine `apbg-resq-sync` functions were NOT orphans** and are not here.
Their `entrypoint_path` reads `/home/runner/work/apbg-resq-sync/...`, which
proves they are CI-deployed from that repo: `sync-wo`, `sync-tick`,
`sync-watch`, `resq-inbound`, `sf-inbound`, `invoice-inbound`, `sf-connect`,
`sf-cancel`, `resq-rest-sandbox`.

## What was recovered

| Function | Deployed version | Note |
|---|---|---|
| `sync-qbo-payments` | 1 | **The one that mattered.** Feeds `ops.qbo_payments`, which the brix-order Payments & Credits page reads. On pg_cron `25 9,21 * * *`. Created 2026-09-08, never committed. |
| `qbo-fix-duplicate-payments` | 1 | One-off surgery for the 14 double-booked Stripe payments. Defaults to preview. Created 2026-09-08. |
| `sync-qbo-customers` | 14 | QBO Customer master → `ops.qbo_customers`. |
| `push-qbo-customer-types` | 14 | Channel taxonomy → QBO CustomerType. Dry-run by default. |
| `push-qbo-sales-rep` | 14 | Primary sales rep → QBO Customer custom field. Dry-run by default. |
| `push-qbo-budget` | 14 | Sales plan → QBO budget CSV/JSON. `verify_jwt: true`. |
| `shopify-qbo-sync` | 3 | Replaces the Intuit QBO Commerce Shopify channel app. Inert until `ops.shopify_sync_config.enabled`. |
| `stale-invoice-alert` | 25 | Weekly uninvoiced-jobs email. |
| `sf-oauth-callback` | 22 | **The LIVE Service Fusion OAuth callback.** See the warning below. |
| `sf-tech-probe` | 22 | SF job-shape probe. Diagnostic. |
| `admin-users` | 14 | Auth admin wrapper for the APBG-OPS Settings → Users tab. |
| `digest-email` | 16 | Sales/health analytics digest via Resend. |
| `export-csv` | 14 | Saved view → CSV for Google Sheets `IMPORTDATA`. |
| `upload-seal` | 9 | Base64 → `brix-catalog-images` bucket. |
| `melt-requests-forward` | 35 | `meltrequests@` inbound → forward to three people. |
| `send-melt-welcome` | 36 | Melt portal welcome email. `verify_jwt: true`. |
| `resq-introspect` | 17 | Neutralized 2026-06-27. Inert 410 stub. |
| `dispatch-geocode` | 2 | Retired 2026-09-07. Inert 410 stub. |

## ⚠ Two name collisions that are NOT the same code

- **`sf-oauth-callback`** — the edge function here is the LIVE callback: its
  redirect URI is registered on the billing Service Fusion app and it writes
  `ops.sf_token_cache`. `netlify/functions/sf-oauth-callback.mjs` in this
  repo is a **different, unreachable** file (see CLAUDE.md 2026-09-07: its
  redirect URI is registered on none of the three SF apps, it never writes
  `ops.sf_token_cache`, and it prints the refresh token on its success page).
  Do not merge or "deduplicate" them.
- **`admin-users`** — the edge function here serves APBG-OPS. The gateway's
  `netlify/functions/admin-users.mjs` is a separate implementation with a
  different role model. Same name, different systems.

## ⚠ These are recovered, not proven byte-identical

Each file was transcribed from the `get_edge_function` response and
**parse-checked** with esbuild. That proves the syntax is valid, not that
every byte matches what is running. Supabase exposes `ezbr_sha256` for the
*bundle*, not for the source, so there is no hash to compare against.

**So: diff before you deploy from this directory.** Read the deployed source
first (`get_edge_function`), compare, and only then deploy. That is the same
discipline the 2026-09-04 `qbo-stripe-deposit` v3 change followed, and it is
what stops a recovery from silently becoming a regression.

## Still uncovered, deliberately

`tmp-qbo-payment-probe` and `tmp-qbo-item-split` are throwaway diagnostics
from earlier sessions. They are not worth a source file — they are worth
**deleting from the Supabase project**, because a deployed probe is live
attack surface for no benefit. Left alone here because deleting live
infrastructure is the owner's call, not a side effect of a tidy-up.

## Homes that may belong elsewhere

Everything landed here because apbg-billing is where this project's edge
functions already live (21 of them before this). Two arguably belong to
another repo and can be moved whenever convenient — moving a source file is
cheap, having none is not:

- `dispatch-geocode` → `skypace/apbg-dispatch` (its own comment says so)
- `melt-requests-forward`, `send-melt-welcome` → `skypace/melt-dashboard`
