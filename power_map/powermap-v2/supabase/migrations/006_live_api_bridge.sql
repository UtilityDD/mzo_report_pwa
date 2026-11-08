-- PowerMap live API bridge
-- Data stays in schema powermap; public.pm_* views let the anon key reach it
-- (avoids waiting on Dashboard → API → Exposed schemas).
--
-- Run this in Supabase SQL Editor AFTER importing network data.

-- ── Base tables (simple views = updatable) ─────────────────
create or replace view public.pm_voltage_levels as
  select * from powermap.voltage_levels;

create or replace view public.pm_org_units as
  select * from powermap.org_units;

create or replace view public.pm_assets as
  select * from powermap.assets;

create or replace view public.pm_substations as
  select * from powermap.substations;

create or replace view public.pm_transformers as
  select * from powermap.transformers;

create or replace view public.pm_lines as
  select * from powermap.lines;

create or replace view public.pm_tap_nodes as
  select * from powermap.tap_nodes;

create or replace view public.pm_tap_laterals as
  select * from powermap.tap_laterals;

create or replace view public.pm_profiles as
  select * from powermap.profiles;

-- ── Read models ────────────────────────────────────────────
create or replace view public.pm_v_substations as
  select * from powermap.v_substations;

create or replace view public.pm_v_lines as
  select * from powermap.v_lines;

create or replace view public.pm_v_tap_nodes as
  select * from powermap.v_tap_nodes;

create or replace view public.pm_v_tap_laterals as
  select * from powermap.v_tap_laterals;

-- ── Grants ─────────────────────────────────────────────────
grant select, insert, update, delete on
  public.pm_voltage_levels,
  public.pm_org_units,
  public.pm_assets,
  public.pm_substations,
  public.pm_transformers,
  public.pm_lines,
  public.pm_tap_nodes,
  public.pm_tap_laterals,
  public.pm_profiles
to anon, authenticated, service_role;

grant select on
  public.pm_v_substations,
  public.pm_v_lines,
  public.pm_v_tap_nodes,
  public.pm_v_tap_laterals
to anon, authenticated, service_role;

-- Keep powermap grants healthy (idempotent)
grant usage on schema powermap to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema powermap to anon, authenticated, service_role;
grant select on powermap.v_substations, powermap.v_lines, powermap.v_tap_nodes, powermap.v_tap_laterals
  to anon, authenticated, service_role;
grant usage, select on all sequences in schema powermap to anon, authenticated, service_role;

-- Optional: also expose schema via PostgREST if your project allows it
do $$
begin
  execute $c$
    alter role authenticator set pgrst.db_schemas = 'public, graphql_public, powermap'
  $c$;
  perform pg_notify('pgrst', 'reload config');
exception when others then
  raise notice 'Could not alter authenticator schemas (use Dashboard Exposed schemas if needed): %', SQLERRM;
end $$;
