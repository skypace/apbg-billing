/**
 * Refractor per-user menu visibility.
 *
 * Two things rot silently here and each has burned this system before:
 *
 *  1. THE LIST DRIFTS. The gateway's picker (apbg-gateway public/admin.html)
 *     has to offer exactly the sections Refractor actually has. Add a screen
 *     to Refractor and forget the gateway and it can never be switched off;
 *     rename an id and every stored grant silently points at nothing.
 *
 *  2. THE APP STOPS READING IT. The Melt version of this feature was deleted
 *     on 2026-08-29 because the gateway wrote `melt_overrides` and
 *     melt-dashboard never read it — two accounts sat configured for months
 *     while the portal ignored them. A setting nobody reads is worse than no
 *     setting, so the read path is asserted here, not assumed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const menusSrc = readFileSync(resolve(ROOT, 'app/src/lib/appMenus.ts'), 'utf8');
const layoutSrc = readFileSync(resolve(ROOT, 'app/src/components/Layout.tsx'), 'utf8');
const appSrc = readFileSync(resolve(ROOT, 'app/src/App.tsx'), 'utf8');
const routerSrc = readFileSync(resolve(ROOT, 'app/src/lib/router.ts'), 'utf8');
const adminSrc = (() => {
  // The gateway lives in a sibling repo; when it is not checked out beside us
  // the cross-repo assertions are skipped rather than failed — a missing repo
  // is not a broken contract.
  try { return readFileSync(resolve(ROOT, '../apbg-gateway/public/admin.html'), 'utf8'); }
  catch { return null; }
})();

/** Menu ids declared in appMenus.ts, in order. */
function declaredMenus() {
  const block = menusSrc.slice(
    menusSrc.indexOf('export const REFRACTOR_MENUS'),
    menusSrc.indexOf('export const REFRACTOR_MENU_IDS'),
  );
  return [...block.matchAll(/\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'/g)]
    .map((m) => ({ id: m[1], label: m[2] }));
}

test('the menu list is the 13 sections Refractor actually ships', () => {
  const ids = declaredMenus().map((m) => m.id);
  assert.deepEqual(ids, [
    'overview', 'margin', 'customers', 'reports', 'plans', 'compare',
    'stock', 'inventory', 'production', 'distributors', 'pricing',
    'proposal-builder', 'settings',
  ]);
});

test('every menu id is a real route in the View union', () => {
  for (const { id } of declaredMenus()) {
    assert.ok(
      new RegExp(`\\|\\s*'${id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}'`).test(routerSrc),
      `menu id "${id}" is not a View — the grant would hide a screen that does not exist`,
    );
  }
});

test('every menu has an icon, and Layout builds its nav from the shared list', () => {
  assert.ok(
    /const NAV: NavItem\[\] = REFRACTOR_MENUS\.map/.test(layoutSrc),
    'Layout must build NAV from REFRACTOR_MENUS — a second hardcoded list is the drift',
  );
  for (const { id } of declaredMenus()) {
    const key = /^[a-z]+$/.test(id) ? id : `'${id}'`;
    assert.ok(
      new RegExp(`^\\s*${key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}:\\s`, 'm').test(layoutSrc),
      `no icon mapped for "${id}"`,
    );
  }
});

test('⚠ the two inventory ids stay backwards, because renaming orphans grants', () => {
  const byId = Object.fromEntries(declaredMenus().map((m) => [m.id, m.label]));
  assert.equal(byId.stock, 'Inventory');
  assert.equal(byId.inventory, 'Inventory Planning');
});

test('Layout filters the sidebar and App guards the route', () => {
  assert.ok(
    /NAV\.filter\(\(n\) => !hiddenMenus\?\.has\(n\.id\)\)/.test(layoutSrc),
    'the sidebar must drop hidden entries',
  );
  // Hiding a link while the hash still renders the page is a control that
  // only works on people who do not type.
  assert.ok(/canOpen\(route\.view, meta\)/.test(appSrc), 'App must guard the route');
  assert.ok(/firstAllowedView\(meta\)/.test(appSrc), 'App must redirect somewhere allowed');
});

test('the grant is read LIVE, not off the session token', () => {
  // user_metadata is baked into a JWT at issue time and sessions here live
  // for months, so reading session.user.user_metadata alone means a grant
  // changed today does not land until the token happens to refresh.
  assert.ok(/sbAuth\.auth\.getUser\(\)/.test(appSrc), 'App must call getUser() for live metadata');
});

test('superadmin is never scoped', () => {
  assert.ok(
    /if \(isSuperadmin\(meta\)\) return new Set\(\);/.test(menusSrc),
    'hiddenMenuIds must short-circuit for superadmin',
  );
});

test('we store what is HIDDEN, so a new section is visible by default', () => {
  // With an allow-list, every screen we ship next would be missing for anyone
  // holding a grant until an admin re-ticked it — which reads as the new
  // feature being broken.
  assert.ok(/refractor\?\.hidden/.test(menusSrc));
  assert.ok(
    /if \(!Array\.isArray\(raw\)\) return new Set\(\);/.test(menusSrc),
    'a missing or malformed grant must mean "show everything", never "hide everything"',
  );
});

test('unknown ids in a stored grant are ignored, not trusted', () => {
  assert.ok(/known\.has\(v\)/.test(menusSrc));
});

test('the gateway picker offers exactly these sections', { skip: !adminSrc }, () => {
  const block = adminSrc.slice(adminSrc.indexOf('REFRACTOR_MENUS'));
  for (const { id, label } of declaredMenus()) {
    assert.ok(
      block.includes(`'${id}'`) || block.includes(`"${id}"`),
      `gateway picker is missing "${id}" — it could never be switched off`,
    );
    assert.ok(block.includes(label), `gateway picker is missing the label "${label}"`);
  }
});

// ── Behaviour, not just source shape ────────────────────────────────────────
// The assertions above prove the wiring is present; these prove it decides
// correctly. Bundled from the TS so the test exercises the real module.
const { hiddenMenuIds, visibleMenus, canOpen, firstAllowedView, isSuperadmin } =
  await import('../.test-build/appMenus.mjs');

test('no grant means everything is visible', () => {
  for (const meta of [null, undefined, {}, { role: 'ops-super' }, { app_menus: {} }]) {
    assert.equal(visibleMenus(meta).length, 13, `unexpected scoping for ${JSON.stringify(meta)}`);
    assert.equal(hiddenMenuIds(meta).size, 0);
  }
});

test('a grant hides exactly what it names', () => {
  const meta = { role: 'ops-super', app_menus: { refractor: { hidden: ['pricing', 'settings'] } } };
  const ids = visibleMenus(meta).map((m) => m.id);
  assert.equal(ids.length, 11);
  assert.ok(!ids.includes('pricing') && !ids.includes('settings'));
  assert.ok(ids.includes('margin'));
  assert.equal(canOpen('pricing', meta), false);
  assert.equal(canOpen('margin', meta), true);
});

test('a superadmin is never scoped, even carrying a grant', () => {
  const meta = { role: 'superadmin', app_menus: { refractor: { hidden: ['pricing', 'settings'] } } };
  assert.ok(isSuperadmin(meta));
  assert.equal(visibleMenus(meta).length, 13);
  assert.equal(canOpen('pricing', meta), true);
});

test('customer-detail rides the Customers permission', () => {
  // It is reached by clicking a customer, so it must not be separately
  // reachable when Customers is switched off.
  const off = { app_menus: { refractor: { hidden: ['customers'] } } };
  assert.equal(canOpen('customer-detail', off), false);
  assert.equal(canOpen('customer-detail', { app_menus: { refractor: { hidden: ['pricing'] } } }), true);
});

test('a view that is not a menu is never blocked', () => {
  // 'operations' and 'fleet' are in the View union but not in the sidebar;
  // gating on an unlisted id would strand anyone deep-linked to one.
  const meta = { app_menus: { refractor: { hidden: ['pricing'] } } };
  assert.equal(canOpen('operations', meta), true);
  assert.equal(canOpen('fleet', meta), true);
});

test('a malformed grant fails OPEN, never closed', () => {
  // Garbage in metadata must not lock a person out of the whole app.
  for (const bad of [
    { app_menus: { refractor: { hidden: 'pricing' } } },
    { app_menus: { refractor: null } },
    { app_menus: 'nope' },
    { app_menus: { refractor: { hidden: [1, 2, 3] } } },
  ]) {
    assert.equal(visibleMenus(bad).length, 13, `failed closed on ${JSON.stringify(bad)}`);
  }
});

test('unknown ids are ignored rather than trusted', () => {
  const meta = { app_menus: { refractor: { hidden: ['pricing', 'not-a-real-menu'] } } };
  assert.deepEqual([...hiddenMenuIds(meta)], ['pricing']);
});

test('firstAllowedView lands somewhere real, or says there is nowhere', () => {
  assert.equal(firstAllowedView({}), 'overview');
  assert.equal(
    firstAllowedView({ app_menus: { refractor: { hidden: ['overview', 'margin'] } } }),
    'customers',
  );
  const everything = ['overview','margin','customers','reports','plans','compare','stock',
    'inventory','production','distributors','pricing','proposal-builder','settings'];
  assert.equal(firstAllowedView({ app_menus: { refractor: { hidden: everything } } }), null);
});
