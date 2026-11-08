-- PowerMap: read-only for the public keys; writes only through the DISHA server.
--
-- Run in the Supabase SQL Editor of the Power Map project AFTER the DISHA release whose map
-- talks to /api/powermap/rest/v1 (the browser no longer holds a Supabase key), and AFTER
-- POWERMAP_SUPABASE_SERVICE_KEY is set on the server (docs/power-map-v2.md). Until that key is
-- set, map edits fail once this has run; viewing keeps working with the anon key.
--
-- What it does:
--   1. anon / authenticated keep SELECT on the map tables and pm_* views, and lose
--      INSERT / UPDATE / DELETE / TRUNCATE everywhere in schema powermap and on public.pm_*.
--   2. The editor accounts (pin_hash), edit suggestions and profiles are not readable with the
--      public keys at all (service_role only).
--   3. The "for all using (true) with check (true)" policies become SELECT-only policies.
--   4. SECURITY DEFINER functions (pm_admin_update_substation_bundle and friends) and the
--      write helpers can be executed by service_role only.
--   5. Future tables in schema powermap no longer get write grants for anon by default.
-- service_role bypasses RLS and keeps its grants, so the DISHA server can still write.
--
-- Safe to run more than once. Wrapped in a transaction: any error leaves everything as it was.

begin;

-- ── 1. Table and view privileges ───────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on all tables in schema powermap from anon, authenticated, public;

do $$
declare r record;
begin
  -- Every pm_* table or view in public (the 006/008/009 bridge views and any later ones).
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'pm\_%' and c.relkind in ('r', 'v', 'm', 'p', 'f')
  loop
    execute format(
      'revoke insert, update, delete, truncate, references, trigger on public.%I from anon, authenticated, public',
      r.relname);
  end loop;
end $$;

-- Sequences: nextval/setval are writes.
revoke usage, update on all sequences in schema powermap from anon, authenticated, public;

-- ── 2. Admin-only tables: no access with the public keys ───────────────────
do $$
declare t text;
begin
  foreach t in array array['powermap.editors', 'powermap.edit_suggestions', 'powermap.profiles',
                           'public.pm_editors', 'public.pm_edit_suggestions', 'public.pm_profiles']
  loop
    if to_regclass(t) is not null then
      execute format('revoke all on %s from anon, authenticated, public', t);
      execute format('grant all on %s to service_role', t);
    end if;
  end loop;
end $$;

-- ── 3. RLS: read-only policies for the map tables ──────────────────────────
do $$
declare r record;
begin
  -- Drop every write-capable policy (FOR ALL / INSERT / UPDATE / DELETE) in schema powermap.
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'powermap' and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;

  -- Map tables: one SELECT policy for the public keys. Editors, suggestions and profiles get none.
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'powermap' and c.relkind in ('r', 'p')
      and c.relname not in ('editors', 'edit_suggestions', 'profiles')
  loop
    execute format('alter table powermap.%I enable row level security', r.relname);
    if not exists (
      select 1 from pg_policies
      where schemaname = 'powermap' and tablename = r.relname and cmd = 'SELECT'
    ) then
      execute format('create policy %I on powermap.%I for select to anon, authenticated using (true)',
                     'pm ' || r.relname || ' read', r.relname);
    end if;
  end loop;

  -- Editors, suggestions, profiles: RLS on and no policy for anon/authenticated (service_role bypasses RLS).
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'powermap' and tablename in ('editors', 'edit_suggestions', 'profiles')
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
  if to_regclass('powermap.editors') is not null then
    alter table powermap.editors enable row level security;
  end if;
  if to_regclass('powermap.edit_suggestions') is not null then
    alter table powermap.edit_suggestions enable row level security;
  end if;
  if to_regclass('powermap.profiles') is not null then
    alter table powermap.profiles enable row level security;
  end if;
end $$;

-- ── 4. Functions: SECURITY DEFINER and write helpers → service_role only ───
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'powermap' and (p.prosecdef or p.proname in ('rebuild_line_geom')))
       or (n.nspname = 'public' and p.proname like 'pm\_%' and p.prosecdef)
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.fn);
    execute format('grant execute on function %s to service_role', r.fn);
  end loop;
end $$;

-- ── 5. Defaults for tables created later in schema powermap ────────────────
alter default privileges in schema powermap
  revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;
alter default privileges in schema powermap
  grant select on tables to anon, authenticated;
alter default privileges in schema powermap
  grant all on tables to service_role;

commit;

notify pgrst, 'reload schema';

-- ── Checks (read-only; run after the above) ────────────────────────────────
-- Expect no rows: anything anon can still write in powermap or public.pm_*.
--   select table_schema, table_name, privilege_type
--   from information_schema.role_table_grants
--   where grantee in ('anon', 'authenticated', 'PUBLIC')
--     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
--     and (table_schema = 'powermap' or (table_schema = 'public' and table_name like 'pm\_%'))
--   order by 1, 2, 3;
--
-- Expect no rows: functions anon can still execute that run as their owner.
--   select n.nspname, p.proname
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where p.prosecdef and n.nspname in ('powermap', 'public')
--     and has_function_privilege('anon', p.oid, 'execute')
--     and (n.nspname = 'powermap' or p.proname like 'pm\_%');
--
-- Optional, for the rest of the project (003 once granted anon writes on every public table):
-- public tables where anon still holds a write grant, with their RLS state. Review before revoking;
-- other DISHA features use this project.
--   select c.relname, c.relrowsecurity as rls_on,
--          string_agg(distinct g.privilege_type, ',') as anon_writes
--   from information_schema.role_table_grants g
--   join pg_class c on c.relname = g.table_name
--   join pg_namespace n on n.oid = c.relnamespace and n.nspname = g.table_schema
--   where g.grantee = 'anon' and g.table_schema = 'public'
--     and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
--   group by 1, 2 order by 2, 1;
