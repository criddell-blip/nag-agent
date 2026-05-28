// ════════════════════════════════════════════════════════════════════
// slack-interactions v7 · receives button clicks from Slack.
//
// Why response_url instead of synchronous reply body:
// Slack's sync-response replacement is finicky (works for some payloads,
// silently no-ops for others). The response_url POST is the documented
// "always works" path. We do all DB work + the response_url POST
// in-line (it's ~1s total, well under Slack's 3s deadline) and reply
// with a simple ack at the end.
//
// Requires Edge Function secret: SLACK_SIGNING_SECRET
// Deployed with verify_jwt=false (Slack doesn't send a JWT).
// ════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-slack-signature, x-slack-request-timestamp',
};
function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  return null;
}

async function verifySlackSignature(
  body: string, timestamp: string, signature: string, signingSecret: string,
): Promise<boolean> {
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() / 1000 - tsNum) > 300) return false;  // 5-min replay window
  const base = `v0:${timestamp}:${body}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(base));
  const computed = 'v0=' + Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  if (computed.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

function actionToUpdate(actionId: string, nowIso: string) {
  switch (actionId) {
    case 'ack':
      return { status: 'acknowledged', snooze_duration_hours: null, snooze_until: null, closed_at: null, disposition: 'acknowledged', label: 'ACKED' };
    case 'snooze_1d':
      return { status: 'snoozed', snooze_duration_hours: 24, snooze_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), closed_at: null, disposition: 'snoozed', label: 'SNOOZED 1d' };
    case 'snooze_3d':
      return { status: 'snoozed', snooze_duration_hours: 72, snooze_until: new Date(Date.now() + 72 * 3600 * 1000).toISOString(), closed_at: null, disposition: 'snoozed', label: 'SNOOZED 3d' };
    case 'snooze_1w':
      return { status: 'snoozed', snooze_duration_hours: 168, snooze_until: new Date(Date.now() + 168 * 3600 * 1000).toISOString(), closed_at: null, disposition: 'snoozed', label: 'SNOOZED 1w' };
    case 'dismiss':
      return { status: 'dismissed', snooze_duration_hours: null, snooze_until: null, closed_at: nowIso, disposition: 'dismissed', label: 'DISMISSED' };
    case 'mark_done':
      return { status: 'done', snooze_duration_hours: null, snooze_until: null, closed_at: nowIso, disposition: 'marked_done', label: 'DONE' };
    default:
      return null;
  }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    if (req.method !== 'POST') {
      return new Response('method not allowed', { status: 405, headers: corsHeaders });
    }
    const signingSecret = Deno.env.get('SLACK_SIGNING_SECRET');
    if (!signingSecret) {
      return new Response('SLACK_SIGNING_SECRET missing', { status: 500, headers: corsHeaders });
    }
    const rawBody = await req.text();
    const sig = req.headers.get('x-slack-signature') ?? '';
    const ts = req.headers.get('x-slack-request-timestamp') ?? '';
    const valid = await verifySlackSignature(rawBody, ts, sig, signingSecret);
    if (!valid) {
      return new Response('invalid signature', { status: 401, headers: corsHeaders });
    }
    const form = new URLSearchParams(rawBody);
    const payloadStr = form.get('payload');
    if (!payloadStr) {
      return new Response('missing payload', { status: 400, headers: corsHeaders });
    }
    const payload = JSON.parse(payloadStr);
    const action = payload?.actions?.[0];
    if (!action) {
      return new Response('no action', { status: 400, headers: corsHeaders });
    }
    const alertId = action.value as string;
    const actionId = action.action_id as string;
    const responseUrl = payload.response_url as string;
    const nowIso = new Date().toISOString();
    const update = actionToUpdate(actionId, nowIso);
    if (!update) {
      return new Response(`unknown action_id: ${actionId}`, { status: 400, headers: corsHeaders });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { error: upErr } = await supabase.from('alerts').update({
      status: update.status, snooze_until: update.snooze_until, closed_at: update.closed_at,
    }).eq('id', alertId);
    if (upErr) console.error('alert update:', upErr.message);
    await supabase.from('alert_dispositions').insert({
      alert_id: alertId, action: update.disposition,
      snooze_duration_hours: update.snooze_duration_hours,
    });

    const { data: alert } = await supabase
      .from('alerts').select('title, body, context_links')
      .eq('id', alertId).maybeSingle();

    const title = alert?.title ?? 'alert';
    const body = alert?.body as string | undefined;
    const links = (alert?.context_links ?? []) as Array<{ label: string; url: string }>;
    const stamp = new Date().toLocaleString('en-US', {
      timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit', hour12: true,
    });

    // Top-level blocks (no attachments wrapper) for the replacement.
    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `:white_check_mark: ${update.label}`, emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${title}*` },
      },
    ];
    if (body) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: body.slice(0, 2900) } });
    }
    const contextElements: any[] = [{ type: 'mrkdwn', text: `_${update.label} at ${stamp} MT_` }];
    for (const l of links.slice(0, 2)) {
      contextElements.push({ type: 'mrkdwn', text: `<${l.url}|${l.label}>` });
    }
    blocks.push({ type: 'context', elements: contextElements });

    // POST the replacement to Slack's response_url (the reliable path).
    let replaced = false;
    let replaceErr: string | null = null;
    try {
      const resp = await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          replace_original: true,
          text: `${update.label}: ${title}`,
          blocks,
        }),
      });
      replaced = resp.ok;
      if (!resp.ok) replaceErr = `status ${resp.status}: ${await resp.text()}`;
    } catch (e) {
      replaceErr = e instanceof Error ? e.message : String(e);
    }
    if (replaceErr) console.error('response_url POST:', replaceErr);

    return new Response(JSON.stringify({ ok: true, replaced, replaceErr }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('slack-interactions error:', msg);
    return new Response(`error: ${msg}`, { status: 500, headers: corsHeaders });
  }
});
