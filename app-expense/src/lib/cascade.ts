// Entity → department → COGS cascade rules for the expense + PR forms.
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

/** Preferred COGS account IDs per department. Best-effort defaults that
 *  surface the most-likely accounts first; the operator can still pick
 *  anything from the rest of the list. Department keys not listed here
 *  get all accounts shown without re-ordering. */
export const DEPARTMENT_COGS_PREFERENCES: Record<string, ReadonlyArray<string>> = {
  delivery: ['54', '92'],                   // Fuel, Travel
  service:  ['101', '92', '54', '19'],      // Service COGS, Travel, Fuel, Office Supplies
  reman:    ['42', '19'],                   // Equipment COGS, Office Supplies
  ops:      ['19', '338', '66'],            // Office Supplies, Working Meals, Building R&M
  freeflow: ['42', '141', '90'],            // Equipment, New Fountain Installs, Ice Machine Rental
  melt:     ['42', '141', '90'],
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
 *  department: matching IDs first (in preference order), then the rest in
 *  their original order. Doesn't drop anything. */
export function sortCogsByDepartment<T extends { id: string }>(
  cogsAccounts: ReadonlyArray<T>,
  department: string,
): T[] {
  const prefs = DEPARTMENT_COGS_PREFERENCES[department];
  if (!prefs || prefs.length === 0) return [...cogsAccounts];
  const preferred = prefs
    .map((id) => cogsAccounts.find((a) => a.id === id))
    .filter((a): a is T => a != null);
  const preferredIds = new Set(preferred.map((a) => a.id));
  const rest = cogsAccounts.filter((a) => !preferredIds.has(a.id));
  return [...preferred, ...rest];
}
