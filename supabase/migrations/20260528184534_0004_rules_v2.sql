-- ════════════════════════════════════════════════════════════════════
-- 0004 · Rules v2 — replace seed rules with people-table-aware
-- conditions, add 4 new rules from Chris's writeup.
--
-- New condition fields the matcher (Phase 2) will understand:
--   sender_priority_in   : array of people.priority_tier values
--   sender_role_in       : array of people.role_category values
--   sender_role_not_in   : array of people.role_category values (exclude)
--   sender_org_in        : array of people.org values
--   sender_in            : array of specific emails (overrides people lookup)
--   exclude_noise_senders: bool — auto-skip people.priority_tier='noise'
--
-- New action fields:
--   re_nag = 'hourly'    : pings every hour while open, gated by quiet hours
--   (quiet hours 22:00–06:00 MT enforced globally by the matcher)
-- ════════════════════════════════════════════════════════════════════

delete from public.rules;

insert into public.rules (name, description, enabled, conditions, actions) values

(
  'SESD invoice email',
  'Any email from SESD (utility role) with "invoice" in the subject is critical.',
  true,
  '{"source":"gmail","sender_org_in":["SESD"],"subject_regex":"(?i)invoice","exclude_noise_senders":true}',
  '{"severity":"critical","title_template":"SESD invoice: {subject}","re_nag":"hourly"}'
),
(
  'High-priority sender with attachment',
  'Email from any critical/high-priority sender with an attachment — flag within 24h.',
  true,
  '{"source":"gmail","sender_priority_in":["critical","high"],"has_attachments":true,"exclude_noise_senders":true}',
  '{"severity":"warn","title_template":"Review attachment from {sender}: {subject}","re_nag":"daily","escalate_after":1}'
),
(
  'ClickUp task past due',
  'Any open ClickUp task whose due date is in the past gets a daily nag until handled.',
  true,
  '{"source":"clickup","past_due":true,"status_in":["open","in progress","blocked"]}',
  '{"severity":"warn","title_template":"Past due: {subject}","re_nag":"daily"}'
),
(
  'ClickUp task due <24h, no recent activity',
  'Soft nag: task due in <24h with no activity in 48h+.',
  true,
  '{"source":"clickup","due_within_hours":24,"age_min_hours":48,"status_in":["open","in progress"]}',
  '{"severity":"info","title_template":"Due soon (no activity): {subject}","re_nag":"none"}'
),
(
  'Meeting in <2h with related ClickUp tasks',
  'Calendar event starting in <2h with open related tasks — context push.',
  true,
  '{"source":"gcal","due_within_hours":2,"has_related_tasks":true,"exclude_noise_senders":true}',
  '{"severity":"info","title_template":"Meeting prep: {subject}","re_nag":"none"}'
),
(
  'External vendor/utility unanswered 3 days',
  'External critical/high sender (excludes internal UBB staff) unread for 3+ days → critical, hourly nag.',
  true,
  '{"source":"gmail","sender_priority_in":["critical","high"],"sender_role_not_in":["internal","family","automated"],"age_min_hours":72,"status_in":["unread","unanswered"],"exclude_noise_senders":true}',
  '{"severity":"critical","title_template":"3+ days no reply: {sender} — {subject}","re_nag":"hourly"}'
),
(
  'Internal UBB unanswered 5 days',
  'Internal staff email unread for 5+ days — softer than external escalation.',
  true,
  '{"source":"gmail","sender_role_in":["internal"],"age_min_hours":120,"status_in":["unread","unanswered"]}',
  '{"severity":"warn","title_template":"Internal unread: {sender} — {subject}","re_nag":"daily"}'
),
(
  'New vendor quote',
  'Subject mentions quote/estimate/proposal from a vendor → cross-reference procurement.',
  true,
  '{"source":"gmail","subject_regex":"(?i)(quote|estimate|proposal|RFQ)","sender_role_in":["vendor"],"exclude_noise_senders":true}',
  '{"severity":"info","title_template":"New quote from {sender}: {subject}","re_nag":"none"}'
),
(
  'SESD payment confirmation',
  'Payment confirmation from SESD — auto-mark related task done.',
  true,
  '{"source":"gmail","sender_org_in":["SESD"],"subject_regex":"(?i)(payment|paid|confirmation)"}',
  '{"severity":"info","title_template":"Payment confirmed: {subject}","re_nag":"none","auto_close_event":true}'
),
(
  'ClickUp status changed to blocked',
  'Task flipped to blocked — nag with context.',
  true,
  '{"source":"clickup","status_change_to":"blocked"}',
  '{"severity":"warn","title_template":"Blocked: {subject}","re_nag":"daily"}'
),
(
  'Phase number referenced in new email',
  'Email body references a phase like "PH 4.2" or "Phase 3.1" — update phase tracker.',
  true,
  '{"source":"gmail","body_regex":"(?i)\\b(ph|phase)\\s*\\d+\\.\\d+\\b","exclude_noise_senders":true}',
  '{"severity":"info","title_template":"Phase mention: {subject}","re_nag":"none"}'
),

-- ─── 4 new rules from Chris's writeup ───────────────────────────────

(
  'Anything from Melinda (Reconnect lead)',
  'Any email from Melinda Fleming at either UBB or AireBeam — Reconnect work, never miss.',
  true,
  '{"source":"gmail","sender_in":["mfleming@utahbroadband.com","melinda@airebeam.net"]}',
  '{"severity":"critical","title_template":"Melinda: {subject}","re_nag":"hourly"}'
),
(
  'Anything from Michelle Filleman',
  'Any email from Michelle — flag for review (per Chris).',
  true,
  '{"source":"gmail","sender_in":["mfilleman@utahbroadband.com"]}',
  '{"severity":"warn","title_template":"Michelle: {subject}","re_nag":"daily"}'
),
(
  'Anything from R&S Drilling',
  'Any email from R&S Directional Drilling — flag (per Chris).',
  true,
  '{"source":"gmail","sender_org_in":["R&S Directional Drilling"]}',
  '{"severity":"warn","title_template":"R&S Drilling: {subject}","re_nag":"daily"}'
),
(
  'Project keyword in subject (Reconnect / BEAD / West Mountain)',
  'Email subject mentions a tracked project/program — flag for context.',
  true,
  '{"source":"gmail","subject_regex":"(?i)\\b(reconnect|bead|west\\s*mountain)\\b","exclude_noise_senders":true}',
  '{"severity":"info","title_template":"Project mention: {subject}","re_nag":"none"}'
);
