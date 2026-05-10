import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import { LicenseInfo } from '@mui/x-license';
import { LocalizationProvider } from '@mui/x-date-pickers-pro';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import './styles/theme.css';
import { App } from './App';
import { brixTheme } from './lib/muiTheme';
import { ToastProvider } from './lib/toast';

// MUI X Pro license — set from VITE_MUI_LICENSE_KEY (Netlify env + .env.local).
LicenseInfo.setLicenseKey(import.meta.env.VITE_MUI_LICENSE_KEY ?? '');

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing from index.html');

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider theme={brixTheme}>
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </LocalizationProvider>
    </ThemeProvider>
  </StrictMode>,
);
