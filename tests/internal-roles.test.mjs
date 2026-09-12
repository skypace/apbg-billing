// The API's idea of "internal" must be the database's idea of "internal".
//
// netlify/functions/lib/auth.mjs INTERNAL_ROLES is a mirror of
// ops.fn_is_internal() (supabase/migrations/20260911b). A role added to one
// and not the other is a login the database admits and the function refuses —
// which is exactly how a production user came to be able to run a work order
// and not open its PO as a PDF (2026-09-12). This test reads both lists and
// fails when they disagree, and fails when any production function has gone
// back to a hand-typed ['superadmin','admin'] gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INTERNAL_ROLES, INTERNAL_WRITER_ROLES } from '../netlify/functions/lib/auth.mjs';

const MIGRATION = 'supabase/migrations/20260911b_the_compliance_vault_admits_internal_logins.sql';

function sqlInternalRoles() {
  const src = readFileSync(MIGRATION, 'utf8');
  // the IN (...) list on the fn_is_internal definition
  const m = src.match(/in\s*\(\s*((?:'[a-z-]+'\s*,?\s*)+)\)\s*or\s*\(auth\.jwt\(\)->'user_metadata'->>'role'\)\s*like\s*'ops-%'/i);
  assert.ok(m, 'could not find the fn_is_internal role list in ' + MIGRATION);
  const named = [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
  // `like 'ops-%'` covers the five gateway ops roles
  return new Set([...named, 'ops-super', 'ops-delivery', 'ops-service', 'ops-reman', 'ops-viewer']);
}

test('INTERNAL_ROLES mirrors ops.fn_is_internal()', () => {
  const sql = sqlInternalRoles();
  assert.deepEqual(new Set(INTERNAL_ROLES), sql);
  assert.equal(INTERNAL_ROLES.length, 13);
});

test('the writer list is the internal list minus the read-only role', () => {
  assert.deepEqual(new Set(INTERNAL_WRITER_ROLES), new Set(INTERNAL_ROLES.filter((r) => r !== 'ops-viewer')));
  assert.ok(INTERNAL_WRITER_ROLES.includes('production'));
  assert.ok(INTERNAL_WRITER_ROLES.includes('ops-super'));
  assert.ok(!INTERNAL_WRITER_ROLES.includes('ops-viewer'));
});

test('the production functions gate on INTERNAL_WRITER_ROLES, not a hand-typed admin list', () => {
  for (const f of ['production-doc', 'po-receive', 'po-qbo-push', 'repack', 'qbo-purchasing-sync']) {
    const src = readFileSync(`netlify/functions/${f}.mjs`, 'utf8');
    assert.ok(!/requireAuth\([^)]*\[\s*'superadmin'\s*,\s*'admin'\s*\]/.test(src), `${f} still gates on ['superadmin','admin']`);
    assert.ok(/requireAuth\([^)]*INTERNAL_WRITER_ROLES/.test(src), `${f} does not gate on INTERNAL_WRITER_ROLES`);
  }
});
