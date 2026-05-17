// Typed localStorage wrapper for user-editable settings.
// Single prefix so we can sweep all user settings (e.g. for a future
// "Export to JSON" / "Reset everything" button).

const PREFIX = 'brix.settings.';

export const KEYS = {
  // Bumped to v2 on 2026-05-17 when the rollup model changed from
  // intersection-style (customers AND categories per chip) to flat
  // single-dimension exclusion (chains exclude customers, category
  // chips exclude categories). Old v1 values would still describe the
  // intersection shape and produce empty grids on click.
  chainModifiers:   'chainModifiersV2',
  entityDefaults:   'entityDefaults',
  itemRules:        'itemTaxonomyRules',
  customerRules:    'customerTaxonomyRules',
  marginColumns:    'marginColumns',
} as const;

export function loadSetting<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveSetting<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota exceeded or storage unavailable — silently ignore */
  }
}

export function resetSetting(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Wipe every brix.settings.* key. */
export function resetAllSettings(): void {
  if (typeof window === 'undefined') return;
  try {
    const drop: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(PREFIX)) drop.push(k);
    }
    for (const k of drop) window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
