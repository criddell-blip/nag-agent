-- ════════════════════════════════════════════════════════════════════
-- 0010 · pg_cron schedule for slack-notify.
-- Every 5 minutes. Function self-skips during quiet hours (22:00-06:00 MT).
-- ════════════════════════════════════════════════════════════════════

select cron.schedule(
  'slack-notify',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := 'https://dcmltuyyrmodaqhuudyd.supabase.co/functions/v1/slack-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'nag_anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) as request_id;
  $cron$
);
