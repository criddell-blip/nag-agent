// ingest-gcal · Scheduled Function, every 15 min.
// Fetches calendar events for the next 14 days.
// Normalizes into public.events.
//
// TODO Phase 1:
//   - Reuse Gmail's OAuth credentials (same Google OAuth client)
//   - Call calendar.events.list with syncToken (incremental)
//   - For each event: build event row, upsert by (source, external_id)
//   - Update integrations.sync_cursor + last_sync_at

import { preflight, json } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  return json({ ok: true, function: 'ingest-gcal', ingested: 0 });
});
