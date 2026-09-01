// A Netlify v2 function that declares `export const config = { path }` is served
// ONLY at that path — the legacy /.netlify/functions/<name> route 404s for it.
//
// This bit twice on the same pipeline: bill-email-intake's hand-off and the
// Vendor Inbox's "Try again" button both kicked the legacy route, so every
// forwarded bill was recorded and then abandoned at "Scanning…". Neither
// surfaced it, because fetch() does not throw on a 404 and only the throw was
// handled — a dead kick reads exactly like a working one.
//
// So: no function may fetch a sibling at /.netlify/functions/<name> when that
// sibling declares a path of its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'netlify/functions';
const files = readdirSync(DIR).filter((f) => f.endsWith('.mjs'));

/** name -> declared config.path, for every function that declares one */
function declaredPaths() {
  const out = new Map();
  for (const f of files) {
    const src = readFileSync(join(DIR, f), 'utf8');
    if (!/export\s+const\s+config\s*=/.test(src)) continue;
    const m = src.match(/path:\s*['"]([^'"]+)['"]/);
    if (m) out.set(f.replace(/\.mjs$/, ''), m[1]);
  }
  return out;
}

/** strip comments, so a route named in prose is not mistaken for a call */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * every /.netlify/functions/<name> a source builds a URL for.
 *
 * ⚠ Deliberately NOT anchored on `fetch(` — the first version of this guard
 * was, and it passed on the very bug it was written for, because the fix had
 * hoisted the URL into a `kickUrl` const and called `fetch(kickUrl)`. The URL
 * literal is what's wrong; where it is consumed is incidental.
 */
function kicksIn(src) {
  const hits = [];
  const re = /\/\.netlify\/functions\/([a-z0-9-]+)/gi;
  let m;
  while ((m = re.exec(stripComments(src)))) hits.push(m[1]);
  return hits;
}

test('no function kicks a sibling at a route that sibling does not serve', () => {
  const paths = declaredPaths();
  assert.ok(paths.size > 0, 'expected at least one path-declaring function');

  const broken = [];
  for (const f of files) {
    for (const target of kicksIn(readFileSync(join(DIR, f), 'utf8'))) {
      if (paths.has(target)) {
        broken.push(`${f} fetches /.netlify/functions/${target}, but ${target} is served only at ${paths.get(target)}`);
      }
    }
  }
  assert.deepEqual(broken, [], `dead internal route(s):\n  ${broken.join('\n  ')}`);
});

test('the guard catches a kick at a path-declaring function', () => {
  // proves the matcher is doing work rather than passing vacuously
  const paths = new Map([['bill-email-process-background', '/api/bill-email-process-background']]);

  // the shape the bug shipped in
  const inline = "await fetch(`${base}/.netlify/functions/bill-email-process-background`, { method: 'POST' })";
  assert.deepEqual(kicksIn(inline), ['bill-email-process-background']);
  assert.ok(paths.has(kicksIn(inline)[0]));

  // and the shape the FIX was in, which an anchored-on-fetch matcher missed
  const hoisted = "const kickUrl = `${base}/.netlify/functions/bill-email-process-background`;\nawait fetch(kickUrl, {});";
  assert.deepEqual(kicksIn(hoisted), ['bill-email-process-background']);

  // a comment naming the route is prose, not a call
  assert.deepEqual(kicksIn('// the /.netlify/functions/bill-email-process-background route 404s'), []);
  assert.deepEqual(kicksIn('/* see /.netlify/functions/bill-email-process-background */'), []);

  // a function that declares no path of its own is reachable there, so it is fine
  assert.equal(paths.has(kicksIn("fetch('/.netlify/functions/vendor-email-intake')")[0]), false);
});
