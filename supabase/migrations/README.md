# Migrations — how they work in this repo

Read this before adding a file here. Two things surprise people, and both have
already cost a session.

## They are applied through the Supabase MCP, not the CLI

There is **no `supabase/config.toml`** — the Supabase CLI was never wired up
against this project. Every migration in this directory was applied with the MCP
`apply_migration` tool against the live project (`gfsdpwiqzshhexkofiif`), and the
file here is the record of what was run.

That has a consequence worth understanding: the remote
`supabase_migrations.schema_migrations` table stores an **apply-time timestamp**
in `version` (e.g. `20260823024205`) and the migration's name in `name`. Nothing
keys on the filename prefix. So `supabase db push` will not do anything sensible
here — local filenames and remote versions don't correspond — and renaming a file
in this directory changes nothing about what is applied.

**Workflow for a new migration:** write the `.sql` file here, apply it with the
MCP, verify the result with a query, and commit the file in the same change as
the code that depends on it.

## Naming: `YYYYMMDD<letter>_<slug>.sql`

`20260821b_health_extra_reconcile.sql` — date, then a lowercase letter for the
Nth migration that day, then a short slug.

**List the directory before you pick a letter.** Parallel sessions are the norm
in this repo, and two sessions reaching for `20260820a` on the same day is how
the existing collisions happened:

```
ls supabase/migrations/ | grep '^20260823'
```

There are **7 collided prefixes already** (`20260514a/b/c`, `20260704j/k`,
`20260820a/b`). They are **grandfathered — do not rename them.** Change-log
entries and architecture docs cite those filenames, nothing functional depends on
the prefix, and rewriting them only creates conflicts for whatever branches are
in flight. Just don't add more.

## The trap that bites hardest: shared functions

Several migrations do `CREATE OR REPLACE FUNCTION` on functions that many
features contribute to — `ops.fn_sync_health_extra()` above all.

On 2026-08-21 two branches each re-declared that whole function from their own
copy of its body. The one that applied second silently deleted the other's
`distributor_notify` health check, leaving a notification pipeline unmonitored
with nothing going red. Fixed by `20260821b_health_extra_reconcile.sql`.

**Never rebuild a shared function from a copy pasted out of an older migration.**
Read the live definition first and add your part to *that*:

```sql
select pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'ops' and p.proname = 'fn_sync_health_extra';
```

Then verify every check still reports afterwards:

```sql
select check_name, status from ops.sync_health() order by check_name;
```

## Related rules

- Any new credential/token store ships with a health check in
  `ops.fn_sync_health_extra()` in the same change (see the "Do not" list in
  `CLAUDE.md`).
- Any new writer to an `ops.*` table needs an entry in
  `architecture/sync-manifest.json` — `node architecture/lint-manifest.mjs`
  fails the Netlify build otherwise.
- `CREATE OR REPLACE` on a guard-wrapped function replaces the **wrapper** and
  silently drops its guard — edit the `__i` inner instead. See
  `20260820b_rpc_guard_anon_hygiene.sql`.
