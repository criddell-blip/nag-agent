// ingest-clickup · Scheduled Function, every 15 min.
// Fetches updated tasks since last sync.
// Normalizes into public.events.
//
// TODO Phase 1:
//   - Read API token from integrations table (service='clickup')
//   - GET /team/{team_id}/task?date_updated_gt=<sync_cursor>
//   - For each task: build event row, upsert by (source, external_id)
//   - Update integrations.sync_cursor (last date_updated seen) + last_sync_at

import { preflight, json } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  return json({ ok: true, function: 'ingest-clickup', ingested: 0 });
});
