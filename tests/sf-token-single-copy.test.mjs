// The Service Fusion refresh token has ONE home, and a failed refresh gets ONE
// attempt. Both halves are load-bearing and both were violated until 2026-09-07.
//
// SF rotates the refresh token on every use, so each refresh spends the previous
// one. A second copy is therefore not a backup — it is a spent credential, and
// presenting one reads as a replayed credential. `sf-helpers.mjs` kept four
// copies (database, memory, Netlify Blobs, a Netlify env var) and looped through
// the older ones whenever a refresh failed, under the comment "let Netlify heal
// it from Blob/env". It could never heal anything: the database copy is the
// freshest by construction. The deployed edge function carried the same loop.
//
// This is a SOURCE-TEXT test on purpose. The rule spans a Node .mjs and a Deno
// .ts that this repo's runner cannot execute, and what has to be prevented is a
// SHAPE — "on failure, try another copy" — not a return value. A behavioural
// test of sf-helpers would cover one of the two readers, and the uncovered one
// is the one that runs on the cron three times a day.
//
// If you are here because this test failed: adding a fallback token is the bug.
// Fail the refresh, let noteDbRefreshError stamp the row, and re-auth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const NETLIFY = 'netlify/functions/sf-helpers.mjs';
const EDGE = 'supabase/functions/sf-receipt-sync/index.ts';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// Strip comments so the prose above (and the warnings in the source, which
// necessarily NAME the things they forbid) can't satisfy or trip an assertion.
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

for (const file of [NETLIFY, EDGE]) {
  test(`${file}: the token endpoint is called exactly once per refresh`, () => {
    const body = code(read(file));
    const calls = body.match(/fetch\s*\(\s*SF_TOKEN_URL/g) || [];
    assert.equal(
      calls.length, 1,
      `expected 1 call to SF_TOKEN_URL, found ${calls.length}. A second call site is ` +
      `almost certainly a retry with an older copy of the refresh token, which cannot succeed.`,
    );
  });

  test(`${file}: no loop over a list of candidate refresh tokens`, () => {
    const body = code(read(file));
    for (const pattern of [/\bcandidates\b/, /\bfallbacks\b/, /\bfallbackToken\b/, /\bblobRefreshToken\b/]) {
      assert.ok(
        !pattern.test(body),
        `found ${pattern} — a set of refresh tokens to try in turn is the replay bug.`,
      );
    }
  });

  test(`${file}: SF_REFRESH_TOKEN is read at most once, as a bootstrap`, () => {
    const body = code(read(file));
    // Count actual READS, not mentions: both files name the variable in the
    // warning they log when the bootstrap fires, and a string literal is not a
    // read. Loosening the bound to 2 instead would let a real second read in.
    const reads = body.match(/(?:process\.env\.SF_REFRESH_TOKEN|Deno\.env\.get\(\s*["']SF_REFRESH_TOKEN["']\s*\))/g) || [];
    assert.ok(
      reads.length <= 1,
      `SF_REFRESH_TOKEN read ${reads.length} times. It is a bootstrap for a database ` +
      `that holds no token at all — never a fallback for one that was rejected.`,
    );
  });
}

test(`${NETLIFY}: the refresh token is not copied to memory, Blobs or an env var`, () => {
  const body = code(read(NETLIFY));

  assert.ok(
    !/memCache\.refreshToken/.test(body),
    'memCache must not hold the refresh token — it is single-use and the DB row is its home.',
  );
  assert.ok(
    !/store\.set\(\s*['"]refresh-token['"]/.test(body),
    'must not write the refresh token to Netlify Blobs.',
  );
  assert.ok(
    !/updateSFEnvVar/.test(body),
    'updateSFEnvVar rewrote SF_REFRESH_TOKEN on every refresh with a non-atomic ' +
    'DELETE-then-POST, to maintain a second copy of a single-use credential. Do not revive it.',
  );

  // The initialiser is the thing that made the fourth copy easy to add back.
  const init = body.match(/let\s+memCache\s*=\s*\{[^}]*\}/);
  assert.ok(init, 'memCache initialiser not found — has this file been restructured?');
  assert.ok(
    !/refresh/i.test(init[0]),
    `memCache initialiser must not declare a refresh-token slot: ${init[0]}`,
  );
});

test(`${NETLIFY}: a rejected refresh is recorded and then thrown`, () => {
  const body = code(read(NETLIFY));
  // noteDbRefreshError stamps last_refresh_error_at, which is what the sf_token
  // health check compares against updated_at (migration 20260907a). Without the
  // stamp a dead token is invisible; without the throw it is silently swallowed.
  assert.ok(/noteDbRefreshError\s*\(/.test(body), 'a failed refresh must stamp the row.');
  assert.ok(/throw new Error\(message\)/.test(body), 'a failed refresh must throw, not fall through.');
});
