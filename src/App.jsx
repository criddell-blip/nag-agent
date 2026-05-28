import { useEffect, useState } from 'react';
import { listOpenAlerts, listRules } from './lib/supabase.js';

export default function App() {
  const [alerts, setAlerts] = useState([]);
  const [rules, setRules] = useState([]);
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [a, r] = await Promise.all([listOpenAlerts(), listRules()]);
        setAlerts(a);
        setRules(r);
      } catch (e) {
        setErr(e.message);
      }
    })();
  }, []);

  return (
    <div className="app">
      <h1 className="h1">Nag agent</h1>
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
