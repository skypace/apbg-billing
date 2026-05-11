import type { SalesFilters } from './sales';
import { loadSetting, saveSetting, KEYS } from './settingsStore';

// ─────────── Type definitions ───────────

export type ModifierGroup = 'equipment' | 'soda';

export interface ChainModifier {
  code:    string;
  label:   string;
  full:    string;
  filters: Partial<SalesFilters>;
  parent?: string;
  group:   ModifierGroup;
}

// ─────────── Defaults (shipped baseline) ───────────

const MELT     = 'THE MELT';
const STARBIRD = 'STARBIRD';
const ES_CATEGORIES   = ['Equipment', 'Service'];
const SODA_CATEGORIES = ['BIB', 'Cans', 'Fountain', 'Gas'];

export const DEFAULT_CHAIN_MODIFIERS: ChainModifier[] = [
  { code: 'CHE', label: 'Chain E&S',     full: 'Chain Equipment & Service Sales',
    filters: { customers: [MELT, STARBIRD], categories: ES_CATEGORIES }, group: 'equipment' },
  { code: 'CHS', label: 'Chain Soda',    full: 'Chain Soda Sales',
    filters: { customers: [MELT, STARBIRD], categories: SODA_CATEGORIES }, group: 'soda' },
  { code: 'MTE', label: 'Melt E&S',      full: 'Melt Equipment & Service Sales',
    filters: { customers: [MELT], categories: ES_CATEGORIES }, parent: 'CHE', group: 'equipment' },
  { code: 'MTS', label: 'Melt Soda',     full: 'Melt Soda Sales',
    filters: { customers: [MELT], categories: SODA_CATEGORIES }, parent: 'CHS', group: 'soda' },
  { code: 'SBE', label: 'Starbird E&S',  full: 'Starbird Equipment & Service Sales',
    filters: { customers: [STARBIRD], categories: ES_CATEGORIES }, parent: 'CHE', group: 'equipment' },
  { code: 'SBS', label: 'Starbird Soda', full: 'Starbird Soda Sales',
    filters: { customers: [STARBIRD], categories: SODA_CATEGORIES }, parent: 'CHS', group: 'soda' },
];

export const DEFAULT_ENTITY_AUTO_FILTERS: Record<string, Partial<SalesFilters>> = {
  AS:       { categories: SODA_CATEGORIES },
  freeflow: { customers:  ['FREEFLOW CUSTOMER', 'FRESHPET CUSTOMER'] },
  FF:       { customers:  ['FREEFLOW CUSTOMER', 'FRESHPET CUSTOMER'] },
  brix:     { categories: ['Service', 'Equipment Rental'] },
};

// ─────────── Runtime getters/setters (localStorage-backed) ───────────

export function getChainModifiers(): ChainModifier[] {
  return loadSetting<ChainModifier[]>(KEYS.chainModifiers, DEFAULT_CHAIN_MODIFIERS);
}
export function setChainModifiers(list: ChainModifier[]): void {
  saveSetting(KEYS.chainModifiers, list);
}

export function getEntityDefaults(): Record<string, Partial<SalesFilters>> {
  return loadSetting<Record<string, Partial<SalesFilters>>>(KEYS.entityDefaults, DEFAULT_ENTITY_AUTO_FILTERS);
}
export function setEntityDefaults(map: Record<string, Partial<SalesFilters>>): void {
  saveSetting(KEYS.entityDefaults, map);
}

/** @deprecated kept for backward compat — use getChainModifiers() instead. */
export const CHAIN_MODIFIERS = DEFAULT_CHAIN_MODIFIERS;
/** @deprecated kept for backward compat — use getEntityDefaults() instead. */
export const ENTITY_AUTO_FILTERS = DEFAULT_ENTITY_AUTO_FILTERS;

// ─────────── Apply helpers (route through runtime getters) ───────────

export function applyModifiers(base: SalesFilters, codes: string[]): SalesFilters {
  if (codes.length === 0) return base;
  const list = getChainModifiers();
  const next: SalesFilters = { ...base };
  for (const code of codes) {
    const m = list.find((c) => c.code === code);
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

export function applyEntityDefaults(base: SalesFilters, entity: string | null): SalesFilters {
  if (!entity) return base;
  const map = getEntityDefaults();
  const d = map[entity];
  if (!d) return { ...base, entities: [entity] };
  return {
    ...base,
    entities: [entity],
    categories: d.categories ?? base.categories,
    customers:  d.customers  ?? base.customers,
    items:      d.items      ?? base.items,
  };
}
