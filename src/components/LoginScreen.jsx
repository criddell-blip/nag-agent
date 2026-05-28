import { useState } from 'react';
import { db } from '../lib/supabase.js';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle');
  const [err, setErr] = useState(null);

  async function sendLink(e) {
    e.preventDefault();
    setErr(null);
    setStatus('sending');
    const { error } = await db.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    if (error) {
      setErr(error.message);
      setStatus('idle');
    } else {
      setStatus('sent');
    }
  }

  return (
    <div className="app" style={{ maxWidth: 420 }}>
      <h1 className="h1">Nag agent</h1>
      <p className="sub">Sign in with a magic link</p>

      {status === 'sent' ? (
        <div className="card">
          <strong>Check your email.</strong>
          <p className="sub" style={{ marginTop: 6 }}>
            Sent a magic link to <code>{email}</code>. Click it and you'll be signed in.
          </p>
          <button
            className="btn"
            style={{ marginTop: 12, background: 'transparent', border: '1px solid var(--line)', padding: '6px 12px', borderRadius: 4, cursor: 'pointer' }}
            onClick={() => { setStatus('idle'); setErr(null); }}
          >
            Use a different email
          </button>
        </div>
      ) : (
        <form className="card" onSubmit={sendLink}>
          <label style={{ display: 'block', fontSize: 13, color: 'var(--ink-soft)', marginBottom: 6 }}>Email</label>
          <input
            type="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', fontSize: 14, border: '1px solid var(--line)', borderRadius: 4, background: 'var(--paper)' }}
          />
          {err && <p style={{ marginTop: 8, fontSize: 13, color: 'var(--rust)' }}>{err}</p>}
          <button
            type="submit"
            disabled={status === 'sending' || !email}
            style={{
              marginTop: 12,
              width: '100%',
              padding: '10px 14px',
              fontSize: 14,
              fontWeight: 600,
              border: 'none',
              borderRadius: 4,
              background: 'var(--ink)',
              color: 'var(--paper)',
              cursor: status === 'sending' ? 'wait' : 'pointer',
              opacity: status === 'sending' || !email ? 0.6 : 1,
            }}
          >
            {status === 'sending' ? 'Sending…' : 'Send magic link'}
          </button>
        </form>
      )}
    </div>
  );
}
