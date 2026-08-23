// handbook-changelog.mjs — the handbook's automatic Change Log tab.
//
// GET (superadmin/admin) ?days=30 → pulls recent commits from every APBG
// repo via the GitHub API and composes them into one dated markdown feed,
// newest day first. Nothing is logged by hand — git is the logger; anything
// that shipped anywhere shows up here.
//
// Requires GITHUB_TOKEN with read access to the repos below; repos the token
// can't see are reported inline instead of silently omitted.

import { requireAuth } from './lib/auth.mjs';
import { jsonRes, recentCommits } from './lib/handbook.mjs';

const REPOS = [
  'skypace/apbg-billing',
  'skypace/apbg-gateway',
  'activespacescience/brix-order',
  'skypace/apbg-resq-sync',
  'skypace/melt-dashboard',
  'skypace/APBG-OPS',
  'skypace/APBG-Leasing-Rental',
  'skypace/pacerfinance',
  'skypace/Pacer-outlook',
  'skypace/DAM-Fountain',
  'activespacescience/Fresh-Pet',
  'activespacescience/Skilliosis_Mytosis_Architecture',
];

const REPO_LABEL = (r) => r.split('/')[1];

export async function handler(event) {
  const auth = await requireAuth(event, ['superadmin', 'admin']);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'GET') return jsonRes(405, { error: 'GET only' });

  const days = Math.min(90, Math.max(1, parseInt(event.queryStringParameters?.days || '30', 10) || 30));
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();

  const results = await Promise.all(
    REPOS.map(async (repo) => ({ repo, ...(await recentCommits(repo, since, 50)) }))
  );

  // Flatten to one feed grouped by calendar day (UTC), newest first.
  const byDay = new Map();
  const errors = [];
  for (const r of results) {
    if (r.error) { errors.push({ repo: r.repo, error: r.error }); continue; }
    for (const c of r.commits) {
      if (!c.date) continue;
      const day = c.date.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({ ...c, repo: r.repo });
    }
  }
  const daysSorted = [...byDay.keys()].sort().reverse();

  let md = `# Change Log — What Shipped Across Every APBG Repo\n\n`;
  md += `> Automatic feed · last ${days} days · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · git is the logger — nothing here is entered by hand\n\n`;
  md += `Every commit that landed on the default branch of each APBG repository. `;
  md += `For what a change *means* operationally, follow the commit link — PR descriptions carry the detail. `;
  md += `Handbook chapters affected by these changes surface in the [Master Control sweep](#/09-master-control).\n`;

  if (errors.length) {
    md += `\n> ⚠ Not visible with the current GITHUB_TOKEN: ${errors
      .map((e) => `\`${e.repo}\` (${e.error})`)
      .join(', ')}\n`;
  }

  let total = 0;
  for (const day of daysSorted) {
    const items = byDay.get(day).sort((a, b) => (a.date < b.date ? 1 : -1));
    md += `\n## ${day}\n\n`;
    for (const c of items) {
      total += 1;
      const who = c.author ? ` — ${c.author}` : '';
      md += `- **\`${REPO_LABEL(c.repo)}\`** [${c.message.replace(/\[/g, '(').replace(/\]/g, ')')}](${c.url})${who}\n`;
    }
  }
  if (total === 0) md += `\nNo commits in the last ${days} days.\n`;

  return jsonRes(200, {
    ok: true,
    markdown: md,
    days,
    total_commits: total,
    repos_checked: REPOS.length,
    repos_unreadable: errors.length,
    generated_at: new Date().toISOString(),
  });
}
