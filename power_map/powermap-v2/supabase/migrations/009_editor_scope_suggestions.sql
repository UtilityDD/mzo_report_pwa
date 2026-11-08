-- Editor scope (SS + districts) and suggested edits for super-admin review.

alter table powermap.editors
  add column if not exists allowed_substation_ids uuid[] not null default '{}',
  add column if not exists allowed_districts text[] not null default '{}';

comment on column powermap.editors.allowed_substation_ids is
  'Substations this editor may edit (plus each SS connected network).';
comment on column powermap.editors.allowed_districts is
  'District names (boundary layer). All SS currently inside these districts are editable.';

create table if not exists powermap.edit_suggestions (
  id uuid primary key default gen_random_uuid(),
  editor_id uuid references powermap.editors(id) on delete set null,
  editor_name text not null,
  action text not null check (action in ('update', 'create', 'delete')),
  asset_kind text not null check (asset_kind in ('substation', 'line', 'tap_node', 'tap_lateral')),
  asset_id uuid,
  summary text not null default '',
  payload jsonb not null default '{}'::jsonb,
  lat double precision,
  lng double precision,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text
);

create index if not exists edit_suggestions_status_idx
  on powermap.edit_suggestions (status, created_at desc);

alter table powermap.edit_suggestions enable row level security;

drop policy if exists "pm suggestions all" on powermap.edit_suggestions;
create policy "pm suggestions all" on powermap.edit_suggestions
  for all using (true) with check (true);

grant select, insert, update, delete on powermap.edit_suggestions to anon, authenticated, service_role;

-- Refresh public bridge views
create or replace view public.pm_editors as
  select * from powermap.editors;

create or replace view public.pm_edit_suggestions as
  select * from powermap.edit_suggestions;

grant select, insert, update, delete on public.pm_editors to anon, authenticated, service_role;
grant select, insert, update, delete on public.pm_edit_suggestions to anon, authenticated, service_role;
