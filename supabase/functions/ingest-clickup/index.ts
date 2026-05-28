// ingest-clickup v4 — multi-team iteration, filters out done/closed status types
// (ClickUp's include_closed=false only catches type='closed', not 'done').

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
  id: string; url: string; name: string;
  text_content?: string; description?: string;
  status: { status: string; type?: string };
  date_created: string; date_updated: string;
  due_date?: string | null;
  creator?: { email?: string };
  assignees?: Array<{ email?: string }>;
  list?: { name?: string }; folder?: { name?: string }; space?: { name?: string };
  team_id?: string;
}
interface IntegrationRow { service: string; sync_cursor: string | null; last_sync_at: string | null; }

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
    throw new Error(`ClickUp ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchTasksAtTeam(token: string, teamId: string, sinceMs: number | null) {
  const tasks: ClickUpTask[] = [];
  let page = 0;
  const MAX_PAGES = 10;
  while (page < MAX_PAGES) {
    const params: Record<string, string> = {
      page: String(page),
      subtasks: 'true',
      include_closed: 'false',
    };
    if (sinceMs !== null) params.date_updated_gt = String(sinceMs);
    const url = `/team/${teamId}/task?${new URLSearchParams(params)}`;
    const data = await clickupGet(url, token);
    const batch: ClickUpTask[] = data?.tasks ?? [];
    tasks.push(...batch);
    if (batch.length === 0 || data?.last_page === true) break;
    if (batch.length < 100) break;
    page += 1;
  }
  return tasks;
}

function isActiveTask(t: ClickUpTask): boolean {
  const type = (t.status?.type ?? '').toLowerCase();
  return type !== 'closed' && type !== 'done';
}

function taskToEvent(task: ClickUpTask): Record<string, unknown> {
  return {
    source: 'clickup',
    external_id: task.id,
    external_url: task.url,
    event_type: 'task',
    subject: task.name,
    body_excerpt: (task.text_content || task.description || '').slice(0, 800),
    sender: task.creator?.email ?? null,
    participants: (task.assignees ?? []).map((a) => a.email).filter((e): e is string => Boolean(e)),
    occurred_at: msToIso(task.date_created) ?? new Date().toISOString(),
    due_at: msToIso(task.due_date),
    status: (task.status?.status ?? '').toLowerCase(),
    raw_metadata: {
      list: task.list?.name, folder: task.folder?.name, space: task.space?.name,
      team_id: task.team_id,
      date_updated_ms: task.date_updated, status_type: task.status?.type,
    },
  };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const t0 = Date.now();
  try {
    const token = Deno.env.get('CLICKUP_API_TOKEN');
    if (!token) return json({ ok: false, error: 'CLICKUP_API_TOKEN missing.' }, 500);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: integration } = await supabase
      .from('integrations')
      .select('service, sync_cursor, last_sync_at')
      .eq('service', 'clickup')
      .maybeSingle<IntegrationRow>();

    const isFirstRun = !integration?.sync_cursor;
    const sinceMs = integration?.sync_cursor ? Number(integration.sync_cursor) : Date.now() - 30 * 24 * 60 * 60 * 1000;

    const teamsRaw = await clickupGet('/team', token);
    const teams = (teamsRaw?.teams ?? []) as Array<{ id: string; name: string; members?: any[] }>;
    if (teams.length === 0) throw new Error('No ClickUp teams accessible.');

    const perTeam: any[] = [];
    const allTasks: ClickUpTask[] = [];

    for (const team of teams) {
      if (/\(test\)/i.test(team.name)) {
        perTeam.push({ team_id: team.id, name: team.name, skipped: true });
        continue;
      }
      try {
        const filtered = await fetchTasksAtTeam(token, team.id, sinceMs);
        let teamTasks = filtered;
        if (teamTasks.length === 0 && isFirstRun) {
          teamTasks = await fetchTasksAtTeam(token, team.id, null);
        }
        // Filter out done/closed status types (include_closed=false misses 'done').
        const before = teamTasks.length;
        teamTasks = teamTasks.filter(isActiveTask);
        teamTasks.forEach((t) => { t.team_id = team.id; });
        allTasks.push(...teamTasks);
        perTeam.push({
          team_id: team.id, name: team.name,
          fetched: before, active_after_filter: teamTasks.length,
        });
      } catch (e) {
        perTeam.push({ team_id: team.id, name: team.name, error: e instanceof Error ? e.message : String(e) });
      }
    }

    const seen = new Set<string>();
    const dedup = allTasks.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    let ingested = 0;
    if (dedup.length > 0) {
      const rows = dedup.map(taskToEvent);
      const { error: upsertErr } = await supabase
        .from('events')
        .upsert(rows, { onConflict: 'source,external_id' });
      if (upsertErr) throw new Error(`upsert: ${upsertErr.message}`);
      ingested = rows.length;
    }

    let nextCursor = String(sinceMs);
    if (dedup.length > 0) {
      const maxUpdated = dedup.reduce((max, t) => Math.max(max, Number(t.date_updated) || 0), 0);
      if (maxUpdated > 0) nextCursor = String(maxUpdated);
    }

    await supabase.from('integrations').upsert(
      { service: 'clickup', sync_cursor: nextCursor, last_sync_at: new Date().toISOString(), active: true },
      { onConflict: 'service' },
    );

    return json({
      ok: true, function: 'ingest-clickup',
      ingested, sync_cursor: nextCursor,
      per_team: perTeam,
      took_ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('ingest-clickup error:', msg);
    return json({ ok: false, error: msg, took_ms: Date.now() - t0 }, 500);
  }
});
