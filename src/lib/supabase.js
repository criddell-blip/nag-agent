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
    .select('id, severity, title, body, status, created_at, last_notified_at, context_links')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(100);
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
