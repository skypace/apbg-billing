# Applying Supabase migrations

The Netlify deploy pipeline does **not** auto-apply migrations from
`supabase/migrations/`. Merging a migration PR ships the file to git but
leaves the prod schema unchanged until someone applies it.

This page documents the apply workflow + the drift checker.

## Applying a new migration

Three options, pick whichever is convenient:

### 1. Supabase MCP (preferred for Claude)

Claude Code with the Supabase MCP server uses the
`mcp__d091b47c…__apply_migration` tool to apply DDL. Each call records the
migration in `supabase_migrations.schema_migrations` with the name you
pass in. This is the path I've been using throughout this session.

### 2. Supabase Studio SQL editor

Open the project's SQL editor, paste the migration body, run. Studio
records the apply in `supabase_migrations.schema_migrations`.

### 3. Supabase CLI

```bash
supabase db push
```

Picks up everything in `supabase/migrations/` not yet in
`schema_migrations` and applies in order. Requires the project to be
linked (`supabase link --project-ref gfsdpwiqzshhexkofiif`).

## Checking for drift

After merging migration PRs, run:

```bash
node architecture/check-pending-migrations.mjs
```

It calls `ops.fn_list_applied_migrations()` (SECURITY DEFINER, anon-callable)
and prints any `*.sql` file in `supabase/migrations/` whose name component
isn't in the applied set. Common reasons for false positives:

- An MCP apply split one file into multiple `apply_migration` calls
  (e.g. PR #27's rep teardown applied as `taxonomy_drop_rep_tables` +
  `rep_free_rpcs` + `rep_free_rpcs_part2`). The original file
  (`20260505d_taxonomy_drop_rep_tables.sql`) appears pending even though
  its content is live.
- Very old files applied before `supabase_migrations.schema_migrations`
  existed are listed as pending.

When the script flags a real pending migration, apply via one of the
three paths above.

## Why isn't this CI-enforced?

The lint catches manifest drift because the snapshot is checked into git.
Migration drift is operational — applying is a deploy action, not a
correctness property of the code. Failing CI on "you forgot to apply"
would also fail on every PR until the merge happens, which is annoying.
The script is a deliberate "informational, run when you want to check"
tool rather than a gate.

If we ever want CI enforcement, the right shape is a separate "apply on
merge" GitHub Action gated on the `main` branch — not a build-time check.
That's a future-state migration; today's convention is manual apply +
this drift checker.
