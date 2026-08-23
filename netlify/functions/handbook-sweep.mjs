// handbook-sweep.mjs — freshness audit for the APBG Master Handbook.
//
// GET (superadmin) → reads docs/handbook/manifest.json from this site's own
// static deploy, then asks the GitHub API for the most recent commit touching
// each chapter's registered source files. A source with a commit AFTER the
// chapter's last_reviewed date flags the chapter stale. Live/remote chapters
// (architecture mirror, change log) are skipped — they can't drift.
//
// The sweep FINDS drift; it never edits content. The Master Control panel
// renders the report, generates a copy-paste update prompt per stale chapter,
// and offers the Auto-update button (handbook-autoupdate-background), which
// drafts a review PR — never a silent merge.
//
// Env: GITHUB_TOKEN (fine-grained PAT, read-only Contents on the manifest's
// repos) — required for private repos / sane rate limits.

import { requireAuth } from './lib/auth.mjs';
import { GH_TOKEN, jsonRes, loadManifest, computeSweep } from './lib/handbook.mjs';

export async function handler(event) {
  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'GET') return jsonRes(405, { error: 'GET only' });

  let manifest;
  try {
    manifest = await loadManifest();
  } catch (e) {
    return jsonRes(502, { error: `Could not load handbook manifest: ${e.message}` });
  }

  const chapters = await computeSweep(manifest);

  const summary = {
    total: chapters.length,
    fresh: chapters.filter((c) => c.status === 'fresh').length,
    stale: chapters.filter((c) => c.status === 'stale').length,
    unknown: chapters.filter((c) => c.status === 'unknown').length,
  };

  return jsonRes(200, {
    ok: true,
    checked_at: new Date().toISOString(),
    github_token_present: !!GH_TOKEN,
    manifest_version: manifest.version,
    summary,
    chapters,
  });
}
