import type { SalesFilters } from './sales';

// Chain rollup modifiers — selected via the compact ModifierPicker filter.
// Each one applies a (customers ∪ categories) constraint additively.
//
// HIERARCHY:
//   CHE (Chain E&S)            ← MTE (Melt E&S)  + SBE (Starbird E&S)
//   CHS (Chain Soda Sales)     ← MTS (Melt Soda) + SBS (Starbird Soda)
//
// Customer names are the exact QBO display names. Category names are
// placeholders — verify against the actual taxonomy and edit here if needed.

export type ModifierGroup = 'equipment' | 'soda';

export interface ChainModifier {
  code:       string;
  label:      string;
  full:       string;
  filters:    Partial<SalesFilters>;
  parent?:    string;
  group:      ModifierGroup;
}

const MELT     = 'THE MELT';
const STARBIRD = 'STARBIRD';

const ES_CATEGORIES  = ['Equipment', 'Service'];
const SODA_CATEGORIES = ['BIB', 'Cans', 'Fountain', 'Gas'];

export const CHAIN_MODIFIERS: ChainModifier[] = [
  {
    code: 'CHE', label: 'Chain E&S',
    full: 'Chain Equipment & Service Sales',
    filters: { customers: [MELT, STARBIRD], categories: ES_CATEGORIES },
    group: 'equipment',
  },
  {
    code: 'CHS', label: 'Chain Soda',
    full: 'Chain Soda Sales',
    filters: { customers: [MELT, STARBIRD], categories: SODA_CATEGORIES },
    group: 'soda',
  },
  {
    code: 'MTE', label: 'Melt E&S',
    full: 'Melt Equipment & Service Sales',
    filters: { customers: [MELT], categories: ES_CATEGORIES },
    parent: 'CHE', group: 'equipment',
  },
  {
    code: 'MTS', label: 'Melt Soda',
    full: 'Melt Soda Sales',
    filters: { customers: [MELT], categories: SODA_CATEGORIES },
    parent: 'CHS', group: 'soda',
  },
  {
    code: 'SBE', label: 'Starbird E&S',
    full: 'Starbird Equipment & Service Sales',
    filters: { customers: [STARBIRD], categories: ES_CATEGORIES },
    parent: 'CHE', group: 'equipment',
  },
  {
    code: 'SBS', label: 'Starbird Soda',
    full: 'Starbird Soda Sales',
    filters: { customers: [STARBIRD], categories: SODA_CATEGORIES },
    parent: 'CHS', group: 'soda',
  },
];

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

export const ENTITY_AUTO_FILTERS: Record<string, Partial<SalesFilters>> = {
  AS:       { categories: SODA_CATEGORIES },
  freeflow: { customers:  ['FREEFLOW CUSTOMER', 'FRESHPET CUSTOMER'] },
  FF:       { customers:  ['FREEFLOW CUSTOMER', 'FRESHPET CUSTOMER'] },
  brix:     { categories: ['Service', 'Equipment Rental'] },
};

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
