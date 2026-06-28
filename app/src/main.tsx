import { StrictMode, useEffect, useState } from 'react';
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
  const [mode, setMode] = useState<ThemeMode>(readMode);

  useEffect(() => {
    document.documentElement.setAttribute('data-apbg-theme', mode);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'light' ? '#EEF3F8' : '#06121F');
  }, [mode]);

  useEffect(() => {
    const onTheme = (e: Event) => {
      const t = (e as CustomEvent).detail?.theme;
      if (t === 'light' || t === 'dark') setMode(t);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'apbg_theme') setMode(e.newValue === 'light' ? 'light' : 'dark');
    };
    window.addEventListener('apbg:themechange', onTheme as EventListener);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('apbg:themechange', onTheme as EventListener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return (
    <ThemeProvider theme={makeBrixTheme(mode)}>
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </LocalizationProvider>
    </ThemeProvider>
  );
}

createRoot(rootEl).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
