-- Authorized editors for selective edit (name + PIN).
-- Super admin PIN stays in VITE_ADMIN_PIN (app env). Editors live here.

create table if not exists powermap.editors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pin_hash text not null,
  can_edit boolean not null default true,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint editors_name_nonempty check (length(trim(name)) > 0)
);

create unique index if not exists editors_name_lower_uidx
  on powermap.editors (lower(trim(name)))
  where active;

create unique index if not exists editors_pin_hash_uidx
  on powermap.editors (pin_hash)
  where active;

alter table powermap.editors enable row level security;

drop policy if exists "pm editors all" on powermap.editors;
create policy "pm editors all" on powermap.editors for all using (true) with check (true);

grant select, insert, update, delete on powermap.editors to anon, authenticated, service_role;

create or replace view public.pm_editors as
  select * from powermap.editors;

grant select, insert, update, delete on public.pm_editors to anon, authenticated, service_role;
