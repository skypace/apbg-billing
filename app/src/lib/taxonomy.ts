// Smart classifiers that group items / customers into natural buckets
// so the pickers and tables cluster related rows together.
//
// Pattern matching is keyword-based against UPPERCASED display names.
// Order matters: more-specific patterns first, more-general patterns last.
// Edit the patterns here as the actual taxonomy emerges.

// ─────────── Item classifier ───────────

export function classifyItem(name: string): string {
  const n = (name ?? '').toUpperCase();

  // Most specific: customer-prefixed equipment
  if (/(THE\s+)?MELT/.test(n) && (n.includes('EQUIPMENT') || n.includes('RENTAL') || n.includes('LEASE')))
    return 'Melt Equipment';
  if (n.includes('STARBIRD') && (n.includes('EQUIPMENT') || n.includes('RENTAL') || n.includes('LEASE')))
    return 'Starbird Equipment';

  // Size-based (BIB / tank capacity) — useful for soda product family
  if (/\b3[\s-]?GAL/.test(n))  return '3-Gallon';
  if (/\b5[\s-]?GAL/.test(n))  return '5-Gallon';
  if (/\b2\.5[\s-]?GAL/.test(n)) return '2.5-Gallon';
  if (/\b1[\s-]?GAL/.test(n))  return '1-Gallon';

  // Equipment / hardware
  if (/(DISPENSER|TOWER|TAP|VALVE|REGULATOR|COMPRESSOR|CHILLER|ICE\s+MACHINE)/.test(n)) return 'Equipment';
  if (/(EQUIPMENT|RENTAL|LEASE)/.test(n)) return 'Equipment';

  // Services & labor
  if (/(SERVICE|LABOR|REPAIR|INSTALL|MAINTENANCE|TRIP|CALL)/.test(n)) return 'Service';

  // Consumables — categories aligned with the AS soda product mix
  if (/(BIB|BAG[\s-]?IN[\s-]?BOX)/.test(n))     return 'BIB';
  if (/(CAN\b|CANS)/.test(n))                   return 'Cans';
  if (/FOUNTAIN/.test(n))                       return 'Fountain';
  if (/SYRUP/.test(n))                          return 'Syrup';

  // Gas / CO2 / nitrogen
  if (/(CO2|CARBON\s+DIOXIDE|NITROGEN|NITRO|N2|GAS\b|HELIUM)/.test(n)) return 'Gas / CO2';

  // Misc consumables / parts
  if (/(FILTER|CLEANER|SANITIZER|HOSE|FITTING|PART)/.test(n)) return 'Parts & Consumables';

  return 'Other';
}

// ─────────── Customer classifier ───────────

export function classifyCustomer(name: string): string {
  const n = (name ?? '').toUpperCase();

  // Chain customers (rolled up via CHAIN_MODIFIERS) — keep them visually together
  if (/(THE\s+)?MELT/.test(n))     return 'Melt';
  if (/STARBIRD/.test(n))          return 'Starbird';
  if (/FREEFLOW|FRESHPET/.test(n)) return 'FreeFlow';

  // Big-name brand customers (legacy hero logos on brixbev.com)
  if (/(PIXAR|TWITTER|UBER|ADOBE|SFO|BON\s+APP)/.test(n)) return 'Marquee Accounts';

  // Channel hints from the name itself
  if (/(CAFE|COFFEE)/.test(n))     return 'Cafes';
  if (/(BAR|TAVERN|PUB)/.test(n))  return 'Bars';
  if (/(RESTAURANT|GRILL|BISTRO|DINER|KITCHEN)/.test(n)) return 'Restaurants';
  if (/(HOTEL|RESORT|INN)/.test(n)) return 'Hotels';
  if (/(MARKET|GROCER|DELI|STORE)/.test(n)) return 'Retail';
  if (/(SCHOOL|UNIVERSITY|COLLEGE|HIGH|COURT|CIVIC|HALL|MUNICIPAL)/.test(n)) return 'Institutional';

  return 'Other';
}

// ─────────── Group display order ───────────
//
// MUI Autocomplete renders groups in the order their first option appears in the
// option list. The MultiPicker pre-sorts options (selected → revenue desc → alpha),
// so the group order ends up driven by which group's heaviest hitter is at the
// top. That's usually fine, but for taxonomic readability we can re-order
// explicitly by post-sorting options to put a preferred group order first.

export const ITEM_GROUP_ORDER: Record<string, number> = {
  'Equipment':              10,
  'Melt Equipment':         11,
  'Starbird Equipment':     12,
  '5-Gallon':               20,
  '3-Gallon':               21,
  '2.5-Gallon':             22,
  '1-Gallon':               23,
  'BIB':                    30,
  'Cans':                   31,
  'Fountain':               32,
  'Syrup':                  33,
  'Gas / CO2':              40,
  'Parts & Consumables':    50,
  'Service':                60,
  'Other':                  99,
};

export const CUSTOMER_GROUP_ORDER: Record<string, number> = {
  'Melt':              10,
  'Starbird':          11,
  'FreeFlow':          12,
  'Marquee Accounts':  20,
  'Restaurants':       30,
  'Cafes':             31,
  'Bars':              32,
  'Hotels':            33,
  'Retail':            34,
  'Institutional':     35,
  'Other':             99,
};
