// handbook-architecture.mjs — live mirror of the master architecture handbook.
//
// GET (superadmin/admin) → fetches ARCHITECTURE.md from
// activespacescience/Skilliosis_Mytosis_Architecture at request time and
// returns it as markdown for the handbook viewer's "Live Architecture Mirror"
// chapter. A live fetch can never drift from the source of truth — unlike a
// copied snapshot. Mermaid diagrams in the doc render client-side.
//
// Requires GITHUB_TOKEN (read access to the architecture repo).
// Small in-memory cache keeps repeat opens cheap within a warm lambda.

import { requireAuth } from './lib/auth.mjs';
import { jsonRes, fetchRawFile, latestCommit } from './lib/handbook.mjs';

const REPO = 'activespacescience/Skilliosis_Mytosis_Architecture';
const PATH = 'ARCHITECTURE.md';
const CACHE_MS = 5 * 60 * 1000;

let cached = null; // { at, body }

export async function handler(event) {
  const auth = await requireAuth(event, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'GET') return jsonRes(405, { error: 'GET only' });

  if (cached && Date.now() - cached.at < CACHE_MS) {
    return jsonRes(200, { ...cached.body, cached: true });
  }

  try {
    const [markdown, commit] = await Promise.all([
      fetchRawFile(REPO, PATH),
      latestCommit(REPO, PATH),
    ]);
    const body = {
      ok: true,
      markdown,
      source: `${REPO}/${PATH}`,
      source_url: `https://github.com/${REPO}/blob/main/${PATH}`,
      last_commit: commit.error ? null : commit,
      fetched_at: new Date().toISOString(),
    };
    cached = { at: Date.now(), body };
    return jsonRes(200, body);
  } catch (e) {
    return jsonRes(502, {
      error: `Could not fetch the architecture handbook: ${e.message}. ` +
        'Check GITHUB_TOKEN has read access to the Skilliosis_Mytosis_Architecture repo.',
    });
  }
}
