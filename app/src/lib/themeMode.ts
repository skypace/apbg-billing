import { createContext, useContext } from 'react';
import type { ThemeMode } from './muiTheme';

// Shared light/dark context. main.tsx owns the state + side effects (persist to
// localStorage, fire the canonical 'apbg:themechange' event); any component can
// read `mode` and flip it via `toggleMode` (e.g. the sidebar toggle).
export interface ThemeModeCtx {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggleMode: () => void;
}

export const ThemeModeContext = createContext<ThemeModeCtx>({
  mode: 'dark',
  setMode: () => {},
  toggleMode: () => {},
});

export function useThemeMode(): ThemeModeCtx {
  return useContext(ThemeModeContext);
}
