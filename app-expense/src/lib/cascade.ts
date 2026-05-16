// Entity → department → COGS cascade rules for the expense form.
// (PurchaseRequestForm still hardcodes entity = 'brix' and uses a tag-gated
// department picker; wiring it through this helper is deferred to a follow-up.)
//
// The current ops.expense_settings JSON stores `departments` + `cogs_accounts`
// as flat lists with no association columns, so this file holds the
// mapping client-side. The cascade UI uses these to:
//   - hide departments that don't apply to the chosen entity
//   - sort cogs_accounts so the ones likely-relevant to the chosen
//     department surface first (rather than removing the others — the
//     operator can still pick anything, the list is just smarter)
//
// Source of truth: CLAUDE.md "Department-to-COGS mapping" + entity split.
// When the team migrates these into `ops.expense_settings` rows we can drop
// this file in favor of admin-editable settings (deferred).

import type { Entity } from '@/types/expense';

/** Which departments apply to which entity. Departments not listed here
 *  are visible for every entity (safe default). */
export const DEPARTMENT_ENTITIES: Record<string, ReadonlyArray<Entity>> = {
  delivery: ['brix'],           // B2B - Direct Labor (Brix-only)
  service:  ['brix', 'freeflow'], // Service - shared between both
  reman:    ['freeflow'],       // Reman is FreeFlow's business
  ops:      ['brix', 'freeflow', 'shared'], // Shared/admin
  freeflow: ['freeflow'],
  melt:     ['brix'],           // Melt is the Brix subsidiary
};

/** Preferred COGS accounts per department, keyed by label. We use the label
 *  (not the QBO id) as the join key because the seeded cogs_accounts have
 *  null ids for everything except Service COGS (101) and Equipment Sales
 *  COGS (42) — see migrations/20260512p_expense_cleanup.sql. Once the
 *  remaining buckets get real QBO accounts the labels stay stable, and
 *  this list keeps working without an update. Labels are matched
 *  case-sensitively against the seeded values verbatim. */
export const DEPARTMENT_COGS_PREFERENCES: Record<string, ReadonlyArray<string>> = {
  delivery: ['Fuel', 'Travel'],
  service:  ['Service COGS', 'Travel', 'Fuel', 'Office Supplies'],
  reman:    ['Equipment Sales COGS', 'Office Supplies'],
  ops:      ['Office Supplies', 'Working Meals', 'Repair & Maintenance — Building'],
  freeflow: ['Equipment Sales COGS', 'New Fountain Installs COGS', 'Ice Machine Rental COGS'],
  melt:     ['Equipment Sales COGS', 'New Fountain Installs COGS', 'Ice Machine Rental COGS'],
};

export function filterDepartmentsByEntity<T extends string>(
  departments: ReadonlyArray<T>,
  entity: Entity | '',
): T[] {
  if (!entity) return [...departments];
  return departments.filter((d) => {
    const allowed = DEPARTMENT_ENTITIES[d];
    // Unmapped departments fall through to "visible for everyone" so adding
    // a new department doesn't require a code change to appear at all.
    return !allowed || allowed.includes(entity);
  });
}

/** Returns the list of cogs_accounts sorted by preference for the given
 *  department: labels listed in `DEPARTMENT_COGS_PREFERENCES` first (in
 *  preference order), then the rest in their original order. Doesn't
 *  drop anything. Match is by label, not id — see DEPARTMENT_COGS_PREFERENCES. */
export function sortCogsByDepartment<T extends { label: string }>(
  cogsAccounts: ReadonlyArray<T>,
  department: string,
): T[] {
  const prefs = DEPARTMENT_COGS_PREFERENCES[department];
  if (!prefs || prefs.length === 0) return [...cogsAccounts];
  const preferred = prefs
    .map((label) => cogsAccounts.find((a) => a.label === label))
    .filter((a): a is T => a != null);
  const preferredLabels = new Set(preferred.map((a) => a.label));
  const rest = cogsAccounts.filter((a) => !preferredLabels.has(a.label));
  return [...preferred, ...rest];
}
