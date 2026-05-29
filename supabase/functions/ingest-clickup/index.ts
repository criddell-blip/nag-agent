// ingest-clickup v6 — full-fetch + per-team reconciliation + folder allowlist.
//
// Filtering: if CLICKUP_INCLUDE_FOLDERS is set (comma-separated folder
// names), only tasks in those folders flow into events. Everything else
// gets filtered out at ingest, and the reconciliation pass auto-closes
// their previously-ingested events + open alerts.
//
// Why no incremental sync: at our scale (~hundreds-low-thousands of tasks)
// full-fetch is cheap (~30s) and gives us the data we need to detect
// deletions. Tasks that disappear from ClickUp (deleted, closed, moved
// out of scope, permission revoked, filtered out) get marked inactive
// here and their open alerts get auto-closed.
//
// Per-team scoped: if a team's fetch errors out, we skip that team's
// reconciliation entirely — we don't want a transient API failure to
// nuke valid events from other teams.

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
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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

async function fetchAllActiveTasks(token: string, teamId: string): Promise<ClickUpTask[]> {
  const tasks: ClickUpTask[] = [];
  let page = 0;
  const MAX_PAGES = 10;
  while (page < MAX_PAGES) {
    const params: Record<string, string> = {
      page: String(page),
      subtasks: 'true',
      include_closed: 'false',
    };
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

function isActive(t: ClickUpTask): boolean {
  const type = (t.status?.type ?? '').toLowerCase();
  return type !== 'closed' && type !== 'done';
}

function buildFolderFilter(): (folderName: string | undefined) => boolean {
  const raw = Deno.env.get('CLICKUP_INCLUDE_FOLDERS');
  if (!raw) return () => true;  // no filter set → include all
  const allowed = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  if (allowed.size === 0) return () => true;
  return (folderName) => folderName != null && allowed.has(folderName);
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

    const teamsRaw = await clickupGet('/team', token);
    const teams = (teamsRaw?.teams ?? []) as Array<{ id: string; name: string; members?: any[] }>;
    if (teams.length === 0) throw new Error('No ClickUp teams accessible.');

    const folderFilter = buildFolderFilter();
    const folderFilterActive = Deno.env.get('CLICKUP_INCLUDE_FOLDERS') ? true : false;

    const perTeam: any[] = [];
    const allTasks: ClickUpTask[] = [];
    const successfulTeamIds: string[] = [];

    for (const team of teams) {
      if (/\(test\)/i.test(team.name)) {
        perTeam.push({ team_id: team.id, name: team.name, skipped: true });
        continue;
      }
      try {
        const raw = await fetchAllActiveTasks(token, team.id);
        const active = raw.filter(isActive);
        const filtered = active.filter((t) => folderFilter(t.folder?.name));
        filtered.forEach((t) => { t.team_id = team.id; });
        allTasks.push(...filtered);
        successfulTeamIds.push(team.id);
        perTeam.push({
          team_id: team.id, name: team.name,
          fetched: raw.length, kept_active: active.length, kept_after_folder_filter: filtered.length,
        });
      } catch (e) {
        perTeam.push({ team_id: team.id, name: team.name, error: e instanceof Error ? e.message : String(e), reconciliation_skipped: true });
      }
    }

    // Dedup by task ID across teams.
    const seen = new Set<string>();
    const dedup = allTasks.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    // ─── upsert active tasks ─────────────────────────────────────────
    let ingested = 0;
    if (dedup.length > 0) {
      const rows = dedup.map(taskToEvent);
      const { error: upsertErr } = await supabase
        .from('events')
        .upsert(rows, { onConflict: 'source,external_id' });
      if (upsertErr) throw new Error(`upsert: ${upsertErr.message}`);
      ingested = rows.length;
    }

    // ─── reconcile: close events+alerts for tasks not seen this run ──
    let eventsClosed = 0;
    let alertsClosed = 0;
    if (successfulTeamIds.length > 0) {
      const fetchedIdsByTeam = new Map<string, Set<string>>();
      for (const t of dedup) {
        if (!t.team_id) continue;
        if (!fetchedIdsByTeam.has(t.team_id)) fetchedIdsByTeam.set(t.team_id, new Set());
        fetchedIdsByTeam.get(t.team_id)!.add(t.id);
      }
      for (const teamId of successfulTeamIds) {
        const fetched = fetchedIdsByTeam.get(teamId) ?? new Set();
        const { data: stale } = await supabase
          .from('events')
          .select('id, external_id')
          .eq('source', 'clickup')
          .neq('status', 'inactive')
          .filter('raw_metadata->>team_id', 'eq', teamId);
        const ghosts = (stale ?? []).filter((e: any) => !fetched.has(e.external_id));
        if (ghosts.length === 0) continue;
        const ghostIds = ghosts.map((g: any) => g.id);
        await supabase.from('events').update({ status: 'inactive' }).in('id', ghostIds);
        eventsClosed += ghostIds.length;
        const { data: closedAlerts } = await supabase
          .from('alerts')
          .update({ status: 'done', closed_at: new Date().toISOString() })
          .in('event_id', ghostIds)
          .eq('status', 'open')
          .select('id');
        alertsClosed += (closedAlerts?.length ?? 0);
      }
    }

    await supabase.from('integrations').upsert(
      { service: 'clickup', sync_cursor: String(Date.now()), last_sync_at: new Date().toISOString(), active: true },
      { onConflict: 'service' },
    );

    return json({
      ok: true, function: 'ingest-clickup',
      ingested,
      folder_filter_active: folderFilterActive,
      per_team: perTeam,
      reconciled: {
        events_marked_inactive: eventsClosed,
        alerts_auto_closed: alertsClosed,
      },
      took_ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('ingest-clickup error:', msg);
    return json({ ok: false, error: msg, took_ms: Date.now() - t0 }, 500);
  }
});
