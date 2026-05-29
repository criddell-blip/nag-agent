-- ════════════════════════════════════════════════════════════════════
-- 0011 · Rule 5 (meeting prep) — drop has_related_tasks requirement.
-- That condition is deferred (matcher returns false on it), so without
-- this fix rule 5 never fires. Drop it so every meeting in <2h gets
-- a one-time info-level DM.
-- ════════════════════════════════════════════════════════════════════

update public.rules
set conditions = jsonb_build_object(
  'source', 'gcal',
  'due_within_hours', 2,
  'exclude_noise_senders', true
)
where name = 'Meeting in <2h with related ClickUp tasks';

update public.rules
set name = 'Meeting in <2h',
    description = 'Calendar event starting within 2 hours — context push DM.'
where name = 'Meeting in <2h with related ClickUp tasks';
