// ════════════════════════════════════════════════════════════════════
// ingest-gcal v5 · multi-calendar iCal feed ingest.
//
// GOOGLE_CALENDAR_ICAL_URL can be a single URL OR comma-separated URLs.
// Pulls each calendar in parallel, parses VEVENT blocks, dedupes
// (master+instance within calendar, plus cross-calendar UID dedup),
// upserts into events.
//
// No GCP / OAuth required — uses Google's "secret iCal address" per
// calendar (Settings → Integrate calendar → "Secret address").
// ════════════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

interface ICalEvent {
  uid?: string; summary?: string; description?: string; location?: string;
  dtstart?: { value: string; tzid?: string; isDate?: boolean };
  dtend?: { value: string; tzid?: string; isDate?: boolean };
  organizer?: string; attendees: string[]; status?: string; url?: string;
  recurrenceId?: string; hasRRule?: boolean;
  _source_url?: string;
}

function unfoldLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}
function unescapeIcal(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}
function icalToIso(value: string, tzid?: string, isDate?: boolean): string | null {
  if (!value) return null;
  if (isDate || /^\d{8}$/.test(value)) {
    return `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T00:00:00Z`;
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (z === 'Z') return iso + 'Z';
  if (tzid) {
    try {
      const naive = new Date(`${iso}Z`);
      const probe = new Date(naive.toLocaleString('en-US', { timeZone: tzid }));
      const offsetMs = naive.getTime() - probe.getTime();
      return new Date(naive.getTime() + offsetMs).toISOString();
    } catch { return iso + 'Z'; }
  }
  return iso + 'Z';
}
function parseProperty(line: string) {
  const colonIdx = line.indexOf(':');
  if (colonIdx < 0) return null;
  const beforeColon = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = beforeColon.split(';');
  const name = parts[0];
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value };
}
function parseAttendeeEmail(line: string): string | null {
  const m = line.match(/mailto:([^\s;]+)/i);
  return m ? m[1].toLowerCase() : null;
}
function parseICal(text: string): ICalEvent[] {
  const lines = unfoldLines(text);
  const events: ICalEvent[] = [];
  let current: ICalEvent | null = null;
  for (const raw of lines) {
    if (raw === 'BEGIN:VEVENT') { current = { attendees: [] }; continue; }
    if (raw === 'END:VEVENT') { if (current) events.push(current); current = null; continue; }
    if (!current) continue;
    const prop = parseProperty(raw);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID': current.uid = prop.value; break;
      case 'SUMMARY': current.summary = unescapeIcal(prop.value); break;
      case 'DESCRIPTION': current.description = unescapeIcal(prop.value); break;
      case 'LOCATION': current.location = unescapeIcal(prop.value); break;
      case 'STATUS': current.status = prop.value; break;
      case 'URL': current.url = prop.value; break;
      case 'RECURRENCE-ID': current.recurrenceId = prop.value; break;
      case 'RRULE': current.hasRRule = true; break;
      case 'DTSTART':
        current.dtstart = { value: prop.value, tzid: prop.params.TZID, isDate: prop.params.VALUE === 'DATE' };
        break;
      case 'DTEND':
        current.dtend = { value: prop.value, tzid: prop.params.TZID, isDate: prop.params.VALUE === 'DATE' };
        break;
      case 'ORGANIZER': {
        const email = parseAttendeeEmail(raw);
        if (email) current.organizer = email;
        break;
      }
      case 'ATTENDEE': {
        const email = parseAttendeeEmail(raw);
        if (email) current.attendees.push(email);
        break;
      }
    }
  }
  return events;
}

function eventToRow(ev: ICalEvent, calendarHint?: string): Record<string, unknown> | null {
  if (!ev.uid || !ev.dtstart) return null;
  const start = icalToIso(ev.dtstart.value, ev.dtstart.tzid, ev.dtstart.isDate);
  if (!start) return null;
  const end = ev.dtend ? icalToIso(ev.dtend.value, ev.dtend.tzid, ev.dtend.isDate) : null;
  const bodyParts: string[] = [];
  if (ev.location) bodyParts.push(`📍 ${ev.location}`);
  if (ev.description) bodyParts.push(ev.description);
  const externalId = ev.recurrenceId ? `${ev.uid}::${ev.recurrenceId}` : ev.uid;
  return {
    source: 'gcal',
    external_id: externalId,
    external_url: ev.url ?? null,
    event_type: 'meeting',
    subject: ev.summary?.slice(0, 500) ?? '(no title)',
    body_excerpt: bodyParts.join('\n\n').slice(0, 800),
    sender: ev.organizer ?? null,
    participants: ev.attendees,
    occurred_at: start,
    due_at: start,
    status: (ev.status ?? 'confirmed').toLowerCase(),
    raw_metadata: { end_at: end, location: ev.location, organizer: ev.organizer, ical_uid: ev.uid, recurrence_id: ev.recurrenceId, calendar: calendarHint },
  };
}

async function fetchAndParse(url: string): Promise<{ events: ICalEvent[]; error?: string }> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'nag-agent/1.0', 'Accept': 'text/calendar' } });
    if (!res.ok) return { events: [], error: `HTTP ${res.status}` };
    const text = await res.text();
    return { events: parseICal(text) };
  } catch (e) {
    return { events: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function calendarLabel(url: string): string {
  // Google iCal URLs: https://calendar.google.com/calendar/ical/<email>/private-<token>/basic.ics
  const m = url.match(/calendar\/ical\/([^/]+)\//);
  if (m) return decodeURIComponent(m[1]);
  try { return new URL(url).hostname; } catch { return 'unknown'; }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const t0 = Date.now();
  try {
    const rawUrls = Deno.env.get('GOOGLE_CALENDAR_ICAL_URL');
    if (!rawUrls) return json({ ok: false, error: 'GOOGLE_CALENDAR_ICAL_URL missing.' }, 500);
    const urls = rawUrls.split(',').map((u) => u.trim()).filter(Boolean);
    if (urls.length === 0) return json({ ok: false, error: 'No URLs parsed from GOOGLE_CALENDAR_ICAL_URL.' }, 500);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Fetch each calendar in parallel; tag events with their source URL.
    const fetchResults = await Promise.all(urls.map(async (url) => {
      const label = calendarLabel(url);
      const { events, error } = await fetchAndParse(url);
      events.forEach((ev) => { ev._source_url = label; });
      return { url: label, count: events.length, events, error };
    }));

    const allEvents: ICalEvent[] = [];
    for (const r of fetchResults) allEvents.push(...r.events);

    // Dedup masters when instances exist (per UID).
    const uidsWithInstances = new Set<string>();
    for (const ev of allEvents) {
      if (ev.uid && ev.recurrenceId) uidsWithInstances.add(ev.uid);
    }
    let filtered = allEvents.filter((ev) => {
      if (!ev.uid) return false;
      if (ev.hasRRule && !ev.recurrenceId && uidsWithInstances.has(ev.uid)) return false;
      return true;
    });

    // Cross-calendar dedup: same UID across calendars → keep first.
    const seenUids = new Set<string>();
    filtered = filtered.filter((ev) => {
      const key = ev.recurrenceId ? `${ev.uid}::${ev.recurrenceId}` : ev.uid;
      if (seenUids.has(key!)) return false;
      seenUids.add(key!);
      return true;
    });

    const now = Date.now();
    const cutoffPast = now - 30 * 24 * 60 * 60 * 1000;
    const cutoffFuture = now + 90 * 24 * 60 * 60 * 1000;
    const rows: Record<string, unknown>[] = [];
    for (const ev of filtered) {
      const row = eventToRow(ev, ev._source_url);
      if (!row) continue;
      const startMs = new Date(row.occurred_at as string).getTime();
      if (startMs < cutoffPast || startMs > cutoffFuture) continue;
      rows.push(row);
    }

    let ingested = 0;
    if (rows.length > 0) {
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const { error: upErr } = await supabase
          .from('events').upsert(chunk, { onConflict: 'source,external_id' });
        if (upErr) { console.error(`upsert chunk ${i}: ${upErr.message}`); continue; }
        ingested += chunk.length;
      }
    }
    await supabase.from('integrations').upsert(
      { service: 'gcal', sync_cursor: String(now), last_sync_at: new Date().toISOString(), active: true },
      { onConflict: 'service' },
    );

    return json({
      ok: true, function: 'ingest-gcal',
      calendars: fetchResults.map((r) => ({ url: r.url, fetched: r.count, error: r.error })),
      total_in_feed: allEvents.length,
      after_dedup: filtered.length,
      ingested,
      window: '30d past → 90d future',
      took_ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('ingest-gcal error:', msg);
    return json({ ok: false, error: msg, took_ms: Date.now() - t0 }, 500);
  }
});
