import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import { LicenseInfo } from '@mui/x-license';
import { LocalizationProvider } from '@mui/x-date-pickers-pro';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import './styles/theme.css';
import './styles/hero.css';
import './styles/print.css';
import { App } from './App';
import { makeBrixTheme, type ThemeMode } from './lib/muiTheme';
import { ThemeModeContext } from './lib/themeMode';
import { ToastProvider } from './lib/toast';

// MUI X Pro license — read VITE_MUI_LICENSE_KEY at build time.
LicenseInfo.setLicenseKey(import.meta.env.VITE_MUI_LICENSE_KEY ?? '');

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing from index.html');

// Refractor follows the universal APBG light/dark switch. The gateway waffle
// launcher writes localStorage.apbg_theme and fires 'apbg:themechange'; other
// tabs/apps surface as 'storage'. We swap both the MUI theme AND the
// data-apbg-theme attribute (theme.css keys off it) so the navy-glass UI flips
// to its light variant. The app keeps its brand in both modes.
function readMode(): ThemeMode {
  try { return localStorage.getItem('apbg_theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

function Root() {
  const [mode, setModeState] = useState<ThemeMode>(readMode);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try { localStorage.setItem('apbg_theme', next); } catch { /* no-op */ }
    // Notify the gateway waffle + any other embedded surface on the page.
    try { window.dispatchEvent(new CustomEvent('apbg:themechange', { detail: { theme: next } })); } catch { /* no-op */ }
  }, []);

  const toggleMode = useCallback(() => {
    setMode(readMode() === 'light' ? 'dark' : 'light');
  }, [setMode]);

  useEffect(() => {
    document.documentElement.setAttribute('data-apbg-theme', mode);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'light' ? '#EEF3F8' : '#000000');
  }, [mode]);

  useEffect(() => {
    const onTheme = (e: Event) => {
      const t = (e as CustomEvent).detail?.theme;
      if (t === 'light' || t === 'dark') setModeState(t);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'apbg_theme') setModeState(e.newValue === 'light' ? 'light' : 'dark');
    };
    window.addEventListener('apbg:themechange', onTheme as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('apbg:themechange', onTheme as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return (
    <ThemeModeContext.Provider value={{ mode, setMode, toggleMode }}>
      <ThemeProvider theme={makeBrixTheme(mode)}>
        <LocalizationProvider dateAdapter={AdapterDayjs}>
          <ToastProvider>
            <App />
          </ToastProvider>
        </LocalizationProvider>
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}

createRoot(rootEl).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
