-- ════════════════════════════════════════════════════════════════════
-- 0007 · pg_cron + pg_net schedule.
-- Schedules ingest-clickup (every 15 min) and evaluate-rules
-- (2 min after ingest) by POSTing to the Edge Function URLs.
--
-- Vault secret 'nag_anon_key' must exist before this runs. The Edge
-- Functions accept anon JWT for verify_jwt; they use
-- SUPABASE_SERVICE_ROLE_KEY internally for their own DB writes.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ingest-clickup',
  '*/15 * * * *',
  $cron$
  select net.http_post(
    url := 'https://dcmltuyyrmodaqhuudyd.supabase.co/functions/v1/ingest-clickup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'nag_anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) as request_id;
  $cron$
);

select cron.schedule(
  'evaluate-rules',
  '2-59/15 * * * *',
  $cron$
  select net.http_post(
    url := 'https://dcmltuyyrmodaqhuudyd.supabase.co/functions/v1/evaluate-rules',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'nag_anon_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) as request_id;
  $cron$
);
