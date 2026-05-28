// slack-notify · triggered by inserts to alerts (or invoked by evaluate-rules
// after re-nag bumps). Formats Slack Block Kit message + posts as DM.
//
// TODO Phase 3:
//   - Read Slack bot token from integrations table (service='slack')
//   - Build Block Kit message: title, severity color, context_links, action buttons
//     (Ack · Snooze 1d / 3d / 1w · Dismiss · Mark done · Open in app)
//   - POST to chat.postMessage with Chris's user ID as channel
//   - Update alerts.last_notified_at on success

import { preflight, json } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  return json({ ok: true, function: 'slack-notify' });
});
