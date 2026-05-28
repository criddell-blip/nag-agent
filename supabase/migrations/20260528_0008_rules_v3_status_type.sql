-- ════════════════════════════════════════════════════════════════════
-- 0008 · Rules v3 — replace status_in (brittle per-workspace name)
-- with status_type_in (ClickUp's standardized open/custom/done/closed).
-- Only updates ClickUp-source rules. Gmail-source rules unchanged.
-- ════════════════════════════════════════════════════════════════════

update public.rules
set conditions = jsonb_build_object(
  'source','clickup','past_due',true,'status_type_in', jsonb_build_array('open','custom')
)
where name = 'ClickUp task past due';

update public.rules
set conditions = jsonb_build_object(
  'source','clickup','due_within_hours',24,'age_min_hours',48,
  'status_type_in', jsonb_build_array('open','custom')
)
where name = 'ClickUp task due <24h, no recent activity';
