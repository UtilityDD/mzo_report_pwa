-- PowerMap V2 → dedicated schema "powermap"
-- 1) Removes ONLY PowerMap leftovers from public
-- 2) Creates all PowerMap objects under schema powermap
-- Does NOT delete other projects' tables

create extension if not exists postgis with schema extensions;
create extension if not exists "pgcrypto" with schema extensions;

-- ═══════════════════════════════════════════════════════════
-- A. Clean PowerMap leftovers from public (safe checks)
-- ═══════════════════════════════════════════════════════════

drop view if exists public.v_tap_laterals cascade;
drop view if exists public.v_tap_nodes cascade;
drop view if exists public.v_lines cascade;
drop view if exists public.v_substations cascade;

do $$
begin
  -- tap_laterals (PowerMap)
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tap_laterals' and column_name = 'from_tap_asset_id'
  ) then
    execute 'drop table public.tap_laterals cascade';
  end if;

  -- tap_nodes (PowerMap)
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tap_nodes' and column_name = 'parent_line_asset_id'
  ) then
    execute 'drop table public.tap_nodes cascade';
  end if;

  -- transformers (PowerMap shape)
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'transformers' and column_name = 'substation_asset_id'
  ) then
    execute 'drop table public.transformers cascade';
  end if;

  -- lines (only if PowerMap shape: asset_id + from_asset_id)
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'lines' and column_name = 'from_asset_id'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'lines' and column_name = 'asset_id'
  ) then
    execute 'drop table public.lines cascade';
  end if;

  -- substations (PowerMap)
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'substations' and column_name = 'asset_id'
  ) then
    execute 'drop table public.substations cascade';
  end if;

  -- assets (PowerMap: has asset_kind)
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'assets' and column_name = 'asset_kind'
  ) then
    execute 'drop table public.assets cascade';
  end if;

  -- voltage_levels (PowerMap: has kv_primary)
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'voltage_levels' and column_name = 'kv_primary'
  ) then
    execute 'drop table public.voltage_levels cascade';
  end if;

  -- org_units: only drop if PowerMap-shaped (ae_tech_name) AND contains our seed id
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'org_units' and column_name = 'ae_tech_name'
  ) then
    if exists (
      select 1
      from public.org_units
      where id = '11111111-1111-1111-1111-111111111101'
    ) then
      execute 'drop table public.org_units cascade';
    end if;
  end if;
end $$;

-- PowerMap helper functions in public (do NOT drop generic names used by other apps)
drop function if exists public.on_substation_moved() cascade;
drop function if exists public.rebuild_line_geom(uuid) cascade;
drop function if exists public.sync_tap_node_geom() cascade;
drop function if exists public.sync_substation_geom() cascade;
-- NOTE: public.set_updated_at() left alone — other projects may use it

-- Drop PowerMap enums from public only if nothing else depends on them
do $$
begin
  begin
    drop type if exists public.tap_target_kind cascade;
  exception when dependent_objects_still_exist then null;
  end;
  begin
    drop type if exists public.circuit_config cascade;
  exception when dependent_objects_still_exist then null;
  end;
  begin
    drop type if exists public.asset_lifecycle cascade;
  exception when dependent_objects_still_exist then null;
  end;
  begin
    drop type if exists public.org_unit_type cascade;
  exception when dependent_objects_still_exist then null;
  end;
  -- app_role may be used by other apps — only drop if unused
  begin
    drop type if exists public.app_role cascade;
  exception when dependent_objects_still_exist then null;
  end;
end $$;

-- ═══════════════════════════════════════════════════════════
-- B. Create schema powermap (fresh)
-- ═══════════════════════════════════════════════════════════

drop schema if exists powermap cascade;
create schema powermap;

grant usage on schema powermap to postgres, anon, authenticated, service_role;

-- Enums inside powermap
create type powermap.asset_lifecycle as enum ('proposed', 'existing', 'retired');
create type powermap.org_unit_type as enum ('zone', 'region', 'division', 'ccc');
create type powermap.circuit_config as enum ('single', 'double');
create type powermap.tap_target_kind as enum ('substation', 'tap_node');
create type powermap.app_role as enum ('viewer', 'editor', 'planner', 'approver', 'admin');

create table powermap.org_units (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references powermap.org_units(id) on delete set null,
  type powermap.org_unit_type not null,
  name text not null,
  code text unique,
  ae_tech_name text,
  phone text,
  created_at timestamptz not null default now()
);

create table powermap.voltage_levels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null,
  kv_primary numeric not null,
  kv_secondary numeric,
  color text not null,
  sort_order int not null default 0
);

create table powermap.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role powermap.app_role not null default 'viewer',
  org_unit_id uuid references powermap.org_units(id),
  created_at timestamptz not null default now()
);

create table powermap.assets (
  id uuid primary key default gen_random_uuid(),
  asset_kind text not null check (asset_kind in ('substation', 'line', 'tap_node', 'tap_lateral')),
  name text not null,
  status powermap.asset_lifecycle not null default 'existing',
  org_unit_id uuid references powermap.org_units(id),
  commission_year int,
  proposal_ref text,
  remarks text,
  loading_pct numeric,
  owner text,
  version int not null default 1,
  is_deleted boolean not null default false,
  created_by uuid references powermap.profiles(id),
  updated_by uuid references powermap.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index assets_kind_idx on powermap.assets(asset_kind) where not is_deleted;
create index assets_status_idx on powermap.assets(status) where not is_deleted;
create index assets_name_idx on powermap.assets using gin (to_tsvector('english', name));

create table powermap.substations (
  asset_id uuid primary key references powermap.assets(id) on delete cascade,
  voltage_level_id uuid not null references powermap.voltage_levels(id),
  lat double precision not null,
  lng double precision not null,
  geom extensions.geography(Point, 4326)
);

create index substations_geom_idx on powermap.substations using gist (geom);

create table powermap.transformers (
  id uuid primary key default gen_random_uuid(),
  substation_asset_id uuid not null references powermap.substations(asset_id) on delete cascade,
  rating_mva numeric not null check (rating_mva > 0),
  quantity int not null default 1 check (quantity > 0),
  sequence int not null default 1
);

create table powermap.lines (
  asset_id uuid primary key references powermap.assets(id) on delete cascade,
  voltage_level_id uuid not null references powermap.voltage_levels(id),
  from_asset_id uuid not null references powermap.substations(asset_id),
  to_asset_id uuid not null references powermap.substations(asset_id),
  circuit_count int not null default 1 check (circuit_count >= 1),
  circuit_config powermap.circuit_config not null default 'single',
  conductor text,
  length_km numeric,
  geom extensions.geography(LineString, 4326),
  check (from_asset_id <> to_asset_id)
);

create index lines_geom_idx on powermap.lines using gist (geom);
create index lines_endpoints_idx on powermap.lines(from_asset_id, to_asset_id);

create table powermap.tap_nodes (
  asset_id uuid primary key references powermap.assets(id) on delete cascade,
  parent_line_asset_id uuid not null references powermap.lines(asset_id) on delete cascade,
  position_ratio numeric not null check (position_ratio > 0 and position_ratio < 1),
  lat double precision not null,
  lng double precision not null,
  geom extensions.geography(Point, 4326)
);

create index tap_nodes_parent_idx on powermap.tap_nodes(parent_line_asset_id);
create index tap_nodes_geom_idx on powermap.tap_nodes using gist (geom);

create table powermap.tap_laterals (
  asset_id uuid primary key references powermap.assets(id) on delete cascade,
  voltage_level_id uuid not null references powermap.voltage_levels(id),
  from_tap_asset_id uuid not null references powermap.tap_nodes(asset_id) on delete cascade,
  to_kind powermap.tap_target_kind not null,
  to_asset_id uuid not null references powermap.assets(id),
  conductor text,
  length_km numeric,
  geom extensions.geography(LineString, 4326)
);

create index tap_laterals_geom_idx on powermap.tap_laterals using gist (geom);

-- Triggers
create or replace function powermap.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.version = old.version + 1;
  return new;
end;
$$;

create trigger assets_updated_at
  before update on powermap.assets
  for each row execute function powermap.set_updated_at();

create or replace function powermap.sync_substation_geom()
returns trigger
language plpgsql
as $$
begin
  new.geom := extensions.st_setsrid(extensions.st_makepoint(new.lng, new.lat), 4326)::extensions.geography;
  return new;
end;
$$;

create trigger substations_geom_sync
  before insert or update of lat, lng on powermap.substations
  for each row execute function powermap.sync_substation_geom();

create or replace function powermap.sync_tap_node_geom()
returns trigger
language plpgsql
as $$
begin
  new.geom := extensions.st_setsrid(extensions.st_makepoint(new.lng, new.lat), 4326)::extensions.geography;
  return new;
end;
$$;

create trigger tap_nodes_geom_sync
  before insert or update of lat, lng on powermap.tap_nodes
  for each row execute function powermap.sync_tap_node_geom();

create or replace function powermap.rebuild_line_geom(p_line_id uuid)
returns void
language plpgsql
as $$
declare
  a powermap.substations%rowtype;
  b powermap.substations%rowtype;
  ln powermap.lines%rowtype;
begin
  select * into ln from powermap.lines where asset_id = p_line_id;
  select * into a from powermap.substations where asset_id = ln.from_asset_id;
  select * into b from powermap.substations where asset_id = ln.to_asset_id;
  update powermap.lines
    set geom = extensions.st_setsrid(extensions.st_makeline(
      extensions.st_makepoint(a.lng, a.lat),
      extensions.st_makepoint(b.lng, b.lat)
    ), 4326)::extensions.geography,
    length_km = extensions.st_distance(
      extensions.st_setsrid(extensions.st_makepoint(a.lng, a.lat), 4326)::extensions.geography,
      extensions.st_setsrid(extensions.st_makepoint(b.lng, b.lat), 4326)::extensions.geography
    ) / 1000.0
  where asset_id = p_line_id;
end;
$$;

create or replace function powermap.on_substation_moved()
returns trigger
language plpgsql
as $$
declare
  r record;
begin
  for r in
    select asset_id from powermap.lines
    where from_asset_id = new.asset_id or to_asset_id = new.asset_id
  loop
    perform powermap.rebuild_line_geom(r.asset_id);
  end loop;
  return new;
end;
$$;

create trigger substation_moved
  after update of lat, lng on powermap.substations
  for each row execute function powermap.on_substation_moved();

-- Seed
insert into powermap.voltage_levels (code, label, kv_primary, kv_secondary, color, sort_order)
values
  ('400', '400 kV', 400, 220, '#ef4444', 1),
  ('220', '220 kV', 220, 132, '#f59e0b', 2),
  ('132', '132 kV', 132, 33,  '#22c55e', 3),
  ('33',  '33 kV',  33,  11,  '#3b82f6', 4);

insert into powermap.org_units (id, parent_id, type, name, code)
values
  ('11111111-1111-1111-1111-111111111101', null, 'zone', 'Malda Zone', 'MZO');

insert into powermap.org_units (id, parent_id, type, name, code)
values
  ('11111111-1111-1111-1111-111111111102', '11111111-1111-1111-1111-111111111101', 'region', 'Malda Region', 'MLD-R');

insert into powermap.org_units (id, parent_id, type, name, code)
values
  ('11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111102', 'division', 'Malda', 'MLD'),
  ('11111111-1111-1111-1111-111111111112', '11111111-1111-1111-1111-111111111102', 'division', 'Raiganj', 'RGJ'),
  ('11111111-1111-1111-1111-111111111113', '11111111-1111-1111-1111-111111111102', 'division', 'Balurghat', 'BLG'),
  ('11111111-1111-1111-1111-111111111114', '11111111-1111-1111-1111-111111111102', 'division', 'Buniadpur', 'BNP'),
  ('11111111-1111-1111-1111-111111111115', '11111111-1111-1111-1111-111111111102', 'division', 'Gazole', 'GZL'),
  ('11111111-1111-1111-1111-111111111116', '11111111-1111-1111-1111-111111111102', 'division', 'Islampur', 'ISL'),
  ('11111111-1111-1111-1111-111111111117', '11111111-1111-1111-1111-111111111102', 'division', 'Chanchal', 'CHC');

-- Views
create view powermap.v_substations as
select
  a.id, a.name, a.status, a.org_unit_id, a.commission_year, a.proposal_ref,
  a.remarks, a.loading_pct, a.owner, a.version, a.created_at, a.updated_at,
  s.lat, s.lng, s.voltage_level_id,
  v.code as voltage_code, v.label as voltage_label, v.color as voltage_color,
  coalesce((select sum(t.rating_mva * t.quantity) from powermap.transformers t where t.substation_asset_id = a.id), 0) as installed_mva,
  (
    select string_agg(
      t.quantity::text || '×' || trim(trailing '.' from trim(trailing '0' from t.rating_mva::text)),
      ' + ' order by t.sequence
    )
    from powermap.transformers t where t.substation_asset_id = a.id
  ) as capacity_label,
  o.name as org_name, o.type as org_type
from powermap.assets a
join powermap.substations s on s.asset_id = a.id
join powermap.voltage_levels v on v.id = s.voltage_level_id
left join powermap.org_units o on o.id = a.org_unit_id
where a.asset_kind = 'substation' and not a.is_deleted;

create view powermap.v_lines as
select
  a.id, a.name, a.status, a.org_unit_id, a.commission_year, a.proposal_ref,
  a.remarks, a.loading_pct, a.owner, a.version, a.created_at, a.updated_at,
  l.voltage_level_id, l.from_asset_id, l.to_asset_id, l.circuit_count,
  l.circuit_config, l.conductor, l.length_km,
  v.code as voltage_code, v.label as voltage_label, v.color as voltage_color,
  sf.lat as from_lat, sf.lng as from_lng, st.lat as to_lat, st.lng as to_lng,
  af.name as from_name, at.name as to_name
from powermap.assets a
join powermap.lines l on l.asset_id = a.id
join powermap.voltage_levels v on v.id = l.voltage_level_id
join powermap.substations sf on sf.asset_id = l.from_asset_id
join powermap.substations st on st.asset_id = l.to_asset_id
join powermap.assets af on af.id = l.from_asset_id
join powermap.assets at on at.id = l.to_asset_id
where a.asset_kind = 'line' and not a.is_deleted;

create view powermap.v_tap_nodes as
select
  a.id, a.name, a.status, a.remarks, a.version,
  tn.parent_line_asset_id, tn.position_ratio, tn.lat, tn.lng,
  pl.name as parent_line_name
from powermap.assets a
join powermap.tap_nodes tn on tn.asset_id = a.id
join powermap.assets pl on pl.id = tn.parent_line_asset_id
where a.asset_kind = 'tap_node' and not a.is_deleted;

create view powermap.v_tap_laterals as
select
  a.id, a.name, a.status, a.remarks, a.loading_pct, a.commission_year,
  a.proposal_ref, a.owner, a.version,
  tl.voltage_level_id, tl.from_tap_asset_id, tl.to_kind, tl.to_asset_id,
  tl.conductor, tl.length_km,
  v.code as voltage_code, v.color as voltage_color,
  tn.lat as from_lat, tn.lng as from_lng
from powermap.assets a
join powermap.tap_laterals tl on tl.asset_id = a.id
join powermap.voltage_levels v on v.id = tl.voltage_level_id
join powermap.tap_nodes tn on tn.asset_id = tl.from_tap_asset_id
where a.asset_kind = 'tap_lateral' and not a.is_deleted;

-- RLS
alter table powermap.org_units enable row level security;
alter table powermap.voltage_levels enable row level security;
alter table powermap.assets enable row level security;
alter table powermap.substations enable row level security;
alter table powermap.transformers enable row level security;
alter table powermap.lines enable row level security;
alter table powermap.tap_nodes enable row level security;
alter table powermap.tap_laterals enable row level security;
alter table powermap.profiles enable row level security;

create policy "pm org read" on powermap.org_units for select using (true);
create policy "pm org write" on powermap.org_units for all using (true) with check (true);
create policy "pm voltage read" on powermap.voltage_levels for select using (true);
create policy "pm assets all" on powermap.assets for all using (true) with check (true);
create policy "pm substations all" on powermap.substations for all using (true) with check (true);
create policy "pm transformers all" on powermap.transformers for all using (true) with check (true);
create policy "pm lines all" on powermap.lines for all using (true) with check (true);
create policy "pm tap_nodes all" on powermap.tap_nodes for all using (true) with check (true);
create policy "pm tap_laterals all" on powermap.tap_laterals for all using (true) with check (true);
create policy "pm profiles read" on powermap.profiles for select using (true);

grant select, insert, update, delete on all tables in schema powermap to anon, authenticated, service_role;
grant select on powermap.v_substations, powermap.v_lines, powermap.v_tap_nodes, powermap.v_tap_laterals to anon, authenticated, service_role;
grant usage, select on all sequences in schema powermap to anon, authenticated, service_role;

alter default privileges in schema powermap
  grant select, insert, update, delete on tables to anon, authenticated, service_role;

notify pgrst, 'reload schema';
