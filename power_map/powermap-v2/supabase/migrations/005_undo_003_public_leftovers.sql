-- Fix: you ran 003 AFTER/AFTER 004 by mistake.
-- This removes PowerMap leftovers that 003 put back into PUBLIC.
-- Does NOT touch schema powermap (keep it).
-- Does NOT drop unrelated project tables.

-- 1) Drop PowerMap views in public
drop view if exists public.v_tap_laterals cascade;
drop view if exists public.v_tap_nodes cascade;
drop view if exists public.v_lines cascade;
drop view if exists public.v_substations cascade;

-- 2) Drop PowerMap tables 003 created in public (shape-checked)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='tap_laterals' and column_name='from_tap_asset_id'
  ) then
    execute 'drop table public.tap_laterals cascade';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='tap_nodes' and column_name='parent_line_asset_id'
  ) then
    execute 'drop table public.tap_nodes cascade';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='transformers' and column_name='substation_asset_id'
  ) then
    execute 'drop table public.transformers cascade';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='lines' and column_name='from_asset_id'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='lines' and column_name='asset_id'
  ) then
    execute 'drop table public.lines cascade';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='substations' and column_name='asset_id'
  ) then
    execute 'drop table public.substations cascade';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='assets' and column_name='asset_kind'
  ) then
    execute 'drop table public.assets cascade';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='voltage_levels' and column_name='kv_primary'
  ) then
    execute 'drop table public.voltage_levels cascade';
  end if;

  -- org_units only if it has our PowerMap seed id
  if exists (
    select 1 from information_schema.tables
    where table_schema='public' and table_name='org_units'
  ) then
    begin
      if exists (
        select 1 from public.org_units
        where id = '11111111-1111-1111-1111-111111111101'
      ) then
        execute 'drop table public.org_units cascade';
      end if;
    exception when undefined_table then
      null;
    end;
  end if;

  -- profiles: only drop if it looks like PowerMap-only recreate from 003
  -- (has role typed as app_role AND no rows from other apps we can detect).
  -- Safer default: DO NOT drop public.profiles automatically.
  -- Uncomment below ONLY if you are sure public.profiles was created by 003 and is unused by other apps:
  -- execute 'drop table public.profiles cascade';
end $$;

-- 3) Drop PowerMap functions 003 put in public
drop function if exists public.on_substation_moved() cascade;
drop function if exists public.rebuild_line_geom(uuid) cascade;
drop function if exists public.sync_tap_node_geom() cascade;
drop function if exists public.sync_substation_geom() cascade;
-- leave public.set_updated_at alone

-- 4) Drop PowerMap enums from public if unused
do $$
begin
  begin drop type if exists public.tap_target_kind cascade; exception when others then null; end;
  begin drop type if exists public.circuit_config cascade; exception when others then null; end;
  begin drop type if exists public.asset_lifecycle cascade; exception when others then null; end;
  begin drop type if exists public.org_unit_type cascade; exception when others then null; end;
  -- app_role may still be needed by public.profiles — only drop if unused
  begin drop type if exists public.app_role cascade; exception when others then null; end;
end $$;

-- 5) Verify powermap schema still healthy
do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'powermap') then
    raise exception 'Schema powermap is missing. Re-run 004_powermap_schema.sql';
  end if;
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'powermap' and table_name = 'assets'
  ) then
    raise exception 'powermap.assets missing. Re-run 004_powermap_schema.sql';
  end if;
  raise notice 'OK: public PowerMap leftovers cleaned. powermap schema is intact.';
end $$;

notify pgrst, 'reload schema';
