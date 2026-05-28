-- ════════════════════════════════════════════════════════════════════
-- 0006 · Alert idempotency.
-- The rule matcher should never insert the same (rule, event) pair twice.
-- Without this, every cron run would generate fresh duplicate alerts.
-- ════════════════════════════════════════════════════════════════════

create unique index alerts_rule_event_unique
  on public.alerts (rule_id, event_id)
  where rule_id is not null and event_id is not null;
