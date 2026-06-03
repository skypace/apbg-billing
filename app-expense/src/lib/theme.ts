// Brixpense theme controller — adaptive light / dark.
//
// The class is applied to <html> (Tailwind darkMode: 'class'). A pre-paint
// inline script in index.html sets it before first paint to avoid a flash;
// this module owns the runtime toggle + persistence.

export type Theme = 'light' | 'dark';

const KEY = 'brixpense-theme';

function systemPref(): Theme {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/** The theme in effect right now (explicit choice, else system preference). */
export function currentTheme(): Theme {
  return storedTheme() ?? systemPref();
}

export function applyTheme(t: Theme) {
  const el = document.documentElement;
  el.classList.toggle('dark', t === 'dark');
  el.classList.toggle('light', t === 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0b0b0e' : '#f5f5f7');
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode — runtime toggle still works for the session */
  }
  applyTheme(t);
}

/** Flip and persist; returns the new theme. */
export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
