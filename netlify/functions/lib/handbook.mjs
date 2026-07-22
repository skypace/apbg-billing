// Shared helpers for the APBG Master Handbook functions
// (handbook-sweep, handbook-architecture, handbook-changelog,
// handbook-autoupdate-background).

export const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
export const GH_WRITE_TOKEN = process.env.GITHUB_WRITE_TOKEN || GH_TOKEN;

export const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function jsonRes(status, body) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export function ghHeaders(token = GH_TOKEN, accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'User-Agent': 'apbg-handbook' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Latest commit touching a path (or the whole repo when path is '').
export async function latestCommit(repo, path, ref = '') {
  const params = new URLSearchParams({ per_page: '1' });
  if (path) params.set('path', path);
  if (ref) params.set('sha', ref);
  const res = await fetch(`https://api.github.com/repos/${repo}/commits?${params}`, {
    headers: ghHeaders(),
  });
  if (res.status === 404) {
    return { error: GH_TOKEN ? 'not found' : 'not found (private repo? set GITHUB_TOKEN)' };
  }
  if (res.status === 403) return { error: 'GitHub rate-limited or forbidden — set/check GITHUB_TOKEN' };
  if (!res.ok) return { error: `GitHub HTTP ${res.status}` };
  const commits = await res.json();
  if (!Array.isArray(commits) || commits.length === 0) return { error: 'no commits found for path' };
  const c = commits[0];
  return {
    sha: c.sha?.slice(0, 7),
    date: c.commit?.committer?.date || c.commit?.author?.date || null,
    message: (c.commit?.message || '').split('\n')[0].slice(0, 120),
    url: c.html_url,
  };
}

// Recent commits on a repo's default branch.
export async function recentCommits(repo, sinceIso, perPage = 30) {
  const params = new URLSearchParams({ per_page: String(perPage), since: sinceIso });
  const res = await fetch(`https://api.github.com/repos/${repo}/commits?${params}`, {
    headers: ghHeaders(),
  });
  if (!res.ok) {
    return {
      error:
        res.status === 404
          ? GH_TOKEN
            ? 'not found / no access'
            : 'not found (private repo? set GITHUB_TOKEN)'
          : `GitHub HTTP ${res.status}`,
    };
  }
  const commits = await res.json();
  return {
    commits: (Array.isArray(commits) ? commits : []).map((c) => ({
      sha: c.sha?.slice(0, 7),
      date: c.commit?.committer?.date || c.commit?.author?.date || null,
      message: (c.commit?.message || '').split('\n')[0],
      author: c.commit?.author?.name || c.author?.login || '',
      url: c.html_url,
    })),
  };
}

// Raw file contents from a repo (default branch unless ref given).
export async function fetchRawFile(repo, path, ref = '') {
  const url = `https://api.github.com/repos/${repo}/contents/${path}${ref ? `?ref=${ref}` : ''}`;
  const res = await fetch(url, { headers: ghHeaders(GH_TOKEN, 'application/vnd.github.raw+json') });
  if (!res.ok) throw new Error(`GitHub ${repo}/${path} HTTP ${res.status}`);
  return res.text();
}

// The handbook manifest, from this site's own static deploy.
export async function loadManifest() {
  const origin = process.env.URL || 'https://apbg-billing.netlify.app';
  const res = await fetch(`${origin}/docs/handbook/manifest.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`manifest fetch HTTP ${res.status}`);
  return res.json();
}

// Sweep core: per-chapter freshness vs registered sources. Remote (live)
// chapters have no static file to go stale, so they're skipped.
export async function computeSweep(manifest) {
  const cache = new Map();
  const commitFor = (src) => {
    const key = `${src.repo}::${src.path}`;
    if (!cache.has(key)) cache.set(key, latestCommit(src.repo, src.path));
    return cache.get(key);
  };

  const chapters = [];
  for (const ch of manifest.chapters || []) {
    if (ch.remote) continue;
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
  return chapters;
}
