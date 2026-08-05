// lint-inline-scripts.mjs — build gate: every inline <script> in the
// hand-written static HTML pages must PARSE.
//
// Why: 2026-08-05 — a merge between two parallel sessions' control.html
// changes dropped one closing brace. The page's whole inline script became
// unparseable, so the auth gate never ran and Master Control login hung at
// "Checking access…" for everyone (PR #344). A syntax error in a static
// page is invisible to the build unless something parses it — this script
// is that something, in the same spirit as lint-manifest.mjs.
//
// Scope: committed static HTML under public/ (control.html, dashboard.html,
// setup.html, the docs/handbook viewers, …). The Vite SPA output dirs are
// skipped — those are build artifacts with their own toolchain.
//
// Parsing model: classic-script blocks are compiled with vm.compileFunction
// (catches unbalanced braces/parens, broken template literals, truncated
// blocks — everything that killed #344). Blocks with src=, JSON/template
// types, or type="module" static imports are skipped. This is a parse
// check, not a linter: it will not catch logic bugs, only "this page's JS
// cannot run at all".

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import vm from 'node:vm';

const ROOT = 'public';
const SKIP_DIRS = new Set(['sales-next', 'expense']); // Vite build output

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...htmlFiles(p));
    } else if (name.endsWith('.html')) {
      out.push(p);
    }
  }
  return out;
}

const errors = [];
let filesChecked = 0;
let blocksChecked = 0;

for (const file of htmlFiles(ROOT)) {
  const html = readFileSync(file, 'utf8');
  const rel = relative('.', file);
  let sawBlock = false;

  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;           // external script
    if (!body.trim()) continue;                        // empty
    const typeMatch = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : '';
    if (type && type !== 'text/javascript' && type !== 'module') continue; // JSON/templates
    if (type === 'module' && /^\s*import\s/m.test(body)) continue; // static imports don't fit compileFunction

    sawBlock = true;
    blocksChecked += 1;
    const lineOffset = html.slice(0, m.index).split('\n').length - 1;
    try {
      vm.compileFunction(body, [], { filename: rel, lineOffset });
    } catch (e) {
      errors.push(`${rel} (script starting line ${lineOffset + 1}): ${e.message}`);
    }
  }
  if (sawBlock) filesChecked += 1;
}

if (errors.length) {
  console.error(`✗ Inline-script parse gate FAILED — ${errors.length} broken script block(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('A page whose inline JS cannot parse ships completely dead (no auth gate, no panels). Fix before deploying.');
  process.exit(1);
}
console.log(`Inline scripts clean: ${blocksChecked} block(s) across ${filesChecked} static page(s) parse OK.`);
