// evaluate-rules · runs after each ingest (also scheduled, every 15 min).
// Selects enabled rules, matches against recent events, generates alerts.
// Idempotent: dedup by (rule_id, event_id) — never generate the same alert twice.
//
// TODO Phase 2:
//   - SELECT rules WHERE enabled = true
//   - SELECT events WHERE ingested_at > now() - interval '1 hour'
//     (or anything matching rule conditions that doesn't already have an alert)
//   - For each match: INSERT INTO alerts (rule_id, event_id, severity, title, ...)
//   - Skip insert if (rule_id, event_id) pair already exists
//   - For "re_nag: daily" alerts with status='open' and last_notified_at < today: bump last_notified_at, trigger Slack

import { preflight, json } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  return json({ ok: true, function: 'evaluate-rules', alerts_generated: 0 });
});
