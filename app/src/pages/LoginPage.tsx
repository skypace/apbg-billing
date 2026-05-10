import { useState } from 'react';
import { ArrowRight, AlertCircle } from 'lucide-react';
import { sbAuth } from '../lib/supabase';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const { error } = await sbAuth.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setErr(error.message);
  }

  return (
    <div className="login-shell">
      <div className="login-bg" aria-hidden="true" />
      <div className="login-card-wrap">
        <div className="login-brand">
          <div className="brand-mark login-brand-mark">BRIX</div>
          <div className="login-brand-sub">
            <span className="status-dot" aria-hidden="true" />
            Margin Control
          </div>
          <div className="login-tagline">
            Real-time margin, cost coverage, and customer health.
          </div>
          <div className="login-meta">Brix Beverage · Alameda Soda Co</div>
        </div>

        <form onSubmit={submit} className="login-form">
          <div className="login-form-eyebrow">Sign in</div>

          <label className="login-field">
            <span className="login-label">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="login-input"
              placeholder="you@brixbev.com"
            />
          </label>

          <label className="login-field">
            <span className="login-label">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="login-input"
              placeholder="••••••••"
            />
          </label>

          {err && (
            <div className="login-error" role="alert">
              <AlertCircle size={14} strokeWidth={2.2} aria-hidden="true" />
              <span>{err}</span>
            </div>
          )}

          <button type="submit" disabled={busy} className="login-submit">
            {busy ? (
              <span>Signing in…</span>
            ) : (
              <>
                <span>Sign in</span>
                <ArrowRight size={14} strokeWidth={2.4} aria-hidden="true" />
              </>
            )}
          </button>

          <div className="login-foot">
            Trouble signing in?{' '}
            <a href="mailto:service@brixbev.com">service@brixbev.com</a>
          </div>
        </form>

        <div className="login-credit">
          © {new Date().getFullYear()} Alameda Beverage Group LLC
        </div>
      </div>
    </div>
  );
}
