// handbook-autoupdate-background.mjs — one-button handbook updates.
//
// POST (superadmin) { slugs?: string[] } → re-runs the sweep, and for each
// stale chapter (optionally filtered to `slugs`, capped per run):
//   1. pulls the current chapter + the changed source files from GitHub,
//   2. asks Claude to rewrite the chapter against the new sources
//      (same structure, grounded, review date bumped),
//   3. commits the updated chapters + manifest date bumps to a new branch
//      and opens a DRAFT PR on skypace/apbg-billing.
//
// The automation stops at the PR on purpose: SOP and policy text never
// changes without a human review (SOP-0). Nothing is ever merged by this
// function.
//
// Netlify background function (15-min budget): responds 202 immediately;
// the PR is the result. Progress/errors go to the function log.
//
// Env:
//   GITHUB_WRITE_TOKEN (or GITHUB_TOKEN with Contents+PR write) — repo writes
//   ANTHROPIC_API_KEY — chapter rewriting
//   HANDBOOK_UPDATE_MODEL (optional, default claude-sonnet-5)

import { requireAuth } from './lib/auth.mjs';
import {
  GH_WRITE_TOKEN,
  ghHeaders,
  fetchRawFile,
  loadManifest,
  computeSweep,
} from './lib/handbook.mjs';

const REPO = 'skypace/apbg-billing';
const MAX_CHAPTERS_PER_RUN = 6;
const MAX_SOURCE_CHARS = 30000;
const MODEL = process.env.HANDBOOK_UPDATE_MODEL || 'claude-sonnet-5';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/${path}`, {
    ...opts,
    headers: { ...ghHeaders(GH_WRITE_TOKEN), ...(opts.headers || {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`GitHub ${path} HTTP ${res.status}: ${body.message || text.slice(0, 200)}`);
  return body;
}

async function rewriteChapter(chapter, chapterMd, changedSources) {
  const today = new Date().toISOString().slice(0, 10);
  const sourcesBlock = changedSources
    .map(
      (s) =>
        `### Source: ${s.repo}/${s.path}\nLatest commit: ${s.sha} ${s.last_commit} — "${s.message}"\n\n<source_content>\n${s.content}\n</source_content>`
    )
    .join('\n\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      system: [
        'You maintain the APBG Master Handbook — internal staff documentation.',
        'You are given one handbook chapter and the CURRENT content of its source documents that changed since the chapter was last reviewed.',
        'Update the chapter so it matches the sources. Rules:',
        '1. Keep the exact structure: the `# Title` line unchanged, the metadata blockquote on the next block (update ONLY its "Last reviewed" date to ' + today + '), the same h2/h3 section style, and the final "## Related" section.',
        '2. Change only what the sources require — do not rewrite prose that is still accurate.',
        '3. Everything must be grounded in the provided sources or the existing chapter. Never invent prices, policies, URLs, or contacts.',
        '4. Never include secrets, API keys, or spoken-code values; reference env-var names instead.',
        '5. Keep intra-handbook links in the `[title](#/slug)` form.',
        '6. Output ONLY the complete updated markdown for the chapter file — no preamble, no code fences around the whole document.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: `## Chapter file: docs/handbook/${chapter.slug}.md (last reviewed ${chapter.last_reviewed})\n\n<chapter>\n${chapterMd}\n</chapter>\n\n## Changed sources\n\n${sourcesBlock}\n\nProduce the full updated chapter markdown now.`,
        },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic HTTP ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const cleaned = text.trim().replace(/^```(?:markdown)?\n/, '').replace(/\n```$/, '');
  if (!cleaned.startsWith('# ')) throw new Error('model output did not look like a chapter (no leading H1) — skipped for safety');
  return cleaned + (cleaned.endsWith('\n') ? '' : '\n');
}

async function putFile(branch, path, content, message) {
  let sha;
  try {
    const existing = await gh(`repos/${REPO}/contents/${path}?ref=${branch}`);
    sha = existing.sha;
  } catch {
    sha = undefined; // new file
  }
  await gh(`repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
}

export async function handler(event) {
  const auth = await requireAuth(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  if (!GH_WRITE_TOKEN) {
    console.error('[handbook-autoupdate] no GITHUB_WRITE_TOKEN/GITHUB_TOKEN — cannot write');
    return { statusCode: 202 };
  }
  if (!ANTHROPIC_API_KEY) {
    console.error('[handbook-autoupdate] ANTHROPIC_API_KEY not set — cannot rewrite chapters');
    return { statusCode: 202 };
  }

  let wanted = null;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (Array.isArray(body.slugs) && body.slugs.length) wanted = new Set(body.slugs);
  } catch { /* ignore bad body */ }

  try {
    console.log('[handbook-autoupdate] starting sweep…');
    const manifest = await loadManifest();
    const sweep = await computeSweep(manifest);
    let stale = sweep.filter((c) => c.status === 'stale');
    if (wanted) stale = stale.filter((c) => wanted.has(c.slug));
    if (!stale.length) {
      console.log('[handbook-autoupdate] nothing stale — no PR opened');
      return { statusCode: 202 };
    }
    const skipped = stale.slice(MAX_CHAPTERS_PER_RUN);
    stale = stale.slice(0, MAX_CHAPTERS_PER_RUN);
    console.log(`[handbook-autoupdate] updating ${stale.length} chapter(s): ${stale.map((c) => c.slug).join(', ')}${skipped.length ? ` (deferred: ${skipped.map((c) => c.slug).join(', ')})` : ''}`);

    // Rewrite each stale chapter against its changed sources.
    const updates = [];
    const failures = [];
    for (const ch of stale) {
      try {
        const chapterMd = await fetchRawFile(REPO, `docs/handbook/${ch.slug}.md`);
        const changed = [];
        for (const s of ch.sources.filter((s) => s.stale)) {
          try {
            const content = (await fetchRawFile(s.repo, s.path)).slice(0, MAX_SOURCE_CHARS);
            changed.push({ ...s, content });
          } catch (e) {
            console.warn(`[handbook-autoupdate] source ${s.repo}/${s.path} unreadable: ${e.message}`);
          }
        }
        if (!changed.length) throw new Error('no changed sources readable');
        const updated = await rewriteChapter(ch, chapterMd, changed);
        if (updated.trim() === chapterMd.trim()) {
          console.log(`[handbook-autoupdate] ${ch.slug}: no content change needed (date bump only)`);
        }
        updates.push({ ch, markdown: updated, changed });
        console.log(`[handbook-autoupdate] ${ch.slug}: rewrite ok (${updated.length} chars)`);
      } catch (e) {
        failures.push({ slug: ch.slug, error: e.message });
        console.error(`[handbook-autoupdate] ${ch.slug} failed: ${e.message}`);
      }
    }
    if (!updates.length) {
      console.error('[handbook-autoupdate] every chapter rewrite failed — no PR opened');
      return { statusCode: 202 };
    }

    // Branch off main.
    const today = new Date().toISOString().slice(0, 10);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const branch = `handbook/auto-update-${stamp}`;
    const mainRef = await gh(`repos/${REPO}/git/ref/heads/main`);
    await gh(`repos/${REPO}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: mainRef.object.sha }),
    });

    // Commit chapters + manifest date bumps.
    for (const u of updates) {
      await putFile(branch, `docs/handbook/${u.ch.slug}.md`, u.markdown,
        `handbook auto-update: ${u.ch.slug} (sources moved since ${u.ch.last_reviewed})`);
    }
    const manifestRaw = await fetchRawFile(REPO, 'docs/handbook/manifest.json', branch);
    const manifestJson = JSON.parse(manifestRaw);
    for (const u of updates) {
      const entry = manifestJson.chapters.find((c) => c.slug === u.ch.slug);
      if (entry) entry.last_reviewed = today;
    }
    manifestJson.updated = today;
    await putFile(branch, 'docs/handbook/manifest.json',
      JSON.stringify(manifestJson, null, 2) + '\n',
      `handbook auto-update: bump last_reviewed (${updates.map((u) => u.ch.slug).join(', ')})`);

    // Draft PR.
    const lines = updates.map((u) => {
      const srcs = u.changed.map((s) => `  - \`${s.repo}/${s.path}\` — [${s.sha} ${s.message}](${s.commit_url || ''})`).join('\n');
      return `- **${u.ch.title}** (\`${u.ch.slug}\`, was reviewed ${u.ch.last_reviewed})\n${srcs}`;
    }).join('\n');
    const failText = failures.length
      ? `\n\n## Skipped (rewrite failed — update by hand or re-run)\n${failures.map((f) => `- \`${f.slug}\`: ${f.error}`).join('\n')}`
      : '';
    const deferText = skipped.length
      ? `\n\n## Deferred (over the per-run cap — run auto-update again)\n${skipped.map((c) => `- \`${c.slug}\``).join('\n')}`
      : '';
    const pr = await gh(`repos/${REPO}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: `Handbook auto-update ${today}: ${updates.map((u) => u.ch.slug).join(', ')}`,
        head: branch,
        base: 'main',
        draft: true,
        body: `Automated handbook refresh from the Master Control **Auto-update** button. Each chapter below was rewritten by Claude (${MODEL}) against its changed source documents, and its \`last_reviewed\` date was bumped in the manifest.\n\n**⚠ Review before merging — per SOP-0, policy/procedure text never merges without human eyes.**\n\n## Chapters updated\n${lines}${failText}${deferText}`,
      }),
    });
    console.log(`[handbook-autoupdate] opened ${pr.html_url}`);
  } catch (e) {
    console.error('[handbook-autoupdate] run failed:', e.message);
  }
  return { statusCode: 202 };
}
