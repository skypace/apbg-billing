import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Loader2 } from 'lucide-react';
import { BrixMark, BrixWordmark } from '@/components/BrixMark';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error: err } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <BrixMark size={96} />
          <BrixWordmark style={{ fontSize: '1.8rem' }} />
          <span className="brand-sub">Sub-Distributor Portal</span>
        </div>

        <p className="login-desc">
          Sign in with the email and password Brix Beverage set up for you.
        </p>

        <form onSubmit={handleLogin} className="login-form">
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              placeholder="you@yourcompany.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="email"
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="login-btn" disabled={loading}>
            {loading && <Loader2 size={16} className="spin" />}
            Sign In
          </button>
        </form>

        <p className="login-desc" style={{ marginTop: 20, marginBottom: 0 }}>
          Trouble signing in? Contact your Brix Beverage rep.
        </p>
      </div>
    </div>
  );
}
