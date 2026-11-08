-- Quick fix only: add missing geom columns after a failed first run
-- Prefer re-running the full updated 001_powermap_v2_schema.sql instead.

create extension if not exists postgis with schema extensions;
set search_path to public, extensions;

alter table if exists substations
  add column if not exists geom extensions.geography(Point, 4326);

alter table if exists lines
  add column if not exists geom extensions.geography(LineString, 4326);

alter table if exists tap_nodes
  add column if not exists geom extensions.geography(Point, 4326);

alter table if exists tap_laterals
  add column if not exists geom extensions.geography(LineString, 4326);

create index if not exists substations_geom_idx on substations using gist (geom);
create index if not exists lines_geom_idx on lines using gist (geom);
create index if not exists tap_nodes_geom_idx on tap_nodes using gist (geom);
create index if not exists tap_laterals_geom_idx on tap_laterals using gist (geom);

update substations
set geom = extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
where geom is null and lat is not null and lng is not null;

update tap_nodes
set geom = extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
where geom is null and lat is not null and lng is not null;
