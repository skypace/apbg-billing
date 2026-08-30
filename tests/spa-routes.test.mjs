import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Every Brixpense route is a SIBLING under one layout route, so a RELATIVE
// navigate() resolves against the current route and lands somewhere that
// matches nothing — and App.tsx's catch-all then bounces you to the landing
// page. That is exactly what "I click edit and it goes back to the main
// screen" was: /expense/bills + "edit/<id>" = /expense/bills/edit/<id>.
//
// It fails SILENTLY (no error, no 404 — just a redirect), and it worked on
// LandingPage because that one is the index route, which is what made it look
// like the pages were fine. So the rule is absolute paths everywhere, and this
// pins it.
const SRC = new URL('../app-expense/src/', import.meta.url).pathname;

function tsxFiles(dir) {
  return readdirSync(join(SRC, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.tsx'))
    .map((e) => join(SRC, dir, e.name));
}

const files = [...tsxFiles('pages'), ...tsxFiles('components')];

test('every navigate() target is absolute', () => {
  // A leading "/" or a template/variable is fine; a bare word is not.
  const RELATIVE = /navigate\(\s*(?:`(?!\/|\$)[a-z]|'(?!\/)[a-z]|'')/i;
  const offenders = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (RELATIVE.test(line)) offenders.push(`${f.split('/src/')[1]}:${i + 1} ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [],
    `relative navigate() targets bounce to the landing page:\n${offenders.join('\n')}`);
});

test('the guard actually catches a relative target', () => {
  const RELATIVE = /navigate\(\s*(?:`(?!\/|\$)[a-z]|'(?!\/)[a-z]|'')/i;
  assert.ok(RELATIVE.test("navigate(`edit/${r.id}`)"), 'template literal');
  assert.ok(RELATIVE.test("navigate('pending')"), 'bare string');
  assert.ok(RELATIVE.test("navigate('')"), 'empty string');
  assert.ok(!RELATIVE.test("navigate(`/edit/${r.id}`)"), 'absolute template');
  assert.ok(!RELATIVE.test("navigate('/pending')"), 'absolute string');
  assert.ok(!RELATIVE.test('navigate(-1)'), 'history back is fine');
});
