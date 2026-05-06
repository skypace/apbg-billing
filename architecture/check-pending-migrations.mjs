#!/usr/bin/env node
// Lists migration files in supabase/migrations/ alongside what's actually
// been applied to prod (per supabase_migrations.schema_migrations). Flags
// files whose name component doesn't appear in the applied list.
//
// Why this exists: Netlify doesn't auto-apply Supabase migrations on
// deploy. Migrations are applied manually (Supabase Studio, the CLI's
// `supabase db push`, or the `apply_migration` MCP tool). It's easy to
// merge a PR and forget to apply, leaving the schema and the repo out
// of sync. This script makes that drift visible.
//
// File naming convention: <YYYYMMDD><suffix?>_<name>.sql
// The matching key is the <name> portion (everything after the first _).
// MCP applies use the same name; supabase db push uses the full filename
// including date prefix as the version, but the function still records
// the same name. So matching by name works in both cases.
//
// Exit code: 0 always (informational only — applying is operational, the
// repo state isn't authoritative). Print to stdout for human review.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SB_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SB_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';

const MIGRATIONS_DIR = resolve(__dirname, '..', 'supabase', 'migrations');

async function fetchAppliedNames() {
  const res = await fetch(SB_URL + '/rest/v1/rpc/fn_list_applied_migrations', {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + SB_KEY,
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error('fn_list_applied_migrations failed: ' + res.status + ' ' + (await res.text()));
  }
  const names = await res.json();
  if (!Array.isArray(names)) {
    throw new Error('fn_list_applied_migrations returned non-array: ' + JSON.stringify(names));
  }
  return names;
}

// Strip the leading <YYYYMMDD><optional letter>_ prefix from a filename
// like 20260505d_taxonomy_drop_rep_tables.sql → taxonomy_drop_rep_tables
function nameFromFile(filename) {
  const stripped = filename.replace(/\.sql$/, '');
  const match = stripped.match(/^\d{8}[a-z]?_(.+)$/);
  return match ? match[1] : stripped;
}

(async () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const fileNames = files.map((f) => ({ file: f, name: nameFromFile(f) }));

  console.log('Fetching applied migrations from Supabase…');
  const applied = await fetchAppliedNames();
  const appliedSet = new Set(applied);
  console.log('  → ' + applied.length + ' migrations applied in prod.');

  const pending = fileNames.filter(({ name }) => !appliedSet.has(name));

  if (pending.length === 0) {
    console.log('\nAll repo migrations look applied.');
    return;
  }

  console.log('\n⚠ ' + pending.length + ' migration file(s) in the repo without a matching applied entry:');
  for (const p of pending) {
    console.log('  · ' + p.file + '  (name: ' + p.name + ')');
  }
  console.log('\nReasons this can happen:');
  console.log('  1. The migration was merged but never applied — apply it (Studio / CLI / MCP).');
  console.log('  2. The migration was applied under a different name (e.g. an MCP apply split');
  console.log('     one file into multiple statements with separate names). Check Supabase Studio');
  console.log('     migrations panel against the file content.');
  console.log('  3. The file was applied before supabase_migrations.schema_migrations existed.');
  console.log('     For very old migrations this is normal.');
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
