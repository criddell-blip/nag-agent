import { useEffect, useState } from 'react';
import {
  db,
  isConfigured,
  listOpenAlerts,
  listRules,
  listRecentEvents,
  listIntegrations,
  countPeopleByPriority,
} from './lib/supabase.js';
import LoginScreen from './components/LoginScreen.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [rules, setRules] = useState([]);
  const [events, setEvents] = useState([]);
  const [integrations, setIntegrations] = useState([]);
  const [peopleCounts, setPeopleCounts] = useState({});
  const [err, setErr] = useState(null);

  // ─── auth state ──────────────────────────────────────────────────
  useEffect(() => {
    if (!isConfigured) { setAuthReady(true); return; }
    db.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = db.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // ─── load + realtime ─────────────────────────────────────────────
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    async function loadAll() {
      try {
        const [a, r, ev, ints, pc] = await Promise.all([
          listOpenAlerts(),
          listRules(),
          listRecentEvents(25),
          listIntegrations(),
          countPeopleByPriority(),
        ]);
        if (cancelled) return;
        setAlerts(a); setRules(r); setEvents(ev); setIntegrations(ints); setPeopleCounts(pc);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    }
    loadAll();

    // Realtime: re-load when alerts/events change.
    const ch = db
      .channel('nag-dashboard-' + Date.now())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'integrations' }, loadAll)
      .subscribe();

    return () => { cancelled = true; db.removeChannel(ch); };
  }, [session]);

  if (!isConfigured) {
    return (
      <div className="app">
        <h1 className="h1">Nag agent</h1>
        <div className="card" style={{ borderColor: 'var(--rust)' }}>
          <strong>Setup needed.</strong>
          <p className="sub" style={{ marginTop: 6 }}>
            <code>VITE_SUPABASE_ANON_KEY</code> isn't set. Copy <code>.env.example</code> to <code>.env</code>, paste the publishable key from Supabase dashboard, restart <code>npm run dev</code>.
          </p>
        </div>
      </div>
    );
  }

  if (!authReady) return null;
  if (!session) return <LoginScreen />;

  const counts = peopleCounts;
  const peopleTotal = (counts.critical ?? 0) + (counts.high ?? 0) + (counts.normal ?? 0) + (counts.low ?? 0) + (counts.noise ?? 0);

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
      <p className="sub">v0.2 · Phase 2 · {peopleTotal} people · {rules.length} rules</p>

      {err && (
        <div className="card" style={{ borderColor: 'var(--rust)', color: 'var(--rust)' }}>{err}</div>
      )}

      {/* ─── Integrations ─────────────────────────────────────────── */}
      <h2 style={{ fontSize: 18, marginTop: 16, marginBottom: 8 }}>Integrations</h2>
      {integrations.length === 0 ? (
        <div className="card sub">
          No integrations have synced yet. ClickUp ingest will start once <code>CLICKUP_API_TOKEN</code> is set in Supabase Edge Function secrets and the next cron tick fires.
        </div>
      ) : (
        integrations.map((i) => {
          const ago = i.last_sync_at ? minutesAgo(i.last_sync_at) : null;
          const stale = ago !== null && ago > 30;
          return (
            <div key={i.service} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <strong style={{ textTransform: 'capitalize' }}>{i.service}</strong>
                {!i.active && <span className="pill" style={{ marginLeft: 8, background: 'var(--ink-faint)' }}>inactive</span>}
              </div>
              <div className="sub" style={{ fontSize: 13, color: stale ? 'var(--rust)' : 'var(--ink-soft)' }}>
                {ago === null ? 'never synced' : `synced ${ago} min ago`}
              </div>
            </div>
          );
        })
      )}

      {/* ─── Open alerts ─────────────────────────────────────────── */}
      <h2 style={{ fontSize: 18, marginTop: 24, marginBottom: 8 }}>Open alerts ({alerts.length})</h2>
      {alerts.length === 0 ? (
        <div className="card sub">No open alerts. Once events ingest and the matcher runs, alerts will land here.</div>
      ) : (
        alerts.map((a) => (
          <div key={a.id} className="card">
            <span className={`pill ${a.severity}`}>{a.severity}</span>
            <h3 style={{ marginTop: 6, fontSize: 16 }}>{a.title}</h3>
            {a.body && <p className="sub" style={{ marginTop: 4 }}>{a.body}</p>}
            {Array.isArray(a.context_links) && a.context_links.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {a.context_links.map((cl, i) => (
                  <a key={i} href={cl.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, marginRight: 12, color: 'var(--rust)' }}>
                    {cl.label} →
                  </a>
                ))}
              </div>
            )}
          </div>
        ))
      )}

      {/* ─── Recent events ────────────────────────────────────────── */}
      <h2 style={{ fontSize: 18, marginTop: 24, marginBottom: 8 }}>Recent events ({events.length})</h2>
      {events.length === 0 ? (
        <div className="card sub">Nothing ingested yet.</div>
      ) : (
        events.map((e) => (
          <div key={e.id} className="card" style={{ padding: '10px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {e.subject || '(no subject)'}
                </div>
                <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>
                  {e.source} · {e.sender || 'no sender'} {e.status && <>· <em>{e.status}</em></>}
                </div>
              </div>
              <div className="sub" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                {minutesAgo(e.occurred_at)}m ago
              </div>
            </div>
          </div>
        ))
      )}

      {/* ─── Rules ────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: 18, marginTop: 24, marginBottom: 8 }}>Active rules ({rules.filter((r) => r.enabled).length})</h2>
      {rules.map((r) => (
        <div key={r.id} className="card" style={{ padding: '10px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
            <strong style={{ fontSize: 14 }}>{r.name}</strong>
            <span className={`pill ${r.actions?.severity || 'info'}`} style={{ fontSize: 10 }}>{r.actions?.severity}</span>
          </div>
          <p className="sub" style={{ marginTop: 4, fontSize: 12 }}>{r.description}</p>
        </div>
      ))}

      {/* ─── People summary ───────────────────────────────────────── */}
      <h2 style={{ fontSize: 18, marginTop: 24, marginBottom: 8 }}>People ({peopleTotal})</h2>
      <div className="card" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <span><strong style={{ color: 'var(--rust)' }}>{counts.critical ?? 0}</strong> critical</span>
        <span><strong>{counts.high ?? 0}</strong> high</span>
        <span><strong>{counts.normal ?? 0}</strong> normal</span>
        <span><strong>{counts.low ?? 0}</strong> low</span>
        <span><strong>{counts.noise ?? 0}</strong> noise</span>
      </div>
    </div>
  );
}

function minutesAgo(iso) {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}
