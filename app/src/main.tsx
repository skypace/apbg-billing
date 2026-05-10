import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import { LicenseInfo } from '@mui/x-license';
import './styles/theme.css';
import { App } from './App';
import { brixTheme } from './lib/muiTheme';

// MUI X Pro license — set from VITE_MUI_LICENSE_KEY (Netlify env + .env.local).
// Without this, DataGrid Pro renders a watermark in production.
LicenseInfo.setLicenseKey(import.meta.env.VITE_MUI_LICENSE_KEY ?? '');

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing from index.html');

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider theme={brixTheme}>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
