// tests/mcp-oauth.test.mjs — pins the two failures that made every MCP connector
// on the Supabase authorization server unusable, found 2026-08-28.
//
// Neither had a symptom that named its own cause, which is why both survived:
//
//  1. public/oauth/consent.html read the WRONG KEY off approveAuthorization().
//     supabase-js resolves with { data: { redirect_url } }; the page looked only
//     for redirect_to / redirectTo, found nothing, and printed "Access approved.
//     You can close this tab" — so the consent was recorded but the authorization
//     CODE never reached the client. The client then waited for a callback that
//     would never arrive and timed out, which reads as "authentication is slow".
//     Live evidence at the time: 44 dynamically-registered Claude clients and 22
//     granted consents on this authorization server, and ZERO rows in
//     auth.sessions carrying an oauth_client_id — not one token ever issued.
//
//  2. netlify/functions/mcp-auth-status.mjs ran requireAuth BEFORE answering the
//     CORS preflight. mcp.html is served from alamedapointbg.com and calls
//     apbg-billing.netlify.app with an Authorization header, so the browser sends
//     an OPTIONS preflight first — and browsers never put Authorization on a
//     preflight. requireAuth saw no bearer, returned 401, the preflight failed,
//     and the real GET was never sent. The page could only report the browser's
//     generic "Failed to fetch", naming neither CORS nor auth.
//
// These are static assertions on purpose: they need no browser and no network, so
// they run inside `npm test` on every change instead of only when someone thinks
// to open the page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const consentHtml = readFileSync(join(ROOT, 'public/oauth/consent.html'), 'utf8');
const statusFn = readFileSync(join(ROOT, 'netlify/functions/mcp-auth-status.mjs'), 'utf8');

// Lift the page's own redirectTo() out of the HTML and run it, so the test
// exercises the shipped implementation rather than a copy that can drift.
function loadRedirectTo() {
  const m = consentHtml.match(/function redirectTo\(data\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'redirectTo() not found in consent.html — did it get renamed?');
  const calls = [];
  const location = { set href(v) { calls.push(v); }, get href() { return calls.at(-1); } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('location', `${m[0]}; return redirectTo;`)(location);
  return { fn, calls };
}

test('consent page follows redirect_url — the key supabase-js actually returns', () => {
  const { fn, calls } = loadRedirectTo();
  const target = 'https://claude.ai/api/mcp/auth_callback?code=abc123&state=xyz';
  assert.equal(fn({ redirect_url: target }), true, 'must accept data.redirect_url');
  assert.equal(calls.at(-1), target, 'must navigate to the client callback, code and all');
});

test('consent page still accepts the other spellings, so an SDK rename degrades gracefully', () => {
  for (const key of ['redirectUrl', 'redirect_to', 'redirectTo']) {
    const { fn, calls } = loadRedirectTo();
    assert.equal(fn({ [key]: 'https://example.test/cb' }), true, `must accept data.${key}`);
    assert.equal(calls.at(-1), 'https://example.test/cb');
  }
});

test('consent page unwraps a nested data envelope', () => {
  const { fn, calls } = loadRedirectTo();
  assert.equal(fn({ data: { redirect_url: 'https://example.test/nested' } }), true);
  assert.equal(calls.at(-1), 'https://example.test/nested');
});

test('a response with no redirect anywhere reports failure rather than navigating', () => {
  const { fn, calls } = loadRedirectTo();
  assert.equal(fn({ ok: true }), false);
  assert.equal(fn(null), false);
  assert.equal(fn(undefined), false);
  assert.equal(calls.length, 0, 'must not navigate when there is nothing to navigate to');
});

test('consent page never tells the user it worked when the code was not handed back', () => {
  // The old copy — "Access approved. You can close this tab and return to the
  // application." — is a false all-clear: the application got nothing. A user
  // who reads that closes the tab and blames the client for hanging.
  assert.ok(
    !/approved[^']*close this tab and return to the application/i.test(consentHtml),
    'the false all-clear on the approve-with-no-redirect path is back',
  );
  assert.ok(
    /could not hand the authorization back/i.test(consentHtml),
    'the approve-with-no-redirect path must say the connection will not complete',
  );
});

test('the supabase-js CDN tag is pinned to an exact version', () => {
  const tags = [...consentHtml.matchAll(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@([^/]+)\//g)]
    .map(m => m[1]);
  assert.ok(tags.length > 0, 'no supabase-js script tag found');
  for (const v of tags) {
    // A floating "@2" re-resolves on jsDelivr, so this page's behaviour — including
    // whether the SDK redirects the browser itself — could change with no deploy.
    assert.match(v, /^\d+\.\d+\.\d+$/, `supabase-js must be pinned exactly, got "@${v}"`);
  }
});

test('mcp-auth-status answers the CORS preflight before it checks auth', () => {
  const optionsAt = statusFn.indexOf("httpMethod === 'OPTIONS'");
  const authAt = statusFn.indexOf('requireAuth(event)');
  assert.ok(optionsAt !== -1, 'no OPTIONS branch — the browser preflight will 401 again');
  assert.ok(authAt !== -1, 'requireAuth call not found — did the handler get rewritten?');
  assert.ok(
    optionsAt < authAt,
    'the OPTIONS branch must come BEFORE requireAuth: a preflight carries no Authorization header',
  );
});

test('the preflight response is a success status with the CORS headers browsers require', () => {
  const m = statusFn.match(/const PREFLIGHT = \{[\s\S]*?\};/);
  assert.ok(m, 'PREFLIGHT response not found');
  const status = Number(m[0].match(/statusCode:\s*(\d+)/)?.[1]);
  assert.ok(status >= 200 && status < 300, `preflight must be 2xx, got ${status} — CORS headers on a 401 do not help`);
  assert.match(statusFn, /'Access-Control-Allow-Methods':\s*'[^']*OPTIONS/, 'preflight must advertise OPTIONS');
  assert.match(statusFn, /'Access-Control-Allow-Headers':\s*'[^']*Authorization/i, 'preflight must allow the Authorization header');
});
