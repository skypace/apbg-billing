import type { View } from './router';

/**
 * Per-user Refractor menu visibility, administered on the gateway.
 *
 * WHERE THE DATA LIVES: the gateway's Staff & Access console
 * (alamedapointbg.com/admin.html → Access → REFRACTOR) writes
 *   user_metadata.app_menus = { refractor: { hidden: ['pricing', ...] } }
 * and this module is what READS it. Both halves matter — the Melt version of
 * this feature was deleted on 2026-08-29 because the gateway wrote
 * `melt_overrides` and melt-dashboard never read it, so two accounts sat
 * configured for months while the portal quietly ignored them. A setting
 * nobody reads is worse than no setting.
 *
 * ⚠ WE STORE WHAT IS HIDDEN, NOT WHAT IS ALLOWED — and that is deliberate.
 * With an allow-list, every new screen we ship would be missing for anyone
 * who has an explicit grant until an admin went and re-ticked them, which
 * reads as the new feature being broken. Storing the hidden set means a new
 * menu is visible by default and only a deliberate exclusion persists. The
 * gateway's UI still shows tick-to-enable; it just saves the inverse.
 *
 * ⚠ THIS IS A VIEW CONTROL, NOT A SECURITY BOUNDARY. Refractor reads ops.*
 * with the signed-in user's own JWT and RLS decides what they may see;
 * hiding "Pricing" removes the screen, not their access to the data behind
 * it. Anything that must be genuinely denied belongs in RLS or in the
 * gateway's `modules` access buckets, not here.
 */

/** A Refractor sidebar entry. Icons are attached in Layout. */
export interface RefractorMenu {
  id: Exclude<View, 'customer-detail' | 'operations' | 'fleet'>;
  label: string;
}

/**
 * THE menu list — the single source of truth for both the sidebar and the
 * gateway's picker. `npm test` (tests/refractor-menus.test.mjs in the repo
 * root) pins Layout's NAV to this, so the two cannot drift.
 *
 * ⚠ Two ids read backwards and it is not a typo: `stock` is "Inventory"
 * (what is on hand) and `inventory` is "Inventory Planning". Renaming either
 * would orphan every stored grant AND every bookmark, so the ids are frozen
 * and only the labels are corrected.
 */
export const REFRACTOR_MENUS: RefractorMenu[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'margin', label: 'Margin' },
  { id: 'customers', label: 'Customers' },
  { id: 'reports', label: 'Reports' },
  { id: 'plans', label: 'Plans' },
  { id: 'compare', label: 'Compare' },
  { id: 'stock', label: 'Inventory' },
  { id: 'inventory', label: 'Inventory Planning' },
  { id: 'production', label: 'Production' },
  { id: 'distributors', label: 'Sub-Distributors' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'proposal-builder', label: 'Proposal Builder' },
  { id: 'settings', label: 'Settings' },
];

export const REFRACTOR_MENU_IDS: string[] = REFRACTOR_MENUS.map((m) => m.id);

/** The shape the gateway writes. Anything else is treated as "no grant". */
interface AppMenusMeta {
  refractor?: { hidden?: unknown };
}

type Meta = Record<string, unknown> | null | undefined;

export function isSuperadmin(meta: Meta): boolean {
  const role = meta && typeof meta.role === 'string' ? meta.role : '';
  return role === 'superadmin';
}

/**
 * The hidden set for this user. A superadmin is never scoped — Sky's rule,
 * and it is also what stops an admin locking themselves out of Settings.
 * Unknown ids are ignored rather than trusted, so a stale grant naming a
 * menu we removed cannot hide something it was never about.
 */
export function hiddenMenuIds(meta: Meta): Set<string> {
  if (isSuperadmin(meta)) return new Set();
  const appMenus = meta?.app_menus as AppMenusMeta | undefined;
  const raw = appMenus?.refractor?.hidden;
  if (!Array.isArray(raw)) return new Set();
  const known = new Set(REFRACTOR_MENU_IDS);
  return new Set(raw.filter((v): v is string => typeof v === 'string' && known.has(v)));
}

/** The menus this user may see, in sidebar order. */
export function visibleMenus(meta: Meta): RefractorMenu[] {
  const hidden = hiddenMenuIds(meta);
  return REFRACTOR_MENUS.filter((m) => !hidden.has(m.id));
}

/**
 * Is this view reachable? Used to guard the ROUTE, not just the sidebar —
 * hiding a link while `#pricing` still renders the page is a control that
 * only works on people who do not type.
 */
export function canOpen(view: View, meta: Meta): boolean {
  // customer-detail is reached from Customers and shares its permission.
  const effective: string = view === 'customer-detail' ? 'customers' : view;
  if (!REFRACTOR_MENU_IDS.includes(effective)) return true; // not a gated view
  return !hiddenMenuIds(meta).has(effective);
}

/** Where to send someone whose current view is denied. Null = nothing left. */
export function firstAllowedView(meta: Meta): View | null {
  const vis = visibleMenus(meta);
  return vis.length > 0 ? (vis[0]!.id as View) : null;
}
