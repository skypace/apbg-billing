import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert, { type AlertColor } from '@mui/material/Alert';
import { playApplause } from './applause';

interface ToastState {
  message: string;
  severity: AlertColor;
}

interface ToastApi {
  show:    (msg: string, severity?: AlertColor) => void;
  success: (msg: string) => void;
  error:   (msg: string) => void;
  info:    (msg: string) => void;
  warn:    (msg: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);

  const show = useCallback((message: string, severity: AlertColor = 'info') => {
    setToast({ message, severity });
  }, []);

  const api: ToastApi = {
    show,
    // Every successful save gets a round of applause (Sky, 2026-09-04) —
    // mute with localStorage 'brix.applause' = 'off'.
    success: (m) => { show(m, 'success'); playApplause(); },
    error:   (m) => show(m, 'error'),
    info:    (m) => show(m, 'info'),
    warn:    (m) => show(m, 'warning'),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Snackbar
        open={!!toast}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        {toast ? (
          <Alert
            severity={toast.severity}
            variant="filled"
            onClose={() => setToast(null)}
            sx={{
              minWidth: 280,
              fontFamily: 'inherit',
              fontSize: 12.5,
              fontWeight: 500,
              alignItems: 'center',
              boxShadow: '0 12px 36px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)',
              borderRadius: 2,
            }}
          >
            {toast.message}
          </Alert>
        ) : <span />}
      </Snackbar>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Soft fallback so a missing provider doesn't crash anything.
    return {
      show:    (m) => console.log('[toast]', m),
      success: (m) => console.log('[toast:success]', m),
      error:   (m) => console.error('[toast:error]', m),
      info:    (m) => console.log('[toast:info]', m),
      warn:    (m) => console.warn('[toast:warn]', m),
    };
  }
  return ctx;
}
