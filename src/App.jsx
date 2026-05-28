import { useEffect, useState } from 'react';
import { db, listOpenAlerts, listRules, isConfigured } from './lib/supabase.js';
import LoginScreen from './components/LoginScreen.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [rules, setRules] = useState([]);
  const [err, setErr] = useState(null);

  // ─── auth state ──────────────────────────────────────────────────
  useEffect(() => {
    if (!isConfigured) {
      setAuthReady(true);
      return;
    }
    db.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = db.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // ─── load data once signed in ────────────────────────────────────
  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const [a, r] = await Promise.all([listOpenAlerts(), listRules()]);
        setAlerts(a);
        setRules(r);
      } catch (e) {
        setErr(e.message);
      }
    })();
  }, [session]);

  if (!isConfigured) {
    return (
      <div className="app">
        <h1 className="h1">Nag agent</h1>
        <div className="card" style={{ borderColor: 'var(--rust)' }}>
          <strong>Setup needed.</strong>
          <p className="sub" style={{ marginTop: 6 }}>
            <code>VITE_SUPABASE_ANON_KEY</code> isn't set. To fix:
          </p>
          <ol style={{ marginTop: 8, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
            <li>Copy <code>.env.example</code> to <code>.env</code></li>
            <li>Open the Supabase dashboard → <strong>Nag agent</strong> → Settings → API</li>
            <li>Copy the <strong>anon / publishable</strong> key</li>
            <li>Paste it into <code>.env</code> as <code>VITE_SUPABASE_ANON_KEY=...</code></li>
            <li>Restart <code>npm run dev</code> (env vars only load at startup)</li>
          </ol>
        </div>
      </div>
    );
  }

  if (!authReady) return null;
  if (!session) return <LoginScreen />;

  return (
    <div className="app">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <h1 className="h1" style={{ margin: 0 }}>Nag agent</h1>
        <button
          onClick={() => db.auth.signOut()}
          style={{ background: 'transparent', border: '1px solid var(--line)', padding: '4px 10px', fontSize: 12, borderRadius: 4, cursor: 'pointer', color: 'var(--ink-soft)' }}
        >
          Sign out · {session.user.email}
        </button>
      </div>
      <p className="sub">v0.1 · skeleton · connected to {import.meta.env.VITE_SUPABASE_URL}</p>

      {err && (
        <div className="card" style={{ borderColor: 'var(--rust)', color: 'var(--rust)' }}>
          {err}
        </div>
      )}

      <h2 style={{ fontSize: 18, marginTop: 16, marginBottom: 8 }}>Open alerts</h2>
      {alerts.length === 0 ? (
        <div className="card sub">No open alerts yet. Once the ingest + rule engine run, alerts will land here.</div>
      ) : (
        alerts.map((a) => (
          <div key={a.id} className="card">
            <span className={`pill ${a.severity}`}>{a.severity}</span>
            <h3 style={{ marginTop: 6, fontSize: 16 }}>{a.title}</h3>
            {a.body && <p className="sub" style={{ marginTop: 4 }}>{a.body}</p>}
          </div>
        ))
      )}

      <h2 style={{ fontSize: 18, marginTop: 24, marginBottom: 8 }}>Active rules ({rules.filter((r) => r.enabled).length})</h2>
      {rules.map((r) => (
        <div key={r.id} className="card">
          <strong>{r.name}</strong>
          {!r.enabled && <span className="pill" style={{ marginLeft: 8, background: 'var(--ink-faint)' }}>disabled</span>}
          <p className="sub" style={{ marginTop: 4, fontSize: 13 }}>{r.description}</p>
        </div>
      ))}
    </div>
  );
}
