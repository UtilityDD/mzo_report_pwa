-- Atomic admin update: one substation (+ transformers) and optional line patches.
-- Run after 004 + 006. Client calls public.pm_admin_update_substation_bundle via RPC.

create or replace function powermap.admin_update_substation_bundle(
  p_ss jsonb,
  p_transformers jsonb default '[]'::jsonb,
  p_lines jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = powermap, public
as $$
declare
  v_ss_id uuid;
  v_voltage_id uuid;
  t jsonb;
  ln jsonb;
  v_line_voltage_id uuid;
  updated_lines int := 0;
begin
  v_ss_id := (p_ss->>'id')::uuid;
  if v_ss_id is null then
    raise exception 'substation id required';
  end if;

  select id into v_voltage_id
  from powermap.voltage_levels
  where code = p_ss->>'voltageCode';
  if v_voltage_id is null then
    raise exception 'unknown voltage %', p_ss->>'voltageCode';
  end if;

  update powermap.assets set
    name = coalesce(p_ss->>'name', name),
    status = coalesce((p_ss->>'status')::powermap.asset_lifecycle, status),
    org_unit_id = nullif(p_ss->>'orgUnitId', '')::uuid,
    commission_year = nullif(p_ss->>'commissionYear', '')::int,
    proposal_ref = nullif(p_ss->>'proposalRef', ''),
    remarks = coalesce(p_ss->>'remarks', remarks),
    loading_pct = nullif(p_ss->>'loadingPct', '')::numeric,
    owner = coalesce(p_ss->>'owner', owner),
    is_deleted = false,
    version = version + 1
  where id = v_ss_id and asset_kind = 'substation';

  if not found then
    insert into powermap.assets (
      id, asset_kind, name, status, org_unit_id, commission_year,
      proposal_ref, remarks, loading_pct, owner, is_deleted
    ) values (
      v_ss_id,
      'substation',
      coalesce(p_ss->>'name', 'Substation'),
      coalesce((p_ss->>'status')::powermap.asset_lifecycle, 'existing'),
      nullif(p_ss->>'orgUnitId', '')::uuid,
      nullif(p_ss->>'commissionYear', '')::int,
      nullif(p_ss->>'proposalRef', ''),
      coalesce(p_ss->>'remarks', ''),
      nullif(p_ss->>'loadingPct', '')::numeric,
      coalesce(p_ss->>'owner', ''),
      false
    );
  end if;

  insert into powermap.substations (asset_id, voltage_level_id, lat, lng)
  values (
    v_ss_id,
    v_voltage_id,
    (p_ss->>'lat')::double precision,
    (p_ss->>'lng')::double precision
  )
  on conflict (asset_id) do update set
    voltage_level_id = excluded.voltage_level_id,
    lat = excluded.lat,
    lng = excluded.lng;

  delete from powermap.transformers where substation_asset_id = v_ss_id;
  for t in select * from jsonb_array_elements(coalesce(p_transformers, '[]'::jsonb))
  loop
    insert into powermap.transformers (id, substation_asset_id, rating_mva, quantity, sequence)
    values (
      coalesce((t->>'id')::uuid, gen_random_uuid()),
      v_ss_id,
      (t->>'ratingMva')::numeric,
      coalesce((t->>'quantity')::int, 1),
      coalesce((t->>'sequence')::int, 1)
    );
  end loop;

  for ln in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    select id into v_line_voltage_id
    from powermap.voltage_levels
    where code = ln->>'voltageCode';

    update powermap.assets set
      name = coalesce(ln->>'name', name),
      status = coalesce((ln->>'status')::powermap.asset_lifecycle, status),
      loading_pct = nullif(ln->>'loadingPct', '')::numeric,
      remarks = coalesce(ln->>'remarks', remarks),
      version = version + 1,
      is_deleted = false
    where id = (ln->>'id')::uuid and asset_kind = 'line';

    if found and v_line_voltage_id is not null then
      update powermap.lines set
        voltage_level_id = v_line_voltage_id,
        conductor = coalesce(ln->>'conductor', conductor)
      where asset_id = (ln->>'id')::uuid;
      updated_lines := updated_lines + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'substationId', v_ss_id,
    'linesUpdated', updated_lines
  );
end;
$$;

create or replace function public.pm_admin_update_substation_bundle(
  p_ss jsonb,
  p_transformers jsonb default '[]'::jsonb,
  p_lines jsonb default '[]'::jsonb
)
returns jsonb
language sql
security definer
set search_path = public, powermap
as $$
  select powermap.admin_update_substation_bundle(p_ss, p_transformers, p_lines);
$$;

grant execute on function public.pm_admin_update_substation_bundle(jsonb, jsonb, jsonb)
  to anon, authenticated, service_role;
grant execute on function powermap.admin_update_substation_bundle(jsonb, jsonb, jsonb)
  to anon, authenticated, service_role;
