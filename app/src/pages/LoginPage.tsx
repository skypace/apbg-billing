import { useState } from 'react';
import { sbAuth } from '../lib/supabase';
import { btnPrimary, inp } from '../lib/styles';

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
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <form onSubmit={submit} className="cd" style={{ padding: 24, width: 360 }}>
        <div className="ct" style={{ margin: '0 0 12px' }}>PACER · MARGIN</div>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 18, color: 'var(--ac)' }}>
          Sign in
        </div>

        <label style={{ display: 'block', fontSize: 10, color: 'var(--mt)', textTransform: 'uppercase', marginBottom: 4 }}>
          Email
        </label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ ...inp(), width: '100%', marginBottom: 12 }}
        />

        <label style={{ display: 'block', fontSize: 10, color: 'var(--mt)', textTransform: 'uppercase', marginBottom: 4 }}>
          Password
        </label>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ ...inp(), width: '100%', marginBottom: 14 }}
        />

        {err && (
          <div style={{ fontSize: 11, color: 'var(--rd)', marginBottom: 10 }}>{err}</div>
        )}

        <button type="submit" disabled={busy} style={{ ...btnPrimary(), width: '100%' }}>
          {busy ? 'SIGNING IN…' : 'SIGN IN'}
        </button>
      </form>
    </div>
  );
}
