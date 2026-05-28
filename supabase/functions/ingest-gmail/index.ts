// ingest-gmail · Scheduled Function, every 15 min.
// Fetches new mail via Gmail history.list (incremental, not full scan).
// Normalizes into public.events.
//
// TODO Phase 1:
//   - Read OAuth refresh token from integrations table (service='gmail')
//   - Exchange for access token
//   - Call gmail.users.history.list with stored sync_cursor (historyId)
//   - For each new message: parse headers, build event row, upsert by (source, external_id)
//   - Update integrations.sync_cursor + last_sync_at

import { preflight, json } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  // skeleton: just acknowledge it ran
  return json({ ok: true, function: 'ingest-gmail', ingested: 0 });
});
