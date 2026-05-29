import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://dcmltuyyrmodaqhuudyd.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(SUPABASE_ANON_KEY);

// When the key isn't set, expose a stub that throws on use. Lets App.jsx
// render a friendly "you need to set up .env" screen instead of dying at
// module load with "supabaseKey is required".
export const db = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : new Proxy({}, {
      get() {
        throw new Error('VITE_SUPABASE_ANON_KEY is missing. Copy .env.example to .env, paste the anon key from Supabase dashboard, and restart `npm run dev`.');
      },
    });

// ─── helpers ────────────────────────────────────────────────────────
export async function listOpenAlerts() {
  const { data, error } = await db
    .from('alerts')
    .select('id, severity, title, body, status, created_at, last_notified_at, context_links, rules(name)')
    .eq('status', 'open')
    .order('severity', { ascending: true })  // critical < info alphabetically; we re-sort in JS
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

export async function listUpcomingMeetings(daysAhead = 14) {
  // Start from local midnight today (so events earlier today still show).
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const future = new Date(startOfToday.getTime() + (daysAhead + 1) * 86400000);
  const { data, error } = await db
    .from('events')
    .select('id, subject, sender, due_at, body_excerpt, raw_metadata')
    .eq('source', 'gcal')
    .gte('due_at', startOfToday.toISOString())
    .lte('due_at', future.toISOString())
    .order('due_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

export async function listActiveTasks() {
  const { data, error } = await db
    .from('events')
    .select('id, external_id, subject, sender, due_at, status, external_url, raw_metadata')
    .eq('source', 'clickup')
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(300);
  if (error) throw error;
  return data ?? [];
}

export async function listRules() {
  const { data, error } = await db
    .from('rules')
    .select('id, name, description, enabled, conditions, actions')
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

export async function listRecentEvents(limit = 25) {
  const { data, error } = await db
    .from('events')
    .select('id, source, subject, sender, occurred_at, status, external_url')
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function listIntegrations() {
  const { data, error } = await db
    .from('integrations')
    .select('service, last_sync_at, sync_cursor, active')
    .order('service');
  if (error) throw error;
  return data ?? [];
}

export async function countPeopleByPriority() {
  const { data, error } = await db
    .from('people')
    .select('priority_tier');
  if (error) throw error;
  const counts = { critical: 0, high: 0, normal: 0, low: 0, noise: 0 };
  for (const p of data ?? []) counts[p.priority_tier] = (counts[p.priority_tier] ?? 0) + 1;
  return counts;
}

// ─── app_settings helpers ──────────────────────────────────────────
export async function getAppSetting(key) {
  const { data, error } = await db
    .from('app_settings').select('value, updated_at').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function setAppSetting(key, value) {
  const { data: existing } = await db.from('app_settings').select('id').eq('key', key).maybeSingle();
  const row = { key, value, updated_at: new Date().toISOString() };
  if (existing) {
    const { error } = await db.from('app_settings').update(row).eq('id', existing.id);
    if (error) throw error;
  } else {
    const { error } = await db.from('app_settings').insert(row);
    if (error) throw error;
  }
}

export async function listDiscoveredFolders() {
  const { data, error } = await db
    .from('events')
    .select('raw_metadata')
    .eq('source', 'clickup')
    .not('raw_metadata->>folder', 'is', null);
  if (error) throw error;
  const counts = new Map();
  for (const e of data ?? []) {
    const f = e.raw_metadata?.folder;
    if (!f) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

// Returns: [{ folder, totalTasks, lists: [{ name, count }] }]
// Filters to ACTIVE events only — deleted/closed/filtered-out tasks won't
// surface stale folders or lists in the UI. (Reconciler marks them inactive.)
export async function listFoldersWithLists() {
  const { data, error } = await db
    .from('events')
    .select('raw_metadata')
    .eq('source', 'clickup')
    .neq('status', 'inactive')
    .not('raw_metadata->>folder', 'is', null);
  if (error) throw error;
  const folderMap = new Map();  // folder → Map<list, count>
  for (const e of data ?? []) {
    const f = e.raw_metadata?.folder;
    const l = e.raw_metadata?.list ?? '(no list)';
    if (!f) continue;
    if (!folderMap.has(f)) folderMap.set(f, new Map());
    const lm = folderMap.get(f);
    lm.set(l, (lm.get(l) ?? 0) + 1);
  }
  return [...folderMap.entries()]
    .map(([folder, lm]) => ({
      folder,
      totalTasks: [...lm.values()].reduce((s, n) => s + n, 0),
      lists: [...lm.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.totalTasks - a.totalTasks);
}

export async function triggerIngest(functionName) {
  const { data, error } = await db.functions.invoke(functionName);
  if (error) throw error;
  return data;
}
