#!/usr/bin/env node
// Refresh architecture/schema-snapshot.json from the live Supabase project.
//
// Calls ops.fn_list_ops_tables() (SECURITY DEFINER, anon-callable), writes
// the alphabetized table list to schema-snapshot.json with today's date,
// and prints a diff: tables added since the last snapshot, tables removed.
//
// Run after merging any migration that creates or drops an ops.* table.
// The Netlify build runs `node architecture/lint-manifest.mjs` first, and
// the lint will fail if the manifest references tables that no longer exist
// (or if a new table has neither a writer nor an orphan entry).
//
// No external dependencies; runs on Node 22+ with fetch built in.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SB_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SB_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';

const SNAPSHOT_PATH = resolve(__dirname, 'schema-snapshot.json');
const MANIFEST_PATH = resolve(__dirname, 'sync-manifest.json');

async function fetchTables() {
  const res = await fetch(SB_URL + '/rest/v1/rpc/fn_list_ops_tables', {
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
    const text = await res.text();
    throw new Error('fn_list_ops_tables failed: ' + res.status + ' ' + text);
  }
  const tables = await res.json();
  if (!Array.isArray(tables)) {
    throw new Error('fn_list_ops_tables returned non-array: ' + JSON.stringify(tables));
  }
  return tables;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

(async () => {
  console.log('Fetching ops.* table list from Supabase…');
  const live = await fetchTables();
  console.log('  → ' + live.length + ' tables in prod.');

  const prior = readJson(SNAPSHOT_PATH);
  const priorSet = new Set(prior.tables);
  const liveSet = new Set(live);

  const added = live.filter((t) => !priorSet.has(t));
  const removed = prior.tables.filter((t) => !liveSet.has(t));

  if (added.length === 0 && removed.length === 0) {
    console.log('No drift — snapshot already in sync.');
    return;
  }

  if (added.length) {
    console.log('\nAdded tables (' + added.length + '):');
    for (const t of added) console.log('  + ops.' + t);
  }
  if (removed.length) {
    console.log('\nRemoved tables (' + removed.length + '):');
    for (const t of removed) console.log('  - ops.' + t);
  }

  // Heads-up if the manifest references any removed tables.
  if (removed.length) {
    const manifest = readJson(MANIFEST_PATH);
    const removedFq = new Set(removed.map((t) => 'ops.' + t));
    const writerHits = (manifest.writers ?? [])
      .flatMap((w) => (w.writes ?? []).filter((tbl) => removedFq.has(tbl)).map((tbl) => ({ writer: w.name, table: tbl })));
    const orphanHits = (manifest.orphans ?? []).filter((o) => removedFq.has(o.table));

    if (writerHits.length || orphanHits.length) {
      console.log('\n⚠ Manifest references tables that no longer exist:');
      for (const h of writerHits) console.log('  · writer "' + h.writer + '" claims ' + h.table);
      for (const o of orphanHits) console.log('  · orphan entry for ' + o.table + ' (will become a no-op)');
      console.log('Run `node architecture/lint-manifest.mjs` after committing this snapshot — it will fail until those manifest entries are removed.');
    }
  }

  writeJson(SNAPSHOT_PATH, {
    $comment: prior.$comment,
    captured_at: todayIsoDate(),
    schema: 'ops',
    tables: live.slice().sort(),
  });
  console.log('\nWrote ' + SNAPSHOT_PATH + ' (captured_at: ' + todayIsoDate() + ').');
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
