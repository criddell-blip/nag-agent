import { useEffect, useState } from 'react';
import {
  db,
  isConfigured,
  listOpenAlerts,
  listRules,
  listIntegrations,
  countPeopleByPriority,
  listUpcomingMeetings,
  listActiveTasks,
} from './lib/supabase.js';
import LoginScreen from './components/LoginScreen.jsx';

// ════════════════════════════════════════════════════════════════════
// Three-pane dashboard:
//   Left   — Calendar (next 14 days of meetings)
//   Center — Active work (ClickUp tasks grouped by list)
//   Right  — Open alerts (grouped by severity)
// Mobile: stacks single-column with alerts first.
// ════════════════════════════════════════════════════════════════════

const SEVERITY_ORDER = { critical: 0, warn: 1, info: 2 };

export default function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [rules, setRules] = useState([]);
  const [integrations, setIntegrations] = useState([]);
  const [peopleCounts, setPeopleCounts] = useState({});
  const [err, setErr] = useState(null);
  const [showSecondary, setShowSecondary] = useState(false);

  useEffect(() => {
    if (!isConfigured) { setAuthReady(true); return; }
    db.auth.getSession().then(({ data }) => {
      setSession(data.session); setAuthReady(true);
    });
    const { data: sub } = db.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    async function loadAll() {
      try {
        const [a, m, t, r, ints, pc] = await Promise.all([
          listOpenAlerts(),
          listUpcomingMeetings(14),
          listActiveTasks(),
          listRules(),
          listIntegrations(),
          countPeopleByPriority(),
        ]);
        if (cancelled) return;
        setAlerts(a); setMeetings(m); setTasks(t); setRules(r);
        setIntegrations(ints); setPeopleCounts(pc);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    }
    loadAll();
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
            <code>VITE_SUPABASE_ANON_KEY</code> isn't set.
          </p>
        </div>
      </div>
    );
  }

  if (!authReady) return null;
  if (!session) return <LoginScreen />;

  return (
    <div className="dashboard">
      <Header
        session={session}
        alerts={alerts}
        meetings={meetings}
        tasks={tasks}
        integrations={integrations}
        onSignOut={() => db.auth.signOut()}
      />
      {err && (
        <div className="card" style={{ borderColor: 'var(--rust)', color: 'var(--rust)', marginBottom: 12 }}>
          {err}
        </div>
      )}

      <div className="three-pane">
        <CalendarPane meetings={meetings} />
        <ActiveWorkPane tasks={tasks} />
        <AlertsPane alerts={alerts} />
      </div>

      <SecondaryPanels
        open={showSecondary}
        onToggle={() => setShowSecondary((v) => !v)}
        rules={rules}
        integrations={integrations}
        peopleCounts={peopleCounts}
      />
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────
function Header({ session, alerts, meetings, tasks, integrations, onSignOut }) {
  const open = alerts.length;
  const critical = alerts.filter((a) => a.severity === 'critical').length;
  const upcoming = meetings.length;
  const taskCount = tasks.length;
  const lastSync = integrations.length > 0
    ? integrations.reduce((max, i) => (i.last_sync_at && (!max || i.last_sync_at > max)) ? i.last_sync_at : max, null)
    : null;
  const syncAgo = lastSync ? minutesAgo(lastSync) : null;

  return (
    <header className="header">
      <div>
        <h1 className="h1" style={{ margin: 0 }}>Nag agent</h1>
        <p className="sub" style={{ marginTop: 2, fontSize: 12 }}>
          v0.3 ·{' '}
          {critical > 0 && <strong style={{ color: 'var(--rust)' }}>{critical} critical · </strong>}
          {open} open · {upcoming} mtgs · {taskCount} tasks
          {syncAgo !== null && <> · synced {syncAgo}m ago</>}
        </p>
      </div>
      <button
        onClick={onSignOut}
        className="btn-ghost"
        title={session.user.email}
      >
        Sign out
      </button>
    </header>
  );
}

// ─── Calendar pane ────────────────────────────────────────────────
function CalendarPane({ meetings }) {
  const groups = groupByDay(meetings, 'due_at');
  return (
    <section className="pane">
      <h2 className="pane-h">Calendar <span className="pane-count">{meetings.length}</span></h2>
      {meetings.length === 0 ? (
        <p className="sub">No meetings in the next 14 days.</p>
      ) : (
        Object.entries(groups).map(([dayLabel, items]) => (
          <div key={dayLabel} className="day-group">
            <div className="day-label">{dayLabel}</div>
            {items.map((m) => (
              <div key={m.id} className="meeting-row">
                <div className="meeting-time">{formatTime(m.due_at)}</div>
                <div className="meeting-body">
                  <div className="meeting-subject">{m.subject || '(no title)'}</div>
                  {m.sender && (
                    <div className="meeting-meta">{m.sender}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </section>
  );
}

// ─── Active work pane (ClickUp tasks) ─────────────────────────────
function ActiveWorkPane({ tasks }) {
  // Group tasks by ClickUp list name
  const byList = new Map();
  for (const t of tasks) {
    const list = t.raw_metadata?.list ?? '(unlisted)';
    if (!byList.has(list)) byList.set(list, []);
    byList.get(list).push(t);
  }
  // Sort lists by total count descending so busiest list is on top
  const sorted = [...byList.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <section className="pane">
      <h2 className="pane-h">Active work <span className="pane-count">{tasks.length}</span></h2>
      {tasks.length === 0 ? (
        <p className="sub">No ClickUp tasks ingested.</p>
      ) : (
        sorted.slice(0, 20).map(([listName, items]) => (
          <details key={listName} className="list-group" open={items.length <= 5}>
            <summary className="list-summary">
              <span>{listName}</span>
              <span className="list-count">{items.length}</span>
            </summary>
            <div className="list-body">
              {items.slice(0, 15).map((t) => {
                const overdue = t.due_at && new Date(t.due_at) < new Date();
                const appUrl = t.external_id ? `clickup://open?taskId=${t.external_id}` : null;
                return (
                  <div key={t.id} className="task-row" title={t.subject || ''}>
                    <div className="task-subject">{t.subject || '(no name)'}</div>
                    <div className="task-meta">
                      {appUrl && <a href={appUrl} className="task-link">app</a>}
                      {t.external_url && <a href={t.external_url} target="_blank" rel="noreferrer" className="task-link">web</a>}
                      {t.status && <span className="task-status">{t.status}</span>}
                      {t.due_at && (
                        <span className={overdue ? 'task-overdue' : 'task-due'}>
                          {formatRelativeDue(t.due_at)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              {items.length > 15 && (
                <div className="task-meta" style={{ paddingLeft: 6, marginTop: 4 }}>
                  +{items.length - 15} more
                </div>
              )}
            </div>
          </details>
        ))
      )}
    </section>
  );
}

// ─── Alerts pane ──────────────────────────────────────────────────
function AlertsPane({ alerts }) {
  const sorted = [...alerts].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
  const groups = { critical: [], warn: [], info: [] };
  for (const a of sorted) (groups[a.severity] ?? groups.info).push(a);

  return (
    <section className="pane">
      <h2 className="pane-h">Open alerts <span className="pane-count">{alerts.length}</span></h2>
      {alerts.length === 0 ? (
        <p className="sub">All clear — no open alerts.</p>
      ) : (
        ['critical', 'warn', 'info'].map((sev) => (
          groups[sev].length > 0 && (
            <div key={sev} className="severity-group">
              <div className={`severity-label severity-${sev}`}>
                {sev.toUpperCase()} · {groups[sev].length}
              </div>
              {groups[sev].slice(0, 25).map((a) => (
                <div key={a.id} className="alert-row">
                  <div className="alert-title">{a.title}</div>
                  {a.body && <div className="alert-body">{a.body.slice(0, 200)}</div>}
                  <div className="alert-meta">
                    {minutesAgo(a.created_at)}m ago
                    {Array.isArray(a.context_links) && a.context_links.map((cl, i) => (
                      <a key={i} href={cl.url} target="_blank" rel="noreferrer">{cl.label}</a>
                    ))}
                  </div>
                </div>
              ))}
              {groups[sev].length > 25 && (
                <div className="sub" style={{ fontSize: 11, padding: '4px 0' }}>
                  +{groups[sev].length - 25} more
                </div>
              )}
            </div>
          )
        ))
      )}
    </section>
  );
}

// ─── Secondary collapsible panels ─────────────────────────────────
function SecondaryPanels({ open, onToggle, rules, integrations, peopleCounts }) {
  const peopleTotal = Object.values(peopleCounts).reduce((s, n) => s + n, 0);
  return (
    <details className="secondary" open={open} onToggle={onToggle}>
      <summary className="secondary-summary">
        Settings & status · {rules.filter((r) => r.enabled).length} rules · {peopleTotal} people · {integrations.length} integrations
      </summary>
      <div className="secondary-body">
        <div className="secondary-row">
          <h3>Integrations</h3>
          {integrations.length === 0 ? (
            <p className="sub">No integrations have synced yet.</p>
          ) : (
            integrations.map((i) => (
              <div key={i.service} className="integ-row">
                <strong style={{ textTransform: 'capitalize' }}>{i.service}</strong>
                <span className="sub" style={{ fontSize: 12 }}>
                  {i.last_sync_at ? `${minutesAgo(i.last_sync_at)}m ago` : 'never synced'}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="secondary-row">
          <h3>Rules ({rules.filter((r) => r.enabled).length})</h3>
          {rules.map((r) => (
            <div key={r.id} className="rule-row">
              <span className={`rule-sev sev-${r.actions?.severity || 'info'}`}>{r.actions?.severity}</span>
              <span>{r.name}</span>
            </div>
          ))}
        </div>
        <div className="secondary-row">
          <h3>People ({peopleTotal})</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat label="critical" n={peopleCounts.critical ?? 0} color="var(--rust)" />
            <Stat label="high" n={peopleCounts.high ?? 0} />
            <Stat label="normal" n={peopleCounts.normal ?? 0} />
            <Stat label="low" n={peopleCounts.low ?? 0} />
            <Stat label="noise" n={peopleCounts.noise ?? 0} />
          </div>
        </div>
      </div>
    </details>
  );
}

function Stat({ label, n, color }) {
  return (
    <span style={{ fontSize: 13 }}>
      <strong style={{ color: color ?? 'inherit' }}>{n}</strong> <span className="sub">{label}</span>
    </span>
  );
}

// ─── helpers ──────────────────────────────────────────────────────
function minutesAgo(iso) {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Denver' });
}

function dayLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, tomorrow)) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Denver' });
}

function groupByDay(items, dateField) {
  const out = {};
  for (const item of items) {
    const label = dayLabel(item[dateField]);
    if (!out[label]) out[label] = [];
    out[label].push(item);
  }
  return out;
}

function formatRelativeDue(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.round(ms / 86400000);
  if (days < -1) return `${-days}d overdue`;
  if (days === -1) return '1d overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
