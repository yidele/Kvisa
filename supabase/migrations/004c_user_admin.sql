-- Kvisa 004c: user administration
-- Roles are deactivated rather than deleted so role history is kept.

alter table public.user_roles add column active boolean not null default true;

create or replace function public.has_role(p_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_roles ur join profiles p on p.id = ur.user_id
    where ur.user_id = auth.uid() and ur.role = p_role and ur.active and p.active
  );
$$;

create or replace function public._notify_staff(p_kind text, p_title text, p_body text,
  p_order uuid, p_task uuid, p_dedupe text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select distinct p.id from profiles p join user_roles ur on ur.user_id = p.id
           where p.active and ur.active and ur.role in ('admin','dispatcher') and p.id is distinct from auth.uid()
  loop
    perform public._notify_user(r.id, p_kind, p_title, p_body, p_order, p_task, p_dedupe);
  end loop;
end $$;

create or replace function public.invite_user(p_email text, p_roles text[], p_person_id uuid default null, p_full_name text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email));
begin
  if not public.is_admin() then raise exception 'KVISA_FORBIDDEN: only administrators can invite users' using errcode='42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'KVISA_VALIDATION: enter a valid email address'; end if;
  if p_roles is null or cardinality(p_roles) = 0 then raise exception 'KVISA_VALIDATION: choose at least one role'; end if;
  if ('driver' = any(p_roles) or 'volunteer' = any(p_roles)) and p_person_id is null then
    raise exception 'KVISA_VALIDATION: link drivers and washing volunteers to their person record';
  end if;
  if exists (select 1 from profiles where email = v_email) then raise exception 'KVISA_VALIDATION: this email already has an account'; end if;
  insert into invites (email, roles, person_id, full_name, invited_by)
    values (v_email, p_roles, p_person_id, nullif(trim(p_full_name),''), auth.uid())
  on conflict (email) do update set roles = excluded.roles, person_id = excluded.person_id,
    full_name = excluded.full_name, invited_by = excluded.invited_by, used_at = null, created_at = now();
end $$;

create or replace function public.set_user_roles(p_user_id uuid, p_roles text[], p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if not public.is_admin() then raise exception 'KVISA_FORBIDDEN: only administrators can change roles' using errcode='42501'; end if;
  if p_roles is null or not (p_roles <@ array['admin','dispatcher','driver','volunteer']::text[]) then
    raise exception 'KVISA_VALIDATION: unknown role';
  end if;
  if not ('admin' = any(p_roles)) and exists (select 1 from user_roles where user_id = p_user_id and role = 'admin' and active)
     and (select count(*) from user_roles ur join profiles p on p.id = ur.user_id where ur.role = 'admin' and ur.active and p.active) <= 1 then
    raise exception 'KVISA_VALIDATION: there must always be at least one administrator';
  end if;
  if ('driver' = any(p_roles) or 'volunteer' = any(p_roles)) and (select person_id from profiles where id = p_user_id) is null then
    raise exception 'KVISA_VALIDATION: link this user to a person record before giving a driver or volunteer role';
  end if;
  perform public._wf('user.roles_changed', p_reason);
  update user_roles set active = (role = any(p_roles)) where user_id = p_user_id and active is distinct from (role = any(p_roles));
  foreach r in array p_roles loop
    insert into user_roles (user_id, role, granted_by) values (p_user_id, r, auth.uid())
      on conflict (user_id, role) do update set active = true, granted_by = excluded.granted_by, granted_at = now()
      where user_roles.active = false;
  end loop;
end $$;

create or replace function public.set_user_active(p_user_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'KVISA_FORBIDDEN: only administrators can do this' using errcode='42501'; end if;
  if p_user_id = auth.uid() and not p_active then raise exception 'KVISA_VALIDATION: you cannot deactivate yourself'; end if;
  perform public._wf(case when p_active then 'user.activated' else 'user.deactivated' end, null);
  update profiles set active = p_active where id = p_user_id;
end $$;

create or replace function public.my_context()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'user_id', p.id, 'email', p.email, 'full_name', p.full_name, 'active', p.active, 'person_id', p.person_id,
    'roles', coalesce((select jsonb_agg(role order by role) from user_roles where user_id = p.id and active), '[]'::jsonb),
    'settings', (select to_jsonb(s) from organization_settings s where id = 1))
  from profiles p where p.id = auth.uid()
$$;

-- Lets the sign-in page tell people whether they need an invite (yes/no only).
create or replace function public.signup_allowed(p_email text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from profiles)
      or exists (select 1 from invites where email = lower(trim(p_email)) and used_at is null)
$$;
