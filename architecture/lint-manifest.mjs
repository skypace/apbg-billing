#!/usr/bin/env node
// Lint architecture/sync-manifest.json against architecture/schema-snapshot.json.
//
// Catches:
//   1. Manifest writers claim a table that doesn't exist in the snapshot.
//   2. Tables in the snapshot have neither a writer nor an orphan entry.
//   3. Multiple writers claim the same table without an explicit
//      multi_writer: true annotation.
//   4. A table appears in both writers[].writes and orphans (contradiction).
//
// Exit code 0 = clean. Non-zero = drift; details printed to stderr.
// No external dependencies; designed to run in CI with just `node`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readJson(name) {
  const path = resolve(__dirname, name);
  return JSON.parse(readFileSync(path, 'utf8'));
}

const manifest = readJson('sync-manifest.json');
const snapshot = readJson('schema-snapshot.json');

const errors = [];
const warnings = [];

// Index snapshot tables for O(1) lookup. Snapshot stores names without
// schema prefix; manifest uses fully-qualified ops.<table>.
const snapshotSchema = snapshot.schema;
const snapshotTables = new Set(snapshot.tables.map((t) => `${snapshotSchema}.${t}`));

// 1. Every claimed-write table must exist in the snapshot.
const writeClaims = new Map(); // table -> [writer names]
for (const writer of manifest.writers ?? []) {
  for (const table of writer.writes ?? []) {
    if (!snapshotTables.has(table)) {
      errors.push(
        `writer "${writer.name}" claims to write ${table}, ` +
          `but that table is not in schema-snapshot.json. ` +
          `Either the table was dropped (update the manifest) or the snapshot is stale (regenerate).`,
      );
    }
    if (!writeClaims.has(table)) writeClaims.set(table, []);
    writeClaims.get(table).push(writer.name);
  }
}

// 2. Every snapshot table must be claimed (or explicitly marked orphan).
const orphanSet = new Set((manifest.orphans ?? []).map((o) => o.table));
for (const fqTable of snapshotTables) {
  if (!writeClaims.has(fqTable) && !orphanSet.has(fqTable)) {
    errors.push(
      `table ${fqTable} has no writer entry and is not listed under orphans. ` +
        `Add a writer in sync-manifest.json or move it to the orphans list with a reason.`,
    );
  }
}

// 3. Multi-writer hotspots must opt in.
for (const [table, writers] of writeClaims) {
  if (writers.length > 1) {
    // Check if every writer for this table has multi_writer: true on this entry.
    const winningEntries = (manifest.writers ?? []).filter(
      (w) => writers.includes(w.name) && (w.writes ?? []).includes(table),
    );
    const allOpted = winningEntries.every((w) => w.multi_writer === true);
    if (!allOpted) {
      warnings.push(
        `table ${table} is claimed by multiple writers (${writers.join(', ')}) ` +
          `without all of them setting multi_writer: true. Either consolidate ownership ` +
          `or annotate. Today this is allowed for ops.qbo_token_cache (lease-coordinated) ` +
          `and ops.sync_log (append-only logging).`,
      );
    }
  }
}

// 4. Orphan ↔ writer contradiction.
for (const orphan of orphanSet) {
  if (writeClaims.has(orphan)) {
    errors.push(
      `table ${orphan} is listed as both an orphan AND claimed by writer(s) ` +
        `(${writeClaims.get(orphan).join(', ')}). Pick one.`,
    );
  }
}

// 5. Manifest entries must have required fields.
for (const writer of manifest.writers ?? []) {
  if (!writer.name) errors.push('writer entry missing required field: name');
  if (!writer.kind) errors.push(`writer "${writer.name}" missing required field: kind`);
  if (!Array.isArray(writer.writes)) {
    errors.push(`writer "${writer.name}" missing or non-array field: writes`);
  }
}
for (const orphan of manifest.orphans ?? []) {
  if (!orphan.table) errors.push('orphan entry missing required field: table');
  if (!orphan.reason) errors.push(`orphan ${orphan.table ?? '<unnamed>'} missing required field: reason`);
}

// Report.
if (warnings.length) {
  console.warn('--- WARNINGS ---');
  for (const w of warnings) console.warn('  ' + w);
}
if (errors.length) {
  console.error('--- ERRORS ---');
  for (const e of errors) console.error('  ' + e);
  console.error(`\n${errors.length} error(s), ${warnings.length} warning(s). Manifest dirty.`);
  process.exit(1);
}

const writerCount = (manifest.writers ?? []).length;
const orphanCount = (manifest.orphans ?? []).length;
const tableCount = snapshotTables.size;
console.log(
  `Manifest clean: ${writerCount} writers, ${orphanCount} orphans, ` +
    `${tableCount} tables in snapshot. ${warnings.length} warning(s).`,
);
process.exit(0);
