-- Kvisa 011: walk-up tablet (kiosk) for meshulachim
-- A "kiosk" login runs on the tablet. It can do exactly one thing: submit a laundry request
-- through kiosk_submit(). It cannot read clients, orders or anything else (no RLS policy grants it).
-- Each request finds or creates the client by phone number and opens a normal order.

-- ---------------------------------------------------------------
-- New role
-- ---------------------------------------------------------------
alter table public.user_roles drop constraint user_roles_role_check;
alter table public.user_roles add constraint user_roles_role_check
  check (role in ('admin','dispatcher','driver','volunteer','kiosk'));
alter table public.invites drop constraint invites_roles_check;
alter table public.invites add constraint invites_roles_check
  check (roles <@ array['admin','dispatcher','driver','volunteer','kiosk']::text[] and cardinality(roles) > 0);

create or replace function public.set_user_roles(p_user_id uuid, p_roles text[], p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if not public.is_admin() then raise exception 'KVISA_FORBIDDEN: only administrators can change roles' using errcode='42501'; end if;
  if p_roles is null or not (p_roles <@ array['admin','dispatcher','driver','volunteer','kiosk']::text[]) then
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

-- ---------------------------------------------------------------
-- Settings and order columns
-- ---------------------------------------------------------------
alter table public.organization_settings
  add column kiosk_category_id text references public.client_categories(id),
  add column kiosk_max_bags integer not null default 20 check (kiosk_max_bags between 1 and 100),
  add column label_size text not null default '4x6' check (label_size in ('4x6','62mm','2.25x1.25','letter'));
update public.organization_settings set kiosk_category_id = 'meshilach'
  where exists (select 1 from public.client_categories where id = 'meshilach');
update public.organization_settings
  set notify_kinds = notify_kinds || array['kiosk_request']
  where not ('kiosk_request' = any(notify_kinds));
alter table public.organization_settings alter column notify_kinds set default array[
  'assigned','reassigned','schedule_changed','upcoming','overdue',
  'washing_completed','return_ready','delivered','exception','offer','kiosk_request'];

alter table public.orders
  add column source text not null default 'office' check (source in ('office','kiosk')),
  add column request_key uuid unique;   -- set by the tablet so a double tap never creates two orders

-- Phone numbers are matched on their last 9 digits, so 052-123-4567 and +972 52-123-4567 are the same person.
create or replace function public.phone_key(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 9), '')
$$;
create index clients_phone_key_idx on public.clients (public.phone_key(phone));

-- ---------------------------------------------------------------
-- kiosk_submit: the only thing the tablet can do
-- ---------------------------------------------------------------
create or replace function public.kiosk_submit(p_name text, p_phone text, p_bags integer,
  p_request_key uuid, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s organization_settings%rowtype := public._settings();
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_phone text := trim(coalesce(p_phone, ''));
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_cat client_categories%rowtype;
  c clients%rowtype;
  v_returning boolean := true;
  v_order uuid; v_no bigint;
  v_pickup_at timestamptz;
begin
  if not (public.has_role('kiosk') or public.is_staff()) then
    raise exception 'KVISA_FORBIDDEN: this device is not set up as a tablet' using errcode = '42501';
  end if;
  if p_request_key is null then raise exception 'KVISA_VALIDATION: missing request key'; end if;

  -- Same request sent twice (double tap, flaky Wi-Fi): return the order already made.
  select o.id, o.order_no into v_order, v_no from orders o where o.request_key = p_request_key;
  if found then
    return (select jsonb_build_object('order_no', o.order_no, 'name', o.pickup_contact, 'phone', o.pickup_phone,
              'bags', o.expected_bags, 'created_at', o.created_at, 'returning', true, 'repeat', true)
            from orders o where o.id = v_order);
  end if;

  if length(v_name) < 2 or length(v_name) > 80 then raise exception 'KVISA_VALIDATION: enter your name'; end if;
  if length(v_digits) < 7 or length(v_digits) > 15 then raise exception 'KVISA_VALIDATION: enter a valid phone number'; end if;
  if p_bags is null or p_bags < 1 or p_bags > s.kiosk_max_bags then
    raise exception 'KVISA_VALIDATION: number of bags must be from 1 to %', s.kiosk_max_bags;
  end if;
  if length(coalesce(v_notes, '')) > 300 then raise exception 'KVISA_VALIDATION: the note is too long'; end if;

  -- Simple flood guard for the unattended tablet.
  if (select count(*) from orders where source = 'kiosk' and created_by = auth.uid()
        and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'KVISA_VALIDATION: too many requests from this tablet. Please ask the office';
  end if;

  select * into v_cat from client_categories where id = s.kiosk_category_id and active;
  if not found then
    select * into v_cat from client_categories where active order by sort_order limit 1;
  end if;

  perform public._wf(null, 'Entered on the tablet');

  -- Find the client by phone: prefer active, then the tablet's category, then the most recently used.
  select cl.* into c from clients cl
   where public.phone_key(cl.phone) = public.phone_key(v_digits)
   order by cl.active desc, (cl.category_id = v_cat.id) desc,
            (select max(o.created_at) from orders o where o.client_id = cl.id) desc nulls last, cl.created_at desc
   limit 1;
  if not found then
    v_returning := false;
    insert into clients (name, category_id, primary_contact, phone, pickup_address, access_instructions)
    values (v_name, v_cat.id, v_name, v_phone, coalesce(v_cat.default_pickup_address, s.org_address), v_cat.default_pickup_note)
    returning * into c;
  elsif not c.active then
    update clients set active = true where id = c.id;
  end if;

  v_pickup_at := greatest(now(), public._local_ts(public._today(), s.default_pickup_time));
  v_order := public._create_order(jsonb_build_object(
    'client_id', c.id, 'expected_bags', p_bags, 'pickup_contact', v_name, 'pickup_phone', v_phone,
    'pickup_address', coalesce(c.pickup_address, v_cat.default_pickup_address, s.org_address),
    'pickup_at', v_pickup_at, 'notes', v_notes));
  update orders set source = 'kiosk', request_key = p_request_key where id = v_order returning order_no into v_no;

  perform public._notify_staff('kiosk_request', format('New tablet request — order K-%s', v_no),
    format('%s · %s bag(s)%s', v_name, p_bags, case when v_returning then '' else ' · new client' end),
    v_order, null);

  return jsonb_build_object('order_no', v_no, 'name', v_name, 'phone', v_phone, 'bags', p_bags,
    'created_at', now(), 'returning', v_returning, 'repeat', false);
end $$;

revoke execute on function public.kiosk_submit(text, text, integer, uuid, text) from public, anon;
grant execute on function public.kiosk_submit(text, text, integer, uuid, text) to authenticated;
revoke execute on function public.phone_key(text) from public, anon;
grant execute on function public.phone_key(text) to authenticated;
