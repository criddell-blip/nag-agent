// ════════════════════════════════════════════════════════════════════
// slack-notify · Scheduled every 5 min via pg_cron.
//
// Owns Slack notification + re-nag policy.
//   - Alert with last_notified_at = NULL → first DM
//   - Alert with re_nag='hourly' and last_notified_at < now - 1h → re-DM
//   - Alert with re_nag='daily' and last_notified_at < today's 06:00 MT → re-DM
//   - Alert with re_nag='none' → only first DM, never re-nag
//
// Quiet hours 22:00–06:00 MT: skip the run entirely. The 06:00 tick
// catches everything that piled up overnight.
//
// Discovers Chris's Slack user_id by email (criddell@utahbroadband.com)
// via users.list, caches it in integrations.encrypted_credentials.
//
// Requires Edge Function secret: SLACK_BOT_TOKEN
// ════════════════════════════════════════════════════════════════════

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SLACK_API = 'https://slack.com/api';
const USER_EMAIL = 'criddell@utahbroadband.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  return null;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ─── quiet hours: 22:00 – 06:00 Mountain Time ─────────────────────
function inQuietHours(): boolean {
  const mtHour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', hour12: false })
      .format(new Date()),
  );
  return mtHour >= 22 || mtHour < 6;
}

// ─── Slack API ─────────────────────────────────────────────────────
async function slackPost(path: string, token: string, body: unknown): Promise<any> {
  const res = await fetch(`${SLACK_API}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${path}: ${data.error}`);
  return data;
}
async function slackGet(path: string, token: string, params: Record<string, string> = {}): Promise<any> {
  const url = `${SLACK_API}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${path}: ${data.error}`);
  return data;
}
async function findUserIdByEmail(token: string, email: string): Promise<string | null> {
  let cursor: string | undefined;
  for (let g = 0; g < 10; g++) {
    const params: Record<string, string> = { limit: '200' };
    if (cursor) params.cursor = cursor;
    const data = await slackGet('users.list', token, params);
    for (const m of (data?.members ?? [])) {
      if ((m?.profile?.email ?? '').toLowerCase() === email.toLowerCase()) return m.id as string;
    }
    cursor = data?.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return null;
}

async function getUserId(supabase: SupabaseClient, token: string): Promise<string> {
  const { data: integration } = await supabase
    .from('integrations').select('encrypted_credentials').eq('service', 'slack').maybeSingle();
  try {
    if (integration?.encrypted_credentials) {
      const parsed = JSON.parse(integration.encrypted_credentials);
      if (parsed?.user_id) return parsed.user_id;
    }
  } catch { /* fall through */ }

  const userId = await findUserIdByEmail(token, USER_EMAIL);
  if (!userId) throw new Error(`No Slack user found for email ${USER_EMAIL}`);

  await supabase.from('integrations').upsert(
    {
      service: 'slack',
      encrypted_credentials: JSON.stringify({ user_id: userId }),
      last_sync_at: new Date().toISOString(),
      active: true,
    },
    { onConflict: 'service' },
  );
  return userId;
}

// ─── Block Kit message ─────────────────────────────────────────────
const SEVERITY_EMOJI: Record<string, string> = {
  critical: ':rotating_light:',
  warn: ':warning:',
  info: ':information_source:',
};
const SEVERITY_COLOR: Record<string, string> = {
  critical: '#c45b2e',
  warn: '#b08c2a',
  info: '#5a7340',
};

function buildAttachments(alert: any, isRenag: boolean): unknown {
  const emoji = SEVERITY_EMOJI[alert.severity] ?? ':bell:';
  const color = SEVERITY_COLOR[alert.severity] ?? '#1a2332';
  const links = (alert.context_links ?? []) as Array<{ label: string; url: string }>;
  const prefix = isRenag ? '[re-nag] ' : '';

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} ${prefix}${alert.title}`.slice(0, 150), emoji: true },
    },
  ];
  if (alert.body) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: alert.body.slice(0, 2900) } });
  }
  if (links.length > 0) {
    blocks.push({
      type: 'context',
      elements: links.slice(0, 3).map((l) => ({ type: 'mrkdwn', text: `<${l.url}|${l.label}>` })),
    });
  }
  blocks.push({
    type: 'actions',
    block_id: `alert_${alert.id}`,
    elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Ack' }, value: alert.id, action_id: 'ack' },
      { type: 'button', text: { type: 'plain_text', text: 'Snooze 1d' }, value: alert.id, action_id: 'snooze_1d' },
      { type: 'button', text: { type: 'plain_text', text: 'Snooze 3d' }, value: alert.id, action_id: 'snooze_3d' },
      { type: 'button', text: { type: 'plain_text', text: 'Dismiss' }, value: alert.id, action_id: 'dismiss' },
      { type: 'button', text: { type: 'plain_text', text: 'Done' }, value: alert.id, action_id: 'mark_done', style: 'primary' },
    ],
  });
  return [{ color, blocks }];
}

// ─── re-nag decision ───────────────────────────────────────────────
function shouldNotify(alert: any, reNag: string | undefined): { send: boolean; isRenag: boolean } {
  if (!alert.last_notified_at) return { send: true, isRenag: false };
  if (!reNag || reNag === 'none') return { send: false, isRenag: false };

  const lastMs = new Date(alert.last_notified_at).getTime();
  const nowMs = Date.now();

  if (reNag === 'hourly') {
    return { send: nowMs - lastMs >= 60 * 60 * 1000, isRenag: true };
  }
  if (reNag === 'daily') {
    // Daily anchor: 06:00 America/Denver on the current day in MT.
    // If last_notified_at < that anchor, fire.
    const now = new Date();
    const dateInMT = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);  // 'YYYY-MM-DD'
    // Construct 06:00 MT for that date as UTC. America/Denver = UTC-7 (MDT) or -6 (MST).
    // Use Date with an explicit ISO that includes the zone offset.
    const offsetMin = new Date().toLocaleString('en-US', { timeZone: 'America/Denver', timeZoneName: 'short' })
      .includes('MDT') ? -6 * 60 : -7 * 60;
    const anchor = new Date(`${dateInMT}T06:00:00`).getTime() - offsetMin * 60 * 1000;
    return { send: lastMs < anchor && nowMs >= anchor, isRenag: true };
  }
  return { send: false, isRenag: false };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const t0 = Date.now();
  try {
    const botToken = Deno.env.get('SLACK_BOT_TOKEN');
    if (!botToken) return json({ ok: false, error: 'SLACK_BOT_TOKEN missing.' }, 500);

    if (inQuietHours()) {
      return json({ ok: true, skipped: 'quiet_hours', took_ms: Date.now() - t0 });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const userId = await getUserId(supabase, botToken);

    // Pull open alerts + their rules so we know each one's re_nag policy.
    const { data: alerts, error: aErr } = await supabase
      .from('alerts')
      .select('id, severity, title, body, context_links, status, created_at, last_notified_at, rule_id, rules(actions)')
      .eq('status', 'open')
      .order('created_at', { ascending: true });
    if (aErr) throw new Error(`load alerts: ${aErr.message}`);

    // Per-run cap — avoid spamming Chris if there's a huge backlog
    // (e.g. first run with 35 past-due tasks). Cron runs every 5 min,
    // so 10/run = 120/hr ceiling.
    const MAX_PER_RUN = 10;

    const results: any[] = [];
    for (const alert of alerts ?? []) {
      if (results.filter((r) => r.sent).length >= MAX_PER_RUN) break;
      const rule = Array.isArray((alert as any).rules) ? (alert as any).rules[0] : (alert as any).rules;
      const reNag: string | undefined = rule?.actions?.re_nag;
      const decision = shouldNotify(alert, reNag);
      if (!decision.send) continue;

      try {
        const data = await slackPost('chat.postMessage', botToken, {
          channel: userId,
          text: `[${alert.severity}] ${alert.title}`,
          attachments: buildAttachments(alert, decision.isRenag),
        });
        await supabase
          .from('alerts')
          .update({ last_notified_at: new Date().toISOString() })
          .eq('id', alert.id);
        results.push({ alert_id: alert.id, sent: true, is_renag: decision.isRenag, slack_ts: data.ts });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ alert_id: alert.id, sent: false, error: msg });
      }

      // Be polite to Slack — small pause between messages to avoid rate limits.
      if ((results.length % 5) === 0) await new Promise((r) => setTimeout(r, 250));
    }

    return json({
      ok: true, function: 'slack-notify',
      user_id: userId,
      candidates: alerts?.length ?? 0,
      sent: results.filter((r) => r.sent).length,
      failed: results.filter((r) => !r.sent).length,
      results: results.slice(0, 10),  // cap response size
      took_ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('slack-notify error:', msg);
    return json({ ok: false, error: msg, took_ms: Date.now() - t0 }, 500);
  }
});
