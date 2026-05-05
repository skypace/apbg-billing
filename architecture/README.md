# Architecture metadata

This directory holds machine-checkable contracts about the cross-repo APBG architecture. Today, that's the **sync orchestration manifest**: an authoritative registry of which function (or human action) writes which `ops.*` table in the shared Supabase project.

## Why

APBG runs across multiple repos (`apbg-billing`, `apbg-ops`, `apbg-gateway`, plus Supabase Edge Functions whose source isn't in either repo) — all of which read and write the same Supabase schema. The architecture review (§12 #4) flagged that there was no single place to answer "who writes this column?" or "are there orphan tables?" without grepping every repo. Doc-discipline alone wasn't enough; we picked the machine-checkable path.

## Files

- **`sync-manifest.json`** — the contract. Every `ops.*` table either has a `writers[]` entry that claims it or appears in `orphans[]` with a reason. Entries record schedule, source repo, external inputs, and a `last_verified` date.
- **`schema-snapshot.json`** — a static dump of `information_schema.tables` for the `ops` schema. Lint compares the manifest against this, not the live DB, so CI runs without DB credentials.
- **`lint-manifest.mjs`** — Node script (no external deps). Validates the four contract rules below. Exit 0 = clean; non-zero = drift.

## Contract rules

The lint script enforces:

1. **Every `writers[].writes` entry references a real table.** Catches stale manifest entries after a column or table rename.
2. **Every snapshot table has a writer or an orphan entry.** Catches new tables that landed without an owner being recorded.
3. **Multi-writer hotspots opt in.** When two writers claim the same table, both must set `multi_writer: true` (e.g. `ops.qbo_token_cache` is written by every QBO sync via the lease RPC; `ops.sync_log` is append-only logging from every sync). This makes lease-coordinated tables explicit and forces consolidation otherwise.
4. **Required fields.** Every writer needs `name`, `kind`, `writes`. Every orphan needs `table` and `reason`.

## How to use

### Linting

```bash
node architecture/lint-manifest.mjs
```

Run before merging any PR that adds or removes an `ops.*` table, or that adds a new sync function. (CI wiring: TODO — add to a Netlify build step or a GitHub Action.)

### Adding a new sync function

1. Add an entry to `writers[]` in `sync-manifest.json` with the table list, schedule, and source repo.
2. If the new function writes a token-cache or `sync_log` (already multi-writer tables), set `multi_writer: true`.
3. Run the lint to confirm.

### Adding a new table

1. Add the bare table name to `tables` in `schema-snapshot.json`.
2. Either claim it in a `writers[]` entry, or add it to `orphans[]` with a reason explaining why no writer exists yet.
3. Run the lint to confirm.

### Refreshing the snapshot

Today this is manual: query `information_schema.tables` against the live Supabase project and replace the `tables` array in `schema-snapshot.json`. The snapshot for 2026-05-05 was captured via:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'ops' AND table_type = 'BASE TABLE'
ORDER BY table_name;
```

A `refresh-snapshot.mjs` helper (TODO) would automate this with a service-role key.

## Out of scope (intentional)

- **Column-level granularity.** The manifest tracks tables, not columns. Column ownership matters for cases like `ops.qbo_items.purchase_cost`, but the v1 lint focuses on the larger problem (orphans, multi-writers). Column-level upgrade is straightforward when needed.
- **Read tracking.** Only writes are claimed. Reads happen everywhere; tracking them is a different problem (architecture review §12 #3).
- **The `public.*` schema.** Equipment portal tables (~42 tables) are out of scope here. They're billing-tool / customer-portal data with separate ownership; if they need their own manifest, that's a follow-up.

## Cross-repo coordination

The canonical copy of this manifest is in `skypace/apbg-billing` (this repo). When `apbg-ops` adds a function or table, it should open a PR against this repo to update the manifest in the same change set. The lint script lives here for now; if the cross-repo cadence picks up, it could move to a shared CI runner.
