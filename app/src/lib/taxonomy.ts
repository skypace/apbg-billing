import { loadSetting, saveSetting, KEYS } from './settingsStore';

// A rule is a regex pattern → group label mapping with an order weight
// (lower = higher priority). The classifier walks rules in order and
// returns the first matching label, falling through to 'Other'.

export interface TaxonomyRule {
  pattern: string;   // regex source (case-insensitive flag is applied)
  label:   string;   // group name shown in the picker
  order:   number;   // sort weight (lower first)
}

// ─────────── Default rules — items ───────────

export const DEFAULT_ITEM_RULES: TaxonomyRule[] = [
  { pattern: '(THE\\s+)?MELT.*(EQUIPMENT|RENTAL|LEASE)',  label: 'Melt Equipment',      order: 11 },
  { pattern: 'STARBIRD.*(EQUIPMENT|RENTAL|LEASE)',         label: 'Starbird Equipment',  order: 12 },
  { pattern: '\\b5[\\s-]?GAL',                             label: '5-Gallon',            order: 20 },
  { pattern: '\\b3[\\s-]?GAL',                             label: '3-Gallon',            order: 21 },
  { pattern: '\\b2\\.5[\\s-]?GAL',                         label: '2.5-Gallon',          order: 22 },
  { pattern: '\\b1[\\s-]?GAL',                             label: '1-Gallon',            order: 23 },
  { pattern: '(DISPENSER|TOWER|TAP|VALVE|REGULATOR|COMPRESSOR|CHILLER|ICE\\s+MACHINE)', label: 'Equipment', order: 30 },
  { pattern: '(EQUIPMENT|RENTAL|LEASE)',                   label: 'Equipment',           order: 31 },
  { pattern: '(SERVICE|LABOR|REPAIR|INSTALL|MAINTENANCE|TRIP|CALL)', label: 'Service',  order: 60 },
  { pattern: '(BIB|BAG[\\s-]?IN[\\s-]?BOX)',               label: 'BIB',                 order: 40 },
  { pattern: '(CAN\\b|CANS)',                              label: 'Cans',                order: 41 },
  { pattern: 'FOUNTAIN',                                   label: 'Fountain',            order: 42 },
  { pattern: 'SYRUP',                                      label: 'Syrup',               order: 43 },
  { pattern: '(CO2|CARBON\\s+DIOXIDE|NITROGEN|NITRO|N2|GAS\\b|HELIUM)', label: 'Gas / CO2', order: 50 },
  { pattern: '(FILTER|CLEANER|SANITIZER|HOSE|FITTING|PART)', label: 'Parts & Consumables', order: 55 },
];

// ─────────── Default rules — customers ───────────

export const DEFAULT_CUSTOMER_RULES: TaxonomyRule[] = [
  { pattern: '(THE\\s+)?MELT',     label: 'Melt',              order: 10 },
  { pattern: 'STARBIRD',           label: 'Starbird',          order: 11 },
  { pattern: 'FREEFLOW|FRESHPET',  label: 'FreeFlow',          order: 12 },
  { pattern: '(PIXAR|TWITTER|UBER|ADOBE|SFO|BON\\s+APP)', label: 'Marquee Accounts', order: 20 },
  { pattern: '(CAFE|COFFEE)',      label: 'Cafes',             order: 31 },
  { pattern: '(BAR|TAVERN|PUB)',   label: 'Bars',              order: 32 },
  { pattern: '(RESTAURANT|GRILL|BISTRO|DINER|KITCHEN)', label: 'Restaurants', order: 30 },
  { pattern: '(HOTEL|RESORT|INN)', label: 'Hotels',            order: 33 },
  { pattern: '(MARKET|GROCER|DELI|STORE)', label: 'Retail',    order: 34 },
  { pattern: '(SCHOOL|UNIVERSITY|COLLEGE|HIGH|COURT|CIVIC|HALL|MUNICIPAL)', label: 'Institutional', order: 35 },
];

// ─────────── Runtime getters/setters ───────────

export function getItemRules(): TaxonomyRule[] {
  return loadSetting<TaxonomyRule[]>(KEYS.itemRules, DEFAULT_ITEM_RULES);
}
export function setItemRules(rules: TaxonomyRule[]): void {
  saveSetting(KEYS.itemRules, rules);
}

export function getCustomerRules(): TaxonomyRule[] {
  return loadSetting<TaxonomyRule[]>(KEYS.customerRules, DEFAULT_CUSTOMER_RULES);
}
export function setCustomerRules(rules: TaxonomyRule[]): void {
  saveSetting(KEYS.customerRules, rules);
}

// ─────────── Classifier ───────────

function classify(name: string, rules: TaxonomyRule[]): string {
  const n = (name ?? '').toUpperCase();
  const sorted = [...rules].sort((a, b) => a.order - b.order);
  for (const r of sorted) {
    try {
      if (new RegExp(r.pattern, 'i').test(n)) return r.label;
    } catch {
      /* malformed regex — skip */
    }
  }
  return 'Other';
}

export function classifyItem(name: string): string {
  return classify(name, getItemRules());
}
export function classifyCustomer(name: string): string {
  return classify(name, getCustomerRules());
}

// ─────────── Group display order (derived from rules) ───────────
//
// The MultiPicker uses these maps to pre-sort options so that groups
// appear in a deliberate sequence. We derive them at module load from
// the current rule set; updates take effect on next page reload (or via
// the editor's "apply" action).

function buildOrder(rules: TaxonomyRule[]): Record<string, number> {
  const m: Record<string, number> = { Other: 99 };
  for (const r of rules) {
    if (!(r.label in m) || r.order < m[r.label]) m[r.label] = r.order;
  }
  return m;
}

export function getItemGroupOrder():     Record<string, number> { return buildOrder(getItemRules());     }
export function getCustomerGroupOrder(): Record<string, number> { return buildOrder(getCustomerRules()); }

// Backward-compatible static exports — these are snapshots from defaults
// and don't reflect user edits made after page load. Prefer the get*()
// variants in new code.
export const ITEM_GROUP_ORDER     = buildOrder(DEFAULT_ITEM_RULES);
export const CUSTOMER_GROUP_ORDER = buildOrder(DEFAULT_CUSTOMER_RULES);
