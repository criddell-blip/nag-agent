// ════════════════════════════════════════════════════════════════════
// ingest-clickup · Scheduled every 15 min via pg_cron.
//
// Pulls open ClickUp tasks updated since last sync, normalizes them
// into public.events. Idempotent via unique(source, external_id).
//
// Requires Edge Function secret: CLICKUP_API_TOKEN (Chris sets via
// Supabase Dashboard → Project Settings → Edge Functions → Secrets).
//
// Returns: { ok, ingested, page_count, sync_cursor, took_ms }
// ════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CLICKUP_API = 'https://api.clickup.com/api/v2';

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

interface ClickUpTask {
  id: string;
  url: string;
  name: string;
  text_content?: string;
  description?: string;
  status: { status: string; type?: string };
  date_created: string;   // milliseconds, as a string
  date_updated: string;   // milliseconds, as a string
  due_date?: string | null;
  creator?: { email?: string };
  assignees?: Array<{ email?: string }>;
  list?: { name?: string };
  folder?: { name?: string };
  space?: { name?: string };
}

interface IntegrationRow {
  service: string;
  sync_cursor: string | null;
  last_sync_at: string | null;
}

function msToIso(ms?: string | null): string | null {
  if (!ms) return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString();
}

async function clickupGet(path: string, token: string): Promise<any> {
  const res = await fetch(`${CLICKUP_API}${path}`, {
    headers: { Authorization: token, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickUp ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function discoverTeamId(token: string): Promise<string> {
  const data = await clickupGet('/team', token);
  const teams = data?.teams ?? [];
  if (teams.length === 0) throw new Error('No ClickUp teams accessible with this token');
  // For now assume first team. If Chris has multiple, we'll add picker later.
  return teams[0].id as string;
}

async function fetchUpdatedTasks(
  token: string,
  teamId: string,
  sinceMs: number,
): Promise<ClickUpTask[]> {
  const tasks: ClickUpTask[] = [];
  let page = 0;
  const MAX_PAGES = 10;  // cap at 1000 tasks/run to stay polite

  while (page < MAX_PAGES) {
    const params = new URLSearchParams({
      page: String(page),
      subtasks: 'true',
      include_closed: 'false',
      order_by: 'updated',
      reverse: 'true',
      date_updated_gt: String(sinceMs),
    });
    const data = await clickupGet(`/team/${teamId}/task?${params}`, token);
    const batch: ClickUpTask[] = data?.tasks ?? [];
    tasks.push(...batch);
    // ClickUp returns last_page bool OR fewer than 100 results == end
    if (batch.length < 100) break;
    page += 1;
  }

  return tasks;
}

function taskToEvent(task: ClickUpTask): Record<string, unknown> {
  const status = (task.status?.status ?? '').toLowerCase();
  return {
    source: 'clickup',
    external_id: task.id,
    external_url: task.url,
    event_type: 'task',
    subject: task.name,
    body_excerpt: (task.text_content || task.description || '').slice(0, 800),
    sender: task.creator?.email ?? null,
    participants: (task.assignees ?? [])
      .map((a) => a.email)
      .filter((e): e is string => Boolean(e)),
    occurred_at: msToIso(task.date_created) ?? new Date().toISOString(),
    due_at: msToIso(task.due_date),
    status,
    raw_metadata: {
      list: task.list?.name,
      folder: task.folder?.name,
      space: task.space?.name,
      date_updated_ms: task.date_updated,
      status_type: task.status?.type,
    },
  };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const t0 = Date.now();
  try {
    const token = Deno.env.get('CLICKUP_API_TOKEN');
    if (!token) {
      return json({
        ok: false,
        error: 'CLICKUP_API_TOKEN missing. Set in Supabase Dashboard → Edge Functions → Secrets.',
      }, 500);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ─── read sync cursor ────────────────────────────────────────────
    const { data: integration } = await supabase
      .from('integrations')
      .select('service, sync_cursor, last_sync_at')
      .eq('service', 'clickup')
      .maybeSingle<IntegrationRow>();

    // First run: pull last 30 days. Otherwise: since last cursor.
    const sinceMs = integration?.sync_cursor
      ? Number(integration.sync_cursor)
      : Date.now() - 30 * 24 * 60 * 60 * 1000;

    // ─── discover team + fetch tasks ─────────────────────────────────
    const teamId = await discoverTeamId(token);
    const tasks = await fetchUpdatedTasks(token, teamId, sinceMs);

    // ─── upsert into events ──────────────────────────────────────────
    let ingested = 0;
    if (tasks.length > 0) {
      const rows = tasks.map(taskToEvent);
      const { error: upsertErr } = await supabase
        .from('events')
        .upsert(rows, { onConflict: 'source,external_id' });
      if (upsertErr) throw new Error(`upsert: ${upsertErr.message}`);
      ingested = rows.length;
    }

    // ─── advance cursor to newest task seen ──────────────────────────
    let nextCursor = String(sinceMs);
    if (tasks.length > 0) {
      const maxUpdated = tasks.reduce(
        (max, t) => Math.max(max, Number(t.date_updated) || 0),
        0,
      );
      if (maxUpdated > 0) nextCursor = String(maxUpdated);
    }

    await supabase.from('integrations').upsert(
      {
        service: 'clickup',
        sync_cursor: nextCursor,
        last_sync_at: new Date().toISOString(),
        active: true,
      },
      { onConflict: 'service' },
    );

    return json({
      ok: true,
      function: 'ingest-clickup',
      team_id: teamId,
      ingested,
      page_count: Math.ceil(tasks.length / 100),
      sync_cursor: nextCursor,
      took_ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('ingest-clickup error:', msg);
    return json({ ok: false, error: msg, took_ms: Date.now() - t0 }, 500);
  }
});
