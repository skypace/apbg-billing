// Typed localStorage wrapper for user-editable settings.
// Single prefix so we can sweep all user settings (e.g. for a future
// "Export to JSON" / "Reset everything" button).

const PREFIX = 'brix.settings.';

export const KEYS = {
  chainModifiers:   'chainModifiers',
  entityDefaults:   'entityDefaults',
  itemRules:        'itemTaxonomyRules',
  customerRules:    'customerTaxonomyRules',
  // Margin → Columns picker. Stored as Record<Dim, ColumnId[]> so
  // each Group-by dim remembers which extra columns the user wants.
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
