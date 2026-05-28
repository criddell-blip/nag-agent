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
    .select('id, severity, title, body, status, created_at, last_notified_at')
    .eq('status', 'open')
    .order('created_at', { ascending: false });
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
