import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename="/expense">
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// Register the PWA service worker (production only) so Brixpense installs to the
// home screen and serves an offline shell. Scope is /expense/ via BASE_URL.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => { /* non-fatal: app still works without the SW */ });
  });
}
