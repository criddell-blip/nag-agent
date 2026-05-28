import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://dcmltuyyrmodaqhuudyd.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_ANON_KEY) {
  // Fail loudly during dev so we never silently start with no auth client.
  console.error('VITE_SUPABASE_ANON_KEY is missing. Copy .env.example to .env and fill it in.');
}

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY ?? '');

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
