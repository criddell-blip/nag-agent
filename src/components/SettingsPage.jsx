import { useEffect, useState } from 'react';
import {
  getAppSetting,
  setAppSetting,
  listDiscoveredFolders,
  triggerIngest,
} from '../lib/supabase.js';

// ════════════════════════════════════════════════════════════════════
// SettingsPage · folder allowlist + calendar URL editor
// Reads/writes app_settings. Triggers manual ingest runs.
// ════════════════════════════════════════════════════════════════════

export default function SettingsPage({ onBack }) {
  return (
    <div className="dashboard">
      <header className="masthead">
        <div className="doc-meta">
          <span><span className="doc-id">DOC.SETTINGS</span> · NAG AGENT</span>
          <button onClick={onBack} className="btn-ghost">← Dashboard</button>
        </div>
        <h1 className="title">Settings <em>&amp; Config</em></h1>
        <p className="subtitle">Manage which ClickUp folders and which calendars feed the nag pipeline. Changes apply on the next ingest tick (or hit "Trigger now").</p>
      </header>

      <ClickUpFoldersSection />
      <CalendarsSection />
      <DangerSection />
    </div>
  );
}

// ─── ClickUp folder allowlist ─────────────────────────────────────
function ClickUpFoldersSection() {
  const [discovered, setDiscovered] = useState([]);
  const [allowed, setAllowed] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [triggering, setTriggering] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const folders = await listDiscoveredFolders();
        setDiscovered(folders);
        const setting = await getAppSetting('clickup.include_folders');
        const list = Array.isArray(setting?.value) ? setting.value : [];
        setAllowed(list);
      } catch (e) { setMsg({ kind: 'err', text: e.message }); }
    })();
  }, []);

  function toggle(name) {
    setAllowed((prev) => prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]);
    setDirty(true);
    setMsg(null);
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      await setAppSetting('clickup.include_folders', allowed);
      setDirty(false);
      setMsg({ kind: 'ok', text: `Saved ${allowed.length} folders. Active on next ingest tick.` });
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
    setSaving(false);
  }

  async function ingestNow() {
    setTriggering(true);
    setMsg(null);
    try {
      const data = await triggerIngest('ingest-clickup');
      setMsg({
        kind: 'ok',
        text: `Ingest fired: ${data.ingested} active tasks · ${data.reconciled?.events_marked_inactive ?? 0} marked inactive · ${data.reconciled?.alerts_auto_closed ?? 0} alerts auto-closed (${data.took_ms}ms)`,
      });
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
    setTriggering(false);
  }

  return (
    <section className="section">
      <div className="section-head">
        <span className="section-num">§ 01</span>
        <h2 className="section-title">ClickUp folder allowlist</h2>
        <span className="section-sub">{allowed.length} selected / {discovered.length} total</span>
      </div>
      <p className="sub" style={{ marginBottom: 12, fontSize: 13 }}>
        Tasks only flow into the pipeline if they're in one of these folders. Unchecking removes future tasks
        in that folder; the reconciler auto-closes their existing alerts on the next ingest.
      </p>

      <div className="folder-grid">
        {discovered.map((f) => (
          <label key={f.name} className={`folder-tile ${allowed.includes(f.name) ? 'on' : 'off'}`}>
            <input type="checkbox" checked={allowed.includes(f.name)} onChange={() => toggle(f.name)} />
            <span className="folder-name">{f.name}</span>
            <span className="folder-count">{f.count}</span>
          </label>
        ))}
      </div>

      <div className="action-row">
        <button onClick={save} disabled={!dirty || saving} className="btn-primary">
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
        </button>
        <button onClick={ingestNow} disabled={triggering} className="btn-ghost">
          {triggering ? 'Ingesting…' : 'Trigger ingest now'}
        </button>
        {msg && <span className={`msg msg-${msg.kind}`}>{msg.text}</span>}
      </div>
    </section>
  );
}

// ─── Calendar URLs ────────────────────────────────────────────────
function CalendarsSection() {
  const [items, setItems] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [triggering, setTriggering] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const setting = await getAppSetting('calendar.ical_urls');
        const list = Array.isArray(setting?.value) ? setting.value : [];
        // Normalize: items can be string or {label, url}
        setItems(list.map((it) => typeof it === 'string' ? { label: '', url: it } : { label: it.label ?? '', url: it.url ?? '' }));
      } catch (e) { setMsg({ kind: 'err', text: e.message }); }
    })();
  }, []);

  function updateItem(i, patch) {
    setItems((prev) => prev.map((it, idx) => idx === i ? { ...it, ...patch } : it));
    setDirty(true);
    setMsg(null);
  }
  function removeItem(i) {
    setItems((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
    setMsg(null);
  }
  function addBlank() {
    setItems((prev) => [...prev, { label: '', url: '' }]);
    setDirty(true);
    setMsg(null);
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const cleaned = items.filter((it) => it.url.trim()).map((it) => ({
        label: it.label.trim() || null,
        url: it.url.trim(),
      }));
      await setAppSetting('calendar.ical_urls', cleaned);
      setDirty(false);
      setMsg({ kind: 'ok', text: `Saved ${cleaned.length} calendars. Active on next ingest tick.` });
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
    setSaving(false);
  }

  async function ingestNow() {
    setTriggering(true);
    setMsg(null);
    try {
      const data = await triggerIngest('ingest-gcal');
      setMsg({
        kind: 'ok',
        text: `Ingest fired: ${data.ingested} events from ${data.calendars?.length ?? 0} calendars (source: ${data.calendar_source}, ${data.took_ms}ms)`,
      });
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
    setTriggering(false);
  }

  return (
    <section className="section">
      <div className="section-head">
        <span className="section-num">§ 02</span>
        <h2 className="section-title">Calendar feeds</h2>
        <span className="section-sub">{items.length} configured</span>
      </div>
      <p className="sub" style={{ marginBottom: 12, fontSize: 13 }}>
        Each row is a Google Calendar "Secret iCal address" URL. Add one per calendar you want pulled
        (primary, shared, family, etc.). Empty list falls back to the <code>GOOGLE_CALENDAR_ICAL_URL</code> env var.
      </p>

      {items.length === 0 && (
        <p className="sub" style={{ fontStyle: 'italic', marginBottom: 12 }}>
          No calendars configured here yet — currently using env-var fallback. Add one below to migrate.
        </p>
      )}

      {items.map((it, i) => (
        <div key={i} className="cal-row">
          <input
            type="text"
            placeholder="Label (e.g. UBB primary)"
            value={it.label}
            onChange={(e) => updateItem(i, { label: e.target.value })}
            className="input-label"
          />
          <input
            type="url"
            placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"
            value={it.url}
            onChange={(e) => updateItem(i, { url: e.target.value })}
            className="input-url"
          />
          <button onClick={() => removeItem(i)} className="btn-remove" title="Remove">×</button>
        </div>
      ))}

      <button onClick={addBlank} className="btn-add">+ Add calendar</button>

      <div className="action-row">
        <button onClick={save} disabled={!dirty || saving} className="btn-primary">
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
        </button>
        <button onClick={ingestNow} disabled={triggering} className="btn-ghost">
          {triggering ? 'Ingesting…' : 'Trigger ingest now'}
        </button>
        {msg && <span className={`msg msg-${msg.kind}`}>{msg.text}</span>}
      </div>
    </section>
  );
}

// ─── Danger / utility ─────────────────────────────────────────────
function DangerSection() {
  return (
    <section className="section">
      <div className="section-head">
        <span className="section-num">§ 03</span>
        <h2 className="section-title">Status</h2>
      </div>
      <p className="sub" style={{ fontSize: 13 }}>
        Slack bot token, ClickUp API token, Google OAuth (if added later), and Supabase keys all live
        in Supabase Edge Function Secrets — manage those at the Supabase dashboard, not here.
        This page is only for non-secret config you change often.
      </p>
    </section>
  );
}
