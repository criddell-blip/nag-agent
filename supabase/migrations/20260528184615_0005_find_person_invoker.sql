-- 0005 · find_person doesn't need elevated privileges — people table has
-- its own RLS. Switch to SECURITY INVOKER so the function runs as the
-- calling user. Resolves the security advisor warning from 0003.
create or replace function public.find_person(p_sender text)
returns table (id uuid, priority_tier text, role_category text, org text, name text)
language sql stable
security invoker
set search_path = public, pg_temp
as $$
  select p.id, p.priority_tier, p.role_category, p.org, p.name
  from public.people p
  where lower(p.email) = lower(p_sender)
  limit 1;
$$;
