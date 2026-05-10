import type { SalesFilters } from './sales';

// ─────────── Chain rollup modifiers ───────────
//
// Each modifier defines an additive filter (customers + categories) that
// resolves to a specific "rollup" view of the data. Multiple can be selected
// simultaneously; their customer / category lists are union'd.
//
// HIERARCHY:
//   CHE (Chain E&S)            ← MTE (Melt E&S)  + SBE (Starbird E&S)
//   CHS (Chain Soda Sales)     ← MTS (Melt Soda) + SBS (Starbird Soda)
//
// ⚠ The `customers` and `categories` strings below are PLACEHOLDERS based on
// the verbal description. Edit them to match the exact display names used
// in QBO (qbo_customers.display_name and the category taxonomy). A
// Settings → Chain Modifiers editor is the next step to make this user-
// editable without code changes.

export type ModifierGroup = 'equipment' | 'soda';

export interface ChainModifier {
  code:       string;
  label:      string;          // short label for buttons (e.g. "Melt E&S")
  full:       string;          // long description (used in tooltips)
  filters:    Partial<SalesFilters>;
  parent?:    string;          // parent rollup code (e.g. MTE.parent = 'CHE')
  group:      ModifierGroup;   // for visual grouping in the picker
}

export const CHAIN_MODIFIERS: ChainModifier[] = [
  // Chain rollups (parents)
  {
    code: 'CHE', label: 'Chain E&S',
    full: 'Chain Equipment & Service Sales',
    filters: {
      customers:  ['Melt', 'Starbird'],
      categories: ['Equipment', 'Service'],
    },
    group: 'equipment',
  },
  {
    code: 'CHS', label: 'Chain Soda',
    full: 'Chain Soda Sales',
    filters: {
      customers:  ['Melt', 'Starbird'],
      categories: ['BIB', 'Cans', 'Fountain', 'Gas'],
    },
    group: 'soda',
  },

  // Melt
  {
    code: 'MTE', label: 'Melt E&S',
    full: 'Melt Equipment & Service Sales',
    filters: { customers: ['Melt'], categories: ['Equipment', 'Service'] },
    parent: 'CHE', group: 'equipment',
  },
  {
    code: 'MTS', label: 'Melt Soda',
    full: 'Melt Soda Sales',
    filters: { customers: ['Melt'], categories: ['BIB', 'Cans', 'Fountain', 'Gas'] },
    parent: 'CHS', group: 'soda',
  },

  // Starbird
  {
    code: 'SBE', label: 'Starbird E&S',
    full: 'Starbird Equipment & Service Sales',
    filters: { customers: ['Starbird'], categories: ['Equipment', 'Service'] },
    parent: 'CHE', group: 'equipment',
  },
  {
    code: 'SBS', label: 'Starbird Soda',
    full: 'Starbird Soda Sales',
    filters: { customers: ['Starbird'], categories: ['BIB', 'Cans', 'Fountain', 'Gas'] },
    parent: 'CHS', group: 'soda',
  },
];

/** Merge a set of active modifier codes into a base filter set.
 *  Customer / category arrays are union'd. Other filter dims are untouched. */
export function applyModifiers(base: SalesFilters, codes: string[]): SalesFilters {
  if (codes.length === 0) return base;
  const next: SalesFilters = { ...base };
  for (const code of codes) {
    const m = CHAIN_MODIFIERS.find((c) => c.code === code);
    if (!m) continue;
    for (const k of ['customers', 'categories', 'items', 'channels', 'segments'] as const) {
      const vals = m.filters[k];
      if (!vals || vals.length === 0) continue;
      const cur = (next[k] as string[] | null | undefined) ?? [];
      next[k] = Array.from(new Set([...cur, ...vals]));
    }
  }
  return next;
}

// ─────────── Entity smart-defaults ───────────
//
// When the user picks an entity in the toolbar, these implied category /
// customer constraints can auto-apply so the dashboard scopes correctly
// without manual filter wiring.
//
// ⚠ Like the modifier filters above, these strings are placeholders.

export const ENTITY_AUTO_FILTERS: Record<string, Partial<SalesFilters>> = {
  AS:       { categories: ['BIB', 'Cans', 'Fountain', 'Gas'] },
  freeflow: { customers:  ['FreeFlow Customer', 'Freshpet Customer'] },
  FF:       { customers:  ['FreeFlow Customer', 'Freshpet Customer'] },
  brix:     { categories: ['Service', 'Equipment Rental'] },
};

/** Apply entity-implied defaults onto a base filter set. */
export function applyEntityDefaults(base: SalesFilters, entity: string | null): SalesFilters {
  if (!entity) return base;
  const d = ENTITY_AUTO_FILTERS[entity];
  if (!d) return { ...base, entities: [entity] };
  return {
    ...base,
    entities: [entity],
    categories: d.categories ?? base.categories,
    customers:  d.customers  ?? base.customers,
    items:      d.items      ?? base.items,
  };
}
