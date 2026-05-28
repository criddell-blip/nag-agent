// slack-interactions · receives Slack button clicks (POST from Slack to this URL).
// Updates alert status + logs disposition.
//
// TODO Phase 3:
//   - Verify Slack signing secret (X-Slack-Signature header)
//   - Parse payload (form-urlencoded with 'payload' field containing JSON)
//   - Switch on action_id: ack | snooze_1d | snooze_3d | snooze_1w | dismiss | mark_done
//   - UPDATE alerts SET status=..., snooze_until=..., closed_at=...
//   - INSERT INTO alert_dispositions for the audit trail
//   - Respond with response_action to update the original Slack message

import { preflight, json } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  return json({ ok: true, function: 'slack-interactions' });
});
