// handbook-sweep.mjs — freshness audit for the APBG Master Handbook.
//
// GET (superadmin) → reads docs/handbook/manifest.json from this site's own
// static deploy, then asks the GitHub API for the most recent commit touching
// each chapter's registered source files. A source with a commit AFTER the
// chapter's last_reviewed date flags the chapter stale.
//
// The sweep FINDS drift; it never edits content. The Master Control panel
// renders the report and generates a copy-paste update prompt for a Claude
// session per stale chapter.
//
// Env:
//   GITHUB_TOKEN (optional but required for private repos / sane rate limits)
//     — a fine-grained PAT with read-only Contents access to the skypace +
//       activespacescience repos listed in the manifest.
//   URL — provided by Netlify (site origin), used to fetch the manifest.

import { requireAuth } from './lib/auth.mjs';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

function json(status, body) {
  return { statusCode: status, headers: HEADERS, body: JSON.stringify(body) };
}

async function latestCommit(repo, path) {
  const url = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'apbg-handbook-sweep',
  };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) {
    // Private repo without a token also 404s — say so instead of "missing".
    return { error: GH_TOKEN ? 'not found' : 'not found (private repo? set GITHUB_TOKEN)' };
  }
  if (res.status === 403) {
    return { error: 'GitHub rate-limited or forbidden — set/check GITHUB_TOKEN' };
  }
  if (!res.ok) return { error: `GitHub HTTP ${res.status}` };
  const commits = await res.json();
  if (!Array.isArray(commits) || commits.length === 0) {
    return { error: 'no commits found for path' };
  }
  const c = commits[0];
  return {
    sha: c.sha?.slice(0, 7),
    date: c.commit?.committer?.date || c.commit?.author?.date || null,
    message: (c.commit?.message || '').split('\n')[0].slice(0, 120),
    url: c.html_url,
  };
}

export async function handler(event) {
  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });

  const origin = process.env.URL || 'https://apbg-billing.netlify.app';
  let manifest;
  try {
    const res = await fetch(`${origin}/docs/handbook/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`manifest fetch HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    return json(502, { error: `Could not load handbook manifest: ${e.message}` });
  }

  // Dedupe identical repo+path pairs across chapters (one API call each).
  const cache = new Map();
  async function commitFor(src) {
    const key = `${src.repo}::${src.path}`;
    if (!cache.has(key)) cache.set(key, latestCommit(src.repo, src.path));
    return cache.get(key);
  }

  const chapters = [];
  for (const ch of manifest.chapters || []) {
    // Stale = a source commit strictly after the last_reviewed calendar day.
    const reviewedCutoff = new Date(`${ch.last_reviewed}T23:59:59Z`).getTime();
    const sources = [];
    let anyStale = false;
    let anyError = false;

    for (const src of ch.sources || []) {
      const info = await commitFor(src);
      if (info.error) {
        anyError = true;
        sources.push({ ...src, error: info.error });
        continue;
      }
      const stale = info.date ? new Date(info.date).getTime() > reviewedCutoff : false;
      if (stale) anyStale = true;
      sources.push({
        ...src,
        last_commit: info.date,
        sha: info.sha,
        message: info.message,
        commit_url: info.url,
        stale,
      });
    }

    chapters.push({
      slug: ch.slug,
      title: ch.title,
      owner: ch.owner,
      last_reviewed: ch.last_reviewed,
      status: anyStale ? 'stale' : anyError ? 'unknown' : 'fresh',
      sources,
    });
  }

  const summary = {
    total: chapters.length,
    fresh: chapters.filter((c) => c.status === 'fresh').length,
    stale: chapters.filter((c) => c.status === 'stale').length,
    unknown: chapters.filter((c) => c.status === 'unknown').length,
  };

  return json(200, {
    ok: true,
    checked_at: new Date().toISOString(),
    github_token_present: !!GH_TOKEN,
    manifest_version: manifest.version,
    summary,
    chapters,
  });
}
