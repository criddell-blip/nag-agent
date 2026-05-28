// ════════════════════════════════════════════════════════════════════
// evaluate-rules · Scheduled every 15 min, ~2 min after the ingesters.
//
// For each enabled rule, finds events that match the rule's JSON
// conditions and don't yet have an alert. Inserts new alerts (idempotent
// via unique(rule_id, event_id) from migration 0006).
//
// Also handles re-nag: for any open alert with re_nag != 'none' whose
// last_notified_at is stale, bumps last_notified_at to now() — Phase 3's
// slack-notify function will pick those up and re-ping.
//
// Returns: { ok, rules_evaluated, alerts_created, alerts_renag_bumped, took_ms }
// ════════════════════════════════════════════════════════════════════

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

// ─── types ──────────────────────────────────────────────────────────
type Conditions = {
  source?: 'gmail' | 'clickup' | 'gcal';
  sender_in?: string[];
  sender_regex?: string;
  sender_priority_in?: string[];
  sender_role_in?: string[];
  sender_role_not_in?: string[];
  sender_org_in?: string[];
  subject_regex?: string;
  body_regex?: string;
  has_attachments?: boolean;
  age_min_hours?: number;
  age_max_hours?: number;
  due_within_hours?: number;
  past_due?: boolean;
  status_in?: string[];
  status_change_to?: string;
  has_related_tasks?: boolean;
  exclude_noise_senders?: boolean;
};

type Actions = {
  severity: 'info' | 'warn' | 'critical';
  title_template?: string;
  re_nag?: 'hourly' | 'daily' | 'none';
  escalate_after?: number;
  auto_close_event?: boolean;
};

interface RuleRow {
  id: string;
  name: string;
  conditions: Conditions;
  actions: Actions;
}

interface EventRow {
  id: string;
  source: string;
  external_id: string;
  external_url: string | null;
  subject: string | null;
  body_excerpt: string | null;
  sender: string | null;
  occurred_at: string;
  due_at: string | null;
  status: string | null;
  raw_metadata: Record<string, any> | null;
}

interface PersonRow {
  email: string;
  priority_tier: string;
  role_category: string;
  org: string | null;
}

// ─── condition matcher ──────────────────────────────────────────────
function matches(
  event: EventRow,
  cond: Conditions,
  peopleByEmail: Map<string, PersonRow>,
): boolean {
  if (cond.source && event.source !== cond.source) return false;

  const senderEmail = (event.sender ?? '').toLowerCase().trim();
  const person = senderEmail ? peopleByEmail.get(senderEmail) : undefined;

  // exclude_noise_senders: skip if the sender is in people with priority='noise'
  if (cond.exclude_noise_senders && person?.priority_tier === 'noise') return false;

  if (cond.sender_in && cond.sender_in.length > 0) {
    const allowed = cond.sender_in.map((s) => s.toLowerCase());
    if (!allowed.includes(senderEmail)) return false;
  }

  if (cond.sender_regex) {
    try {
      if (!new RegExp(cond.sender_regex, 'i').test(event.sender ?? '')) return false;
    } catch { return false; }
  }

  if (cond.sender_priority_in && cond.sender_priority_in.length > 0) {
    if (!person || !cond.sender_priority_in.includes(person.priority_tier)) return false;
  }

  if (cond.sender_role_in && cond.sender_role_in.length > 0) {
    if (!person || !cond.sender_role_in.includes(person.role_category)) return false;
  }

  if (cond.sender_role_not_in && cond.sender_role_not_in.length > 0) {
    if (person && cond.sender_role_not_in.includes(person.role_category)) return false;
  }

  if (cond.sender_org_in && cond.sender_org_in.length > 0) {
    if (!person?.org || !cond.sender_org_in.includes(person.org)) return false;
  }

  if (cond.subject_regex) {
    try {
      if (!new RegExp(cond.subject_regex).test(event.subject ?? '')) return false;
    } catch { return false; }
  }

  if (cond.body_regex) {
    try {
      if (!new RegExp(cond.body_regex).test(event.body_excerpt ?? '')) return false;
    } catch { return false; }
  }

  if (cond.has_attachments) {
    if (!event.raw_metadata?.has_attachments) return false;
  }

  const now = Date.now();
  const occurredMs = new Date(event.occurred_at).getTime();
  const ageHours = (now - occurredMs) / (1000 * 60 * 60);
  if (cond.age_min_hours && ageHours < cond.age_min_hours) return false;
  if (cond.age_max_hours && ageHours > cond.age_max_hours) return false;

  if (cond.past_due) {
    if (!event.due_at || new Date(event.due_at).getTime() >= now) return false;
  }

  if (cond.due_within_hours) {
    if (!event.due_at) return false;
    const dueMs = new Date(event.due_at).getTime();
    const horizonMs = now + cond.due_within_hours * 60 * 60 * 1000;
    if (dueMs < now || dueMs > horizonMs) return false;
  }

  if (cond.status_in && cond.status_in.length > 0) {
    const eventStatus = (event.status ?? '').toLowerCase();
    if (!cond.status_in.map((s) => s.toLowerCase()).includes(eventStatus)) return false;
  }

  // status_change_to + has_related_tasks: deferred (need additional
  // event_type='status_change' ingestion + phase cross-reference)
  if (cond.status_change_to) return false;
  if (cond.has_related_tasks) return false;

  return true;
}

// ─── title rendering ────────────────────────────────────────────────
function renderTitle(template: string, event: EventRow): string {
  return template
    .replace(/\{subject\}/g, event.subject ?? '(no subject)')
    .replace(/\{sender\}/g, event.sender ?? '(unknown)');
}

// ─── main handler ───────────────────────────────────────────────────
async function evaluate(supabase: SupabaseClient) {
  // Load rules + people up front (small datasets).
  const { data: rules, error: rulesErr } = await supabase
    .from('rules')
    .select('id, name, conditions, actions')
    .eq('enabled', true);
  if (rulesErr) throw new Error(`load rules: ${rulesErr.message}`);

  const { data: people, error: peopleErr } = await supabase
    .from('people')
    .select('email, priority_tier, role_category, org');
  if (peopleErr) throw new Error(`load people: ${peopleErr.message}`);

  const peopleByEmail = new Map<string, PersonRow>();
  for (const p of (people ?? []) as PersonRow[]) {
    peopleByEmail.set(p.email.toLowerCase(), p);
  }

  // Pull a wide window of recent events (last 30 days). Most rules
  // care about recent stuff; the past_due rule needs a wider net for
  // tasks that fell behind.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: events, error: evErr } = await supabase
    .from('events')
    .select('id, source, external_id, external_url, subject, body_excerpt, sender, occurred_at, due_at, status, raw_metadata')
    .gte('ingested_at', since)
    .order('occurred_at', { ascending: false })
    .limit(5000);
  if (evErr) throw new Error(`load events: ${evErr.message}`);

  // Group events by source so each rule only scans its own source.
  const eventsBySource = new Map<string, EventRow[]>();
  for (const e of (events ?? []) as EventRow[]) {
    const list = eventsBySource.get(e.source) ?? [];
    list.push(e);
    eventsBySource.set(e.source, list);
  }

  // ─── match + insert alerts ────────────────────────────────────────
  let alertsCreated = 0;
  for (const rule of (rules ?? []) as RuleRow[]) {
    const candidates = rule.conditions.source
      ? (eventsBySource.get(rule.conditions.source) ?? [])
      : (events ?? []) as EventRow[];

    const matchedEvents = candidates.filter((e) => matches(e, rule.conditions, peopleByEmail));
    if (matchedEvents.length === 0) continue;

    const rows = matchedEvents.map((e) => ({
      rule_id: rule.id,
      event_id: e.id,
      severity: rule.actions.severity,
      title: renderTitle(rule.actions.title_template ?? '{subject}', e),
      body: e.body_excerpt?.slice(0, 400) ?? null,
      context_links: e.external_url ? [{ label: 'Open', url: e.external_url }] : null,
      status: 'open',
    }));

    // Idempotent insert: unique(rule_id, event_id) catches dupes silently.
    const { data: inserted, error: insErr } = await supabase
      .from('alerts')
      .upsert(rows, { onConflict: 'rule_id,event_id', ignoreDuplicates: true })
      .select('id');
    if (insErr) {
      console.error(`alerts insert for rule ${rule.name}: ${insErr.message}`);
      continue;
    }
    alertsCreated += (inserted?.length ?? 0);
  }

  // ─── re-nag: bump last_notified_at on stale open alerts ────────────
  // hourly: stale = last_notified_at < now - 1h (or null)
  // daily:  stale = last_notified_at < today-anchor-time (06:00 MT)
  // For Phase 2 we just bump the timestamp — Slack hook lands in Phase 3.
  const nowIso = new Date().toISOString();
  const hourlyCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const dailyCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let renagBumped = 0;

  for (const rule of (rules ?? []) as RuleRow[]) {
    const renag = rule.actions.re_nag;
    if (!renag || renag === 'none') continue;
    const cutoff = renag === 'hourly' ? hourlyCutoff : dailyCutoff;

    const { data: bumped, error: bumpErr } = await supabase
      .from('alerts')
      .update({ last_notified_at: nowIso })
      .eq('rule_id', rule.id)
      .eq('status', 'open')
      .or(`last_notified_at.is.null,last_notified_at.lt.${cutoff}`)
      .select('id');
    if (bumpErr) {
      console.error(`renag bump for rule ${rule.name}: ${bumpErr.message}`);
      continue;
    }
    renagBumped += (bumped?.length ?? 0);
  }

  return {
    rules_evaluated: rules?.length ?? 0,
    events_scanned: events?.length ?? 0,
    alerts_created: alertsCreated,
    alerts_renag_bumped: renagBumped,
  };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const t0 = Date.now();
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const result = await evaluate(supabase);
    return json({ ok: true, function: 'evaluate-rules', ...result, took_ms: Date.now() - t0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('evaluate-rules error:', msg);
    return json({ ok: false, error: msg, took_ms: Date.now() - t0 }, 500);
  }
});
