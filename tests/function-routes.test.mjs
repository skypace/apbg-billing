// A Netlify v2 function that declares `export const config = { path }` is served
// ONLY at that path — the legacy /.netlify/functions/<name> route 404s for it.
//
// This bit twice on the same pipeline: bill-email-intake's hand-off and the
// Vendor Inbox's "Try again" button both kicked the legacy route, so every
// forwarded bill was recorded and then abandoned at "Scanning…". Neither
// surfaced it, because fetch() does not throw on a 404 and only the throw was
// handled — a dead kick reads exactly like a working one.
//
// So: nothing may fetch /.netlify/functions/<name> when that function declares a
// path of its own — not a sibling function, and not a static page either.
//
// The static-page half was added after a Master Control panel shipped calling
// ${APBG_FN}/service-margin-report at the legacy route while the function served
// only /api/service-margin-report. control.html holds most of the operator
// buttons in this repo and was not being scanned at all, so the exact bug this
// file exists to stop had an unguarded door.

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

// --- static pages -------------------------------------------------------
// control.html and its neighbours call functions through a base const, so the
// literal in the source reads `${APBG_FN}/name` — kicksIn() matches on the
// route literal, which is present either way.

const PAGES = readdirSync('public')
  .filter((f) => f.endsWith('.html'))
  .map((f) => join('public', f));

test('no static page kicks a function at a route that function does not serve', () => {
  const paths = declaredPaths();
  const broken = [];
  for (const page of PAGES) {
    const src = readFileSync(page, 'utf8');
    // `${APBG_FN}/name` is the shape in these pages; the literal base appears
    // in the const declaration, so resolve the template through it.
    const viaConst = [...stripComments(src).matchAll(/\$\{APBG_FN\}\/([a-z0-9-]+)/gi)].map((m) => m[1]);
    for (const target of [...kicksIn(src), ...viaConst]) {
      if (paths.has(target)) {
        broken.push(`${page} calls ${target} at the legacy route, but it is served only at ${paths.get(target)}`);
      }
    }
  }
  assert.deepEqual(broken, [], `dead route(s) from a static page:\n  ${broken.join('\n  ')}`);
});

test('the static-page guard resolves the APBG_FN template, not just bare literals', () => {
  const viaConst = (src) => [...stripComments(src).matchAll(/\$\{APBG_FN\}\/([a-z0-9-]+)/gi)].map((m) => m[1]);
  assert.deepEqual(viaConst('fetch(`${APBG_FN}/service-margin-report?x=1`)'), ['service-margin-report']);
  // APBG_API is the correct base and must NOT be flagged
  assert.deepEqual(viaConst('fetch(`${APBG_API}/service-margin-report`)'), []);
  assert.deepEqual(viaConst('// ${APBG_FN}/service-margin-report is the old route'), []);
});
