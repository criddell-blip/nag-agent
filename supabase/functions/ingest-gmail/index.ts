// ════════════════════════════════════════════════════════════════════
// ingest-gmail · pulls recent Gmail messages into public.events.
//
// First run: fetches messages from the last 7 days (q=newer_than:7d).
// Subsequent runs: incremental via users.history.list since the
// stored historyId (sync_cursor).
//
// Uses metadata format only — no full body fetch. event.body_excerpt
// is populated from Gmail's snippet (first ~200 chars). This covers
// every rule except the body_regex phase-mention rule, which we can
// upgrade later.
//
// Requires Edge Function secrets:
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REFRESH_TOKEN
// ════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

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

// ─── OAuth ─────────────────────────────────────────────────────────
async function refreshAccessToken(
  clientId: string, clientSecret: string, refreshToken: string,
): Promise<string> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OAuth refresh ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth refresh: no access_token in response');
  return data.access_token as string;
}

// ─── Gmail API ─────────────────────────────────────────────────────
async function gmailGet(path: string, accessToken: string, params: Record<string, string> = {}): Promise<any> {
  const url = `${GMAIL_API}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gmail ${path} -> ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// ─── message parsing ───────────────────────────────────────────────
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    parts?: Array<{ filename?: string; mimeType?: string; parts?: any[] }>;
  };
  historyId?: string;
}

function getHeader(headers: Array<{ name: string; value: string }> | undefined, name: string): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return null;
}

// "Display Name <email@domain.com>" → "email@domain.com"
function parseEmailAddress(s: string | null): string | null {
  if (!s) return null;
  const m = s.match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase().trim();
  const trimmed = s.trim().toLowerCase();
  return trimmed.includes('@') ? trimmed : null;
}

function hasAnyAttachment(payload: GmailMessage['payload']): boolean {
  if (!payload?.parts) return false;
  // Recursive: attachments can be nested in multipart/alternative > parts.
  function walk(parts: any[]): boolean {
    for (const p of parts) {
      if (p.filename && p.filename.length > 0) return true;
      if (p.parts && walk(p.parts)) return true;
    }
    return false;
  }
  return walk(payload.parts);
}

function messageToEvent(msg: GmailMessage): Record<string, unknown> {
  const headers = msg.payload?.headers;
  const subject = getHeader(headers, 'Subject');
  const from = getHeader(headers, 'From');
  const to = getHeader(headers, 'To');
  const cc = getHeader(headers, 'Cc');
  const dateHeader = getHeader(headers, 'Date');

  const sender = parseEmailAddress(from);
  const participants: string[] = [];
  for (const list of [to, cc]) {
    if (!list) continue;
    for (const piece of list.split(',')) {
      const e = parseEmailAddress(piece);
      if (e) participants.push(e);
    }
  }

  const isUnread = (msg.labelIds ?? []).includes('UNREAD');
  const occurredAt = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : (dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString());

  return {
    source: 'gmail',
    external_id: msg.id,
    external_url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
    event_type: 'email',
    subject: subject?.slice(0, 500) ?? null,
    body_excerpt: (msg.snippet ?? '').slice(0, 800),
    sender,
    participants,
    occurred_at: occurredAt,
    status: isUnread ? 'unread' : 'read',
    raw_metadata: {
      thread_id: msg.threadId,
      label_ids: msg.labelIds,
      has_attachments: hasAnyAttachment(msg.payload),
      from_header: from,
      to_header: to,
    },
  };
}

// ─── fetch strategy ────────────────────────────────────────────────
async function fetchInitial(accessToken: string, days: number): Promise<{ ids: string[]; historyId: string | null }> {
  // Initial: messages.list with q=newer_than:Nd, paginated.
  const ids: string[] = [];
  let pageToken: string | undefined;
  let historyId: string | null = null;

  for (let g = 0; g < 10; g++) {  // cap at ~5000 messages
    const params: Record<string, string> = {
      q: `newer_than:${days}d`,
      maxResults: '500',
    };
    if (pageToken) params.pageToken = pageToken;
    const data = await gmailGet('/users/me/messages', accessToken, params);
    for (const m of (data?.messages ?? [])) ids.push(m.id);
    if (!historyId && data?.messages?.[0]?.id) {
      // The first message's metadata.get gives us a historyId for the cursor.
      // (messages.list itself doesn't return historyId at the top level.)
      // We'll set historyId after fetching the first message details below.
    }
    pageToken = data?.nextPageToken;
    if (!pageToken) break;
  }
  return { ids, historyId };
}

async function fetchIncremental(accessToken: string, startHistoryId: string): Promise<{ ids: string[]; nextHistoryId: string | null }> {
  // history.list returns messages added/modified since startHistoryId.
  const ids: string[] = [];
  let pageToken: string | undefined;
  let nextHistoryId: string | null = null;

  for (let g = 0; g < 10; g++) {
    const params: Record<string, string> = {
      startHistoryId,
      historyTypes: 'messageAdded',
      maxResults: '500',
    };
    if (pageToken) params.pageToken = pageToken;
    const data = await gmailGet('/users/me/history', accessToken, params);
    nextHistoryId = data?.historyId ?? nextHistoryId;
    for (const h of (data?.history ?? [])) {
      for (const m of (h?.messagesAdded ?? [])) {
        if (m?.message?.id) ids.push(m.message.id);
      }
    }
    pageToken = data?.nextPageToken;
    if (!pageToken) break;
  }
  return { ids, nextHistoryId };
}

async function fetchMessageDetails(accessToken: string, id: string): Promise<GmailMessage> {
  return await gmailGet(`/users/me/messages/${id}`, accessToken, {
    format: 'metadata',
    metadataHeaders: 'From,To,Cc,Subject,Date',
  });
}

// ─── main ──────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const t0 = Date.now();
  try {
    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    const refreshToken = Deno.env.get('GOOGLE_OAUTH_REFRESH_TOKEN');
    if (!clientId || !clientSecret || !refreshToken) {
      return json({
        ok: false,
        error: 'Missing one of GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN.',
      }, 500);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: integration } = await supabase
      .from('integrations')
      .select('sync_cursor, last_sync_at')
      .eq('service', 'gmail')
      .maybeSingle();

    const accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken);

    let ids: string[] = [];
    let nextHistoryId: string | null = integration?.sync_cursor ?? null;

    if (integration?.sync_cursor) {
      const inc = await fetchIncremental(accessToken, integration.sync_cursor);
      ids = inc.ids;
      if (inc.nextHistoryId) nextHistoryId = inc.nextHistoryId;
    } else {
      const init = await fetchInitial(accessToken, 7);
      ids = init.ids;
      // Pull the first message's details to seed historyId.
      if (ids.length > 0) {
        const first = await fetchMessageDetails(accessToken, ids[0]);
        if (first?.historyId) nextHistoryId = first.historyId;
      }
    }

    // Dedup ids (history can mention the same message multiple times).
    const uniq = Array.from(new Set(ids));

    // Fetch details + upsert. Cap at 200 per run to be polite.
    const MAX_PER_RUN = 200;
    const slice = uniq.slice(0, MAX_PER_RUN);
    const events: Record<string, unknown>[] = [];
    for (const id of slice) {
      try {
        const msg = await fetchMessageDetails(accessToken, id);
        events.push(messageToEvent(msg));
        // Track the highest historyId we see for the cursor.
        if (msg?.historyId) {
          if (!nextHistoryId || Number(msg.historyId) > Number(nextHistoryId)) {
            nextHistoryId = msg.historyId;
          }
        }
      } catch (e) {
        console.error(`message ${id}:`, e instanceof Error ? e.message : String(e));
      }
    }

    let ingested = 0;
    if (events.length > 0) {
      // Chunk upserts for request-size safety.
      for (let i = 0; i < events.length; i += 100) {
        const chunk = events.slice(i, i + 100);
        const { error: upErr } = await supabase
          .from('events')
          .upsert(chunk, { onConflict: 'source,external_id' });
        if (upErr) {
          console.error(`upsert chunk ${i}: ${upErr.message}`);
          continue;
        }
        ingested += chunk.length;
      }
    }

    await supabase.from('integrations').upsert(
      {
        service: 'gmail',
        sync_cursor: nextHistoryId,
        last_sync_at: new Date().toISOString(),
        active: true,
      },
      { onConflict: 'service' },
    );

    return json({
      ok: true, function: 'ingest-gmail',
      mode: integration?.sync_cursor ? 'incremental' : 'initial',
      message_ids_seen: uniq.length,
      ingested,
      sync_cursor: nextHistoryId,
      took_ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('ingest-gmail error:', msg);
    return json({ ok: false, error: msg, took_ms: Date.now() - t0 }, 500);
  }
});
