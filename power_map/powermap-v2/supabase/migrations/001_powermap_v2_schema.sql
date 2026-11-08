-- PowerMap V2 schema (idempotent / safe to re-run)
-- Run this in Supabase SQL Editor

-- PostGIS (Supabase usually keeps extensions in "extensions")
create extension if not exists postgis with schema extensions;
create extension if not exists "pgcrypto" with schema extensions;

-- Ensure geography/geometry types are visible
set search_path to public, extensions;

-- ─── Enums ───────────────────────────────────────────────
do $$ begin
  create type asset_lifecycle as enum ('proposed', 'existing', 'retired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type org_unit_type as enum ('zone', 'region', 'division', 'ccc');
exception when duplicate_object then null; end $$;

do $$ begin
  create type circuit_config as enum ('single', 'double');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tap_target_kind as enum ('substation', 'tap_node');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app_role as enum ('viewer', 'editor', 'planner', 'approver', 'admin');
exception when duplicate_object then null; end $$;

-- ─── Org hierarchy ───────────────────────────────────────
create table if not exists org_units (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references org_units(id) on delete set null,
  type org_unit_type not null,
  name text not null,
  code text unique,
  ae_tech_name text,
  phone text,
  created_at timestamptz not null default now()
);

-- ─── Voltage catalog ─────────────────────────────────────
create table if not exists voltage_levels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null,
  kv_primary numeric not null,
  kv_secondary numeric,
  color text not null,
  sort_order int not null default 0
);

-- ─── Profiles ────────────────────────────────────────────
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role app_role not null default 'viewer',
  org_unit_id uuid references org_units(id),
  created_at timestamptz not null default now()
);

-- ─── Assets (generic shell) ──────────────────────────────
create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  asset_kind text not null check (asset_kind in ('substation', 'line', 'tap_node', 'tap_lateral')),
  name text not null,
  status asset_lifecycle not null default 'existing',
  org_unit_id uuid references org_units(id),
  commission_year int,
  proposal_ref text,
  remarks text,
  loading_pct numeric,
  owner text,
  version int not null default 1,
  is_deleted boolean not null default false,
  created_by uuid references profiles(id),
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists assets_kind_idx on assets(asset_kind) where not is_deleted;
create index if not exists assets_status_idx on assets(status) where not is_deleted;
create index if not exists assets_name_idx on assets using gin (to_tsvector('english', name));

-- ─── Substations ─────────────────────────────────────────
create table if not exists substations (
  asset_id uuid primary key references assets(id) on delete cascade,
  voltage_level_id uuid not null references voltage_levels(id),
  lat double precision not null,
  lng double precision not null
);

-- Add geom if missing (handles partial earlier runs)
alter table substations
  add column if not exists geom extensions.geography(Point, 4326);

-- ─── Transformers ────────────────────────────────────────
create table if not exists transformers (
  id uuid primary key default gen_random_uuid(),
  substation_asset_id uuid not null references substations(asset_id) on delete cascade,
  rating_mva numeric not null check (rating_mva > 0),
  quantity int not null default 1 check (quantity > 0),
  sequence int not null default 1
);

-- ─── Trunk lines (SS ↔ SS) ────────────────────────────────
create table if not exists lines (
  asset_id uuid primary key references assets(id) on delete cascade,
  voltage_level_id uuid not null references voltage_levels(id),
  from_asset_id uuid not null references substations(asset_id),
  to_asset_id uuid not null references substations(asset_id),
  circuit_count int not null default 1 check (circuit_count >= 1),
  circuit_config circuit_config not null default 'single',
  conductor text,
  length_km numeric,
  check (from_asset_id <> to_asset_id)
);

alter table lines
  add column if not exists geom extensions.geography(LineString, 4326);

-- ─── Tap nodes (point on a parent line) ──────────────────
create table if not exists tap_nodes (
  asset_id uuid primary key references assets(id) on delete cascade,
  parent_line_asset_id uuid not null references lines(asset_id) on delete cascade,
  position_ratio numeric not null check (position_ratio > 0 and position_ratio < 1),
  lat double precision not null,
  lng double precision not null
);

alter table tap_nodes
  add column if not exists geom extensions.geography(Point, 4326);

-- ─── Tap laterals (tap → SS | tap → tap) ─────────────────
create table if not exists tap_laterals (
  asset_id uuid primary key references assets(id) on delete cascade,
  voltage_level_id uuid not null references voltage_levels(id),
  from_tap_asset_id uuid not null references tap_nodes(asset_id) on delete cascade,
  to_kind tap_target_kind not null,
  to_asset_id uuid not null references assets(id),
  conductor text,
  length_km numeric
);

alter table tap_laterals
  add column if not exists geom extensions.geography(LineString, 4326);

-- Spatial indexes (only after geom columns exist)
create index if not exists substations_geom_idx on substations using gist (geom);
create index if not exists lines_geom_idx on lines using gist (geom);
create index if not exists lines_endpoints_idx on lines(from_asset_id, to_asset_id);
create index if not exists tap_nodes_parent_idx on tap_nodes(parent_line_asset_id);
create index if not exists tap_nodes_geom_idx on tap_nodes using gist (geom);
create index if not exists tap_laterals_geom_idx on tap_laterals using gist (geom);

-- ─── Updated_at helper ───────────────────────────────────
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  new.version = old.version + 1;
  return new;
end;
$$ language plpgsql;

drop trigger if exists assets_updated_at on assets;
create trigger assets_updated_at
  before update on assets
  for each row execute function set_updated_at();

-- ─── Geometry sync helpers ───────────────────────────────
create or replace function sync_substation_geom()
returns trigger
language plpgsql
as $$
begin
  new.geom := extensions.st_setsrid(extensions.st_makepoint(new.lng, new.lat), 4326)::extensions.geography;
  return new;
end;
$$;

drop trigger if exists substations_geom_sync on substations;
create trigger substations_geom_sync
  before insert or update of lat, lng on substations
  for each row execute function sync_substation_geom();

create or replace function sync_tap_node_geom()
returns trigger
language plpgsql
as $$
begin
  new.geom := extensions.st_setsrid(extensions.st_makepoint(new.lng, new.lat), 4326)::extensions.geography;
  return new;
end;
$$;

drop trigger if exists tap_nodes_geom_sync on tap_nodes;
create trigger tap_nodes_geom_sync
  before insert or update of lat, lng on tap_nodes
  for each row execute function sync_tap_node_geom();

-- Rebuild line geom from endpoints when SS moves
create or replace function rebuild_line_geom(p_line_id uuid)
returns void
language plpgsql
as $$
declare
  a substations%rowtype;
  b substations%rowtype;
  ln lines%rowtype;
begin
  select * into ln from lines where asset_id = p_line_id;
  select * into a from substations where asset_id = ln.from_asset_id;
  select * into b from substations where asset_id = ln.to_asset_id;
  update lines
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

create or replace function on_substation_moved()
returns trigger
language plpgsql
as $$
declare
  r record;
begin
  for r in
    select asset_id from lines
    where from_asset_id = new.asset_id or to_asset_id = new.asset_id
  loop
    perform rebuild_line_geom(r.asset_id);
  end loop;
  return new;
end;
$$;

drop trigger if exists substation_moved on substations;
create trigger substation_moved
  after update of lat, lng on substations
  for each row execute function on_substation_moved();

-- Backfill geom for any existing rows
update substations
set geom = extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
where geom is null;

update tap_nodes
set geom = extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
where geom is null;

-- ─── Seed voltage levels ─────────────────────────────────
insert into voltage_levels (code, label, kv_primary, kv_secondary, color, sort_order)
values
  ('400', '400 kV', 400, 220, '#ef4444', 1),
  ('220', '220 kV', 220, 132, '#f59e0b', 2),
  ('132', '132 kV', 132, 33,  '#22c55e', 3),
  ('33',  '33 kV',  33,  11,  '#3b82f6', 4)
on conflict (code) do nothing;

-- ─── Seed sample org tree (Malda Zone) ───────────────────
insert into org_units (id, parent_id, type, name, code)
values
  ('11111111-1111-1111-1111-111111111101', null, 'zone', 'Malda Zone', 'MZO')
on conflict (id) do nothing;

insert into org_units (id, parent_id, type, name, code)
values
  ('11111111-1111-1111-1111-111111111102', '11111111-1111-1111-1111-111111111101', 'region', 'Malda Region', 'MLD-R')
on conflict (id) do nothing;

insert into org_units (id, parent_id, type, name, code)
values
  ('11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111102', 'division', 'Malda', 'MLD'),
  ('11111111-1111-1111-1111-111111111112', '11111111-1111-1111-1111-111111111102', 'division', 'Raiganj', 'RGJ'),
  ('11111111-1111-1111-1111-111111111113', '11111111-1111-1111-1111-111111111102', 'division', 'Balurghat', 'BLG'),
  ('11111111-1111-1111-1111-111111111114', '11111111-1111-1111-1111-111111111102', 'division', 'Buniadpur', 'BNP'),
  ('11111111-1111-1111-1111-111111111115', '11111111-1111-1111-1111-111111111102', 'division', 'Gazole', 'GZL'),
  ('11111111-1111-1111-1111-111111111116', '11111111-1111-1111-1111-111111111102', 'division', 'Islampur', 'ISL'),
  ('11111111-1111-1111-1111-111111111117', '11111111-1111-1111-1111-111111111102', 'division', 'Chanchal', 'CHC')
on conflict (id) do nothing;

-- ─── Views for the app ───────────────────────────────────
create or replace view v_substations as
select
  a.id,
  a.name,
  a.status,
  a.org_unit_id,
  a.commission_year,
  a.proposal_ref,
  a.remarks,
  a.loading_pct,
  a.owner,
  a.version,
  a.created_at,
  a.updated_at,
  s.lat,
  s.lng,
  s.voltage_level_id,
  v.code as voltage_code,
  v.label as voltage_label,
  v.color as voltage_color,
  coalesce((
    select sum(t.rating_mva * t.quantity)
    from transformers t where t.substation_asset_id = a.id
  ), 0) as installed_mva,
  (
    select string_agg(t.quantity::text || '×' || trim(trailing '.' from trim(trailing '0' from t.rating_mva::text)), ' + ' order by t.sequence)
    from transformers t where t.substation_asset_id = a.id
  ) as capacity_label,
  o.name as org_name,
  o.type as org_type
from assets a
join substations s on s.asset_id = a.id
join voltage_levels v on v.id = s.voltage_level_id
left join org_units o on o.id = a.org_unit_id
where a.asset_kind = 'substation' and not a.is_deleted;

create or replace view v_lines as
select
  a.id,
  a.name,
  a.status,
  a.org_unit_id,
  a.commission_year,
  a.proposal_ref,
  a.remarks,
  a.loading_pct,
  a.owner,
  a.version,
  a.created_at,
  a.updated_at,
  l.voltage_level_id,
  l.from_asset_id,
  l.to_asset_id,
  l.circuit_count,
  l.circuit_config,
  l.conductor,
  l.length_km,
  v.code as voltage_code,
  v.label as voltage_label,
  v.color as voltage_color,
  sf.lat as from_lat,
  sf.lng as from_lng,
  st.lat as to_lat,
  st.lng as to_lng,
  af.name as from_name,
  at.name as to_name
from assets a
join lines l on l.asset_id = a.id
join voltage_levels v on v.id = l.voltage_level_id
join substations sf on sf.asset_id = l.from_asset_id
join substations st on st.asset_id = l.to_asset_id
join assets af on af.id = l.from_asset_id
join assets at on at.id = l.to_asset_id
where a.asset_kind = 'line' and not a.is_deleted;

create or replace view v_tap_nodes as
select
  a.id,
  a.name,
  a.status,
  a.remarks,
  a.version,
  tn.parent_line_asset_id,
  tn.position_ratio,
  tn.lat,
  tn.lng,
  pl.name as parent_line_name
from assets a
join tap_nodes tn on tn.asset_id = a.id
join assets pl on pl.id = tn.parent_line_asset_id
where a.asset_kind = 'tap_node' and not a.is_deleted;

create or replace view v_tap_laterals as
select
  a.id,
  a.name,
  a.status,
  a.remarks,
  a.loading_pct,
  a.commission_year,
  a.proposal_ref,
  a.owner,
  a.version,
  tl.voltage_level_id,
  tl.from_tap_asset_id,
  tl.to_kind,
  tl.to_asset_id,
  tl.conductor,
  tl.length_km,
  v.code as voltage_code,
  v.color as voltage_color,
  tn.lat as from_lat,
  tn.lng as from_lng
from assets a
join tap_laterals tl on tl.asset_id = a.id
join voltage_levels v on v.id = tl.voltage_level_id
join tap_nodes tn on tn.asset_id = tl.from_tap_asset_id
where a.asset_kind = 'tap_lateral' and not a.is_deleted;

-- ─── RLS (open for anon during MVP; tighten with auth later) ─
alter table org_units enable row level security;
alter table voltage_levels enable row level security;
alter table assets enable row level security;
alter table substations enable row level security;
alter table transformers enable row level security;
alter table lines enable row level security;
alter table tap_nodes enable row level security;
alter table tap_laterals enable row level security;
alter table profiles enable row level security;

drop policy if exists "public read org" on org_units;
create policy "public read org" on org_units for select using (true);
drop policy if exists "public write org" on org_units;
create policy "public write org" on org_units for all using (true) with check (true);

drop policy if exists "public read voltage" on voltage_levels;
create policy "public read voltage" on voltage_levels for select using (true);

drop policy if exists "public all assets" on assets;
create policy "public all assets" on assets for all using (true) with check (true);

drop policy if exists "public all substations" on substations;
create policy "public all substations" on substations for all using (true) with check (true);

drop policy if exists "public all transformers" on transformers;
create policy "public all transformers" on transformers for all using (true) with check (true);

drop policy if exists "public all lines" on lines;
create policy "public all lines" on lines for all using (true) with check (true);

drop policy if exists "public all tap_nodes" on tap_nodes;
create policy "public all tap_nodes" on tap_nodes for all using (true) with check (true);

drop policy if exists "public all tap_laterals" on tap_laterals;
create policy "public all tap_laterals" on tap_laterals for all using (true) with check (true);

drop policy if exists "public read profiles" on profiles;
create policy "public read profiles" on profiles for select using (true);

grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on all tables in schema public to anon, authenticated;
grant select on v_substations, v_lines, v_tap_nodes, v_tap_laterals to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
