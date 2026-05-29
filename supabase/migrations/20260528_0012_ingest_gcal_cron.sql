-- ════════════════════════════════════════════════════════════════════
-- 0012 · pg_cron schedule for ingest-gcal.
-- Every 15 min, offset 5 min from ingest-clickup.
-- ════════════════════════════════════════════════════════════════════

select cron.schedule(
  'ingest-gcal',
  '5-59/15 * * * *',
  $cron$
  select net.http_post(
    url := 'https://dcmltuyyrmodaqhuudyd.supabase.co/functions/v1/ingest-gcal',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'nag_anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) as request_id;
  $cron$
);
