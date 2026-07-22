# SOP-9 · Data & Engineering — Schemas, Migrations, Secrets, AI Grounding Rules

> Part II · SOP Manual · Owner: Sky Pace · Last reviewed: 2026-07-22

This SOP is the engineering constitution for the shared Supabase project (`gfsdpwiqzshhexkofiif`) and the multi-repo system around it: who owns which schema, how schema changes ship, where secrets live, what the AI assistants are allowed to say, and the standing don't-break list. It's for anyone (human or Claude session) writing code in any APBG repo.

## Schema ownership

### Policy

- **`ops.*` is owned by the apbg-billing sync stack.** Any new writer to an `ops.*` table must be registered in `apbg-billing/architecture/sync-manifest.json` in the same change — the lint (`node architecture/lint-manifest.mjs`) runs as step 1 of the Netlify build and **fails the build** on drift. Every `ops` table either has a `writers[]` entry or sits in `orphans[]` with a reason; two writers on one table must both set `multi_writer: true` (lease-coordinated tables like `ops.qbo_token_cache` and append-only `ops.sync_log` are the sanctioned cases).
- **`orders.*` is owned by brix-order.** Other repos don't write it.
- **`ops` is READ-ONLY to brix-order.** It is the QBO mirror; brix-order reads it (invoices, customers, items) and never writes it — writes go through the apbg-billing sync functions and edge functions. This is on brix-order's don't-touch list and is not negotiable.
- When adding an `ops` table: add it to `schema-snapshot.json` (`node architecture/refresh-snapshot.mjs` after the migration), then claim it in `writers[]` or `orphans[]`, then run the lint.

## The edge-function default-schema trap

### Policy

- **Always pass `{ db: { schema: 'ops' } }` to `createClient`** (or use `.schema('ops').from(...)` per query) in Supabase Edge Functions and server code touching `ops`. `createClient(url, key)` defaults the JS data client to schema `public`; a `sb.from('qbo_invoices').insert(...)` against the default **silently no-ops** — PostgREST returns an error, supabase-js doesn't throw. RPC calls (`.rpc(...)`) are name-based and unaffected. *Why: this exact silent no-op has bitten edge functions before; it's called out in the repo orientation as a standing trap.*

## Migrations

### Policy

- Schema changes ship as **idempotent migration files in `supabase/migrations/`** of the owning repo, applied to the live project via the Supabase MCP (`apply_migration`) or `supabase db push`. Idempotent means safe to re-run.
- **Version prefixes must be unique across parallel sessions.** *Why: two same-day sessions both claimed `20260709000005` in brix-order; duplicate prefixes trip the Supabase CLI, and one migration had to be renamed (`20260709120000`).* Check the directory before numbering.
- **The repo must stay authoritative for deployed source.** Two standing violations to clean up, and never repeat:
  - The deployed `sync-qbo` edge function has **`mode=cdc` that the repo copy lacks** — deploying `apbg-billing/supabase/functions/sync-qbo/index.ts` as-is would wipe CDC (found 2026-07-11, session 1.65). Reconcile before any redeploy.
  - `qbo-stripe-deposit` and `qbo-record-external-payment` were deployed **MCP-only with no repo copy** (session 1.81) — the deployed source IS the source of truth; pull via Supabase MCP `get_edge_function` before editing, and commit repo copies as the cleanup.
- If the live DB was changed by hand or by a parallel session, write the migration file anyway so the repo records the state (as brix-order did for the invoice views).

### Procedure (new migration)

1. Write the idempotent SQL file in `supabase/migrations/` with a unique timestamp prefix.
2. Apply to live via Supabase MCP `apply_migration` (or CLI push).
3. If it touched `ops` tables: refresh the schema snapshot and update `sync-manifest.json`; run the lint.
4. Note the migration (and "applied live") in the repo `CLAUDE.md` change log entry for the session.

## Secrets

### Policy

- **Secrets live in environment variables** (Netlify env, Supabase function secrets) — never in code, commits, docs, or this handbook. Name the env var; never write the value.
- **The Supabase anon key is the only key allowed in client code.** The `service_role` key is server-only (Netlify functions, edge functions). Exposing service_role in a client bundle is a sev-1.
- **Never modify `ops.qbo_token_cache` or `ops.sf_token_cache` directly** — token access goes through the lease RPCs / Netlify Blobs. Re-auth happens at https://alamedapointbg.com/billing/setup.html, not by editing rows.
- New credential *categories* (not rotations) are an architecture change — see the handbook update rule below.

## Architecture handbook updates

### Policy

- **Any architecture-touching change updates `activespacescience/Skilliosis_Mytosis_Architecture/ARCHITECTURE.md` in the same change.** Triggers: a new external service, a new cross-repo dependency, a deploy-target change, a new/removed MCP connector, a new repo (or rename/archive/delete), a new env-var category, a new gateway proxy route. Update via the GitHub MCP (`asm-mcp-tools.netlify.app/github`, tool `github_create_or_update_file`), append a change-log row, keep the Mermaid diagram in sync. If the MCP isn't available in your session, surface the needed change in your response so it can be applied manually.
- **Brand-new projects are planned first** in that repo's `projects/<project-name>/` folder (`PRD.md`, `scoping.md`, `decisions.md`) with a placeholder row in `ARCHITECTURE.md` **before any code is written**. When the project graduates to its own repo, it gets its own `CLAUDE.md`.

## AI & bot grounding

### Policy

- **Customer-facing bots (Mr. Bubbles, Chloe) never invent prices, policies, or phone numbers.** Everything they say about terms and money must be grounded in the knowledge base or account data. The grounded support contacts are service@brixbev.com, the 800-372-5098 support line, and the AI phone line (510) 800-6281 — because those appear in the source documents.
- **Internal spoken codes never appear in prompts, docs, or the KB** (the voice agent's training/HQ/ASM codes are env vars — `VOICE_TRAINING_CODE`, `VOICE_HQ_CODE`, `VOICE_ASM_CODE` — compared server-side and never revealed). Owner-training content (`phone-teachings`) is flagged not-customer-visible so it can never leak into the customer Resources library.
- **KB changes go through the managed paths only:** the /admin/knowledge editor in brix-order (live immediately), or committing markdown to `content/knowledge-base/` + running `kb-ingest` post-deploy (idempotent, slug = filename). No other write path to the RAG.
- Customer-safe docs stay capability-phrased — no internal rail/bridge/vendor names in customer-visible content.

## Documentation

### Policy

- **The per-repo `CLAUDE.md` is the session log** — every working session appends a dated entry (what shipped, root causes, migrations applied, standing rules learned). It is the machine- and human-readable institutional memory.
- **This handbook is the human-facing layer** distilled from those logs — policies and procedures, not blow-by-blow.
- **Chapter freshness is machine-checked:** the handbook sweep in Master Control (`handbook-sweep`) compares each chapter's `last_reviewed` date in `docs/handbook/manifest.json` against the latest commit touching its registered sources. **When you re-verify a chapter against its sources, update its `last_reviewed` in the manifest** — that's what marks it fresh.

## The standing don't-break list

### Policy

These are absolute across all sessions and repos:

| Rule | Why |
|---|---|
| **Don't break the AP billing tool** (`apbg-billing/public/*.html` + `netlify/functions/`) | Daily driver for accounts payable. |
| **Don't break Brixpense** (`app-expense/` + `expense-request-*.mjs`) | Live expense/PR flow. |
| **No hard-deletes of staff records** — set `status='inactive'` | History must survive. |
| **Token caches only via lease RPCs / Netlify Blobs** | Direct edits break the lease coordination every sync depends on. |
| **No new `ops.*` writers without a sync-manifest entry** | The build lint enforces it; drift can't ship. |
| **brix-order never calls QBO directly and never writes `ops`** | Single-writer mirror discipline. |
| **Don't commit build output via the GitHub MCP with pre-encoded base64** | The MCP encodes again → double-encoded garbage served as the SPA (PR #61 cost a full day). Pass raw UTF-8 or build+commit locally. |
| **Duplicated role→access maps stay in sync** — `apbg-gateway/public/auth.js` ROLES and `netlify/functions/apps.mjs` hold copies | The gateway registry computes access server-side from its copy; updating one without the other silently mis-gates apps. |

## Related

- [SOP-0 · Policy Governance](#/20-sop-governance) — how this handbook itself is maintained
- [SOP-1 · Security & Access](#/21-sop-security-access) — accounts, roles, credential handling
- [SOP-6 · Service, Maintenance & Incident Response](#/26-sop-service-maintenance) — what to do when the rules above were broken anyway
- [Master Control](#/09-master-control) — the handbook sweep and health panels
- Source: `apbg-billing/CLAUDE.md` ("Do not" list), `apbg-billing/architecture/README.md` (sync manifest contract)
- Source: `brix-order/CLAUDE.md` (don't-touch list; sessions 1.28 migration-prefix collision, 1.65 sync-qbo drift, 1.81 MCP-only edge functions)
- Source: `apbg-gateway/CLAUDE.md` (role-map duplication), `APBG-Leasing-Rental/CLAUDE.md` + `Pacer-outlook/CLAUDE.md` (architecture handbook update rule)
- External: https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md
