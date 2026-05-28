-- ════════════════════════════════════════════════════════════════════
-- 0002 · Seed 10 starter rules (keyword-only, no LLM).
-- NOTE: These were rewritten in 0004_rules_v2 to use the people table.
-- Kept here for history. The actual current rule set is what 0004 inserts.
-- ════════════════════════════════════════════════════════════════════

insert into public.rules (name, description, enabled, conditions, actions) values

(
  'SESD invoice email',
  'Any email from @sesdofutah.org with "invoice" in the subject is critical and needs review.',
  true,
  '{"source":"gmail","sender_regex":"@sesdofutah\\.org$","subject_regex":"(?i)invoice"}',
  '{"severity":"critical","title_template":"SESD invoice: {subject}","re_nag":"daily"}'
),
(
  'Key sender with attachment',
  'Email from Ryan, Brook, or Heather with an attachment — flag for review within 24h.',
  true,
  '{"source":"gmail","sender_allowlist":["ryan","brook","heather"],"has_attachments":true}',
  '{"severity":"warn","title_template":"Review attachment from {sender}: {subject}","re_nag":"daily","escalate_after":1}'
),
(
  'ClickUp task past due',
  'Any open ClickUp task whose due date is in the past gets a daily nag until handled or snoozed.',
  true,
  '{"source":"clickup","past_due":true,"status_in":["open","in progress","blocked"]}',
  '{"severity":"warn","title_template":"Past due: {subject}","re_nag":"daily"}'
),
(
  'ClickUp task due <24h, no recent activity',
  'Soft nag when a task is due in less than 24 hours and has had no activity recently.',
  true,
  '{"source":"clickup","due_within_hours":24,"age_min_hours":48,"status_in":["open","in progress"]}',
  '{"severity":"info","title_template":"Due soon (no activity): {subject}","re_nag":"none"}'
),
(
  'Meeting in <2h with related ClickUp tasks',
  'Calendar event starting within 2 hours that has open ClickUp tasks tied to it — context push.',
  true,
  '{"source":"gcal","due_within_hours":2,"has_related_tasks":true}',
  '{"severity":"info","title_template":"Meeting prep: {subject}","re_nag":"none"}'
),
(
  'Key sender unanswered for 3 days',
  'Email from a key sender sitting unread/unreplied for 3+ days escalates to critical.',
  true,
  '{"source":"gmail","sender_allowlist":["ryan","brook","heather","mike","melinda"],"age_min_hours":72,"status_in":["unread","unanswered"]}',
  '{"severity":"critical","title_template":"3+ days no reply: {sender} — {subject}","re_nag":"daily"}'
),
(
  'New vendor quote email',
  'Email mentioning a quote or estimate — cross-reference procurement and flag deltas.',
  true,
  '{"source":"gmail","subject_regex":"(?i)(quote|estimate|proposal)"}',
  '{"severity":"info","title_template":"New quote: {subject}","re_nag":"none"}'
),
(
  'SESD payment confirmation',
  'Payment confirmation email from conservation@sesdofutah.org — auto-mark related task done.',
  true,
  '{"source":"gmail","sender_regex":"^conservation@sesdofutah\\.org$","subject_regex":"(?i)(payment|paid|confirmation)"}',
  '{"severity":"info","title_template":"Payment confirmed: {subject}","re_nag":"none","auto_close_event":true}'
),
(
  'ClickUp status changed to blocked',
  'Task flipped to blocked status — nag with context.',
  true,
  '{"source":"clickup","status_change_to":"blocked"}',
  '{"severity":"warn","title_template":"Blocked: {subject}","re_nag":"daily"}'
),
(
  'Phase number referenced in new email',
  'Email subject or body references a phase like "PH 4.2" or "Phase 3.1" — update phase tracker.',
  true,
  '{"source":"gmail","body_regex":"(?i)\\b(ph|phase)\\s*\\d+\\.\\d+\\b"}',
  '{"severity":"info","title_template":"Phase mention: {subject}","re_nag":"none"}'
);
