-- Kvisa 012: tablet v2 — first/middle/last name, a phone here and a phone in Israel, and "Track my laundry".
-- Meshulachim often get a new American number each visit; the Israeli number keeps them on the same client.

alter table public.clients add column israel_phone text;
create index clients_israel_phone_key_idx on public.clients (public.phone_key(israel_phone));

drop function public.kiosk_submit(text, text, integer, uuid, text);

create or replace function public.kiosk_submit(p_first text, p_middle text, p_last text,
  p_phone text, p_israel_phone text, p_bags integer, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s organization_settings%rowtype := public._settings();
  v_first text := regexp_replace(trim(coalesce(p_first, '')), '\s+', ' ', 'g');
  v_middle text := regexp_replace(trim(coalesce(p_middle, '')), '\s+', ' ', 'g');
  v_last text := regexp_replace(trim(coalesce(p_last, '')), '\s+', ' ', 'g');
  v_name text;
  v_phone text := trim(coalesce(p_phone, ''));
  v_il text := trim(coalesce(p_israel_phone, ''));
  v_keys text[];
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
  select o.id into v_order from orders o where o.request_key = p_request_key;
  if found then
    return (select jsonb_build_object('order_no', o.order_no, 'name', o.pickup_contact, 'phone', o.pickup_phone,
              'israel_phone', cl.israel_phone, 'bags', o.expected_bags, 'created_at', o.created_at, 'returning', true, 'repeat', true)
            from orders o join clients cl on cl.id = o.client_id where o.id = v_order);
  end if;

  if length(v_first) < 1 or length(v_first) > 40 then raise exception 'KVISA_VALIDATION: enter your first name'; end if;
  if length(v_last) < 1 or length(v_last) > 40 then raise exception 'KVISA_VALIDATION: enter your last name'; end if;
  if length(v_middle) > 40 then raise exception 'KVISA_VALIDATION: the middle name is too long'; end if;
  if length(regexp_replace(v_phone, '\D', '', 'g')) not between 7 and 15 then raise exception 'KVISA_VALIDATION: enter a valid phone number'; end if;
  if length(regexp_replace(v_il, '\D', '', 'g')) not between 7 and 15 then raise exception 'KVISA_VALIDATION: enter a valid phone number in Israel'; end if;
  if p_bags is null or p_bags < 1 or p_bags > s.kiosk_max_bags then
    raise exception 'KVISA_VALIDATION: number of bags must be from 1 to %', s.kiosk_max_bags;
  end if;
  v_name := concat_ws(' ', v_first, nullif(v_middle, ''), v_last);

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

  -- Find the client by either number against either saved number.
  -- Prefer a match on the Israeli number (it doesn't change between visits), then active, then the tablet category.
  v_keys := array[public.phone_key(v_phone), public.phone_key(v_il)];
  select cl.* into c from clients cl
   where public.phone_key(cl.phone) = any(v_keys) or public.phone_key(cl.israel_phone) = any(v_keys)
   order by (public.phone_key(cl.israel_phone) = public.phone_key(v_il)) desc nulls last, cl.active desc,
            (cl.category_id = v_cat.id) desc,
            (select max(o.created_at) from orders o where o.client_id = cl.id) desc nulls last, cl.created_at desc
   limit 1;
  if not found then
    v_returning := false;
    insert into clients (name, category_id, primary_contact, phone, israel_phone, pickup_address, access_instructions)
    values (v_name, v_cat.id, v_name, v_phone, v_il, coalesce(v_cat.default_pickup_address, s.org_address), v_cat.default_pickup_note)
    returning * into c;
  else
    -- Keep the newest numbers on file; the old ones stay in the history.
    update clients set active = true, phone = v_phone, israel_phone = v_il
     where id = c.id and (not active or phone is distinct from v_phone or israel_phone is distinct from v_il)
     returning * into c;
    if not found then select * into c from clients where id = c.id; end if;
  end if;

  v_pickup_at := greatest(now(), public._local_ts(public._today(), s.default_pickup_time));
  v_order := public._create_order(jsonb_build_object(
    'client_id', c.id, 'expected_bags', p_bags, 'pickup_contact', v_name, 'pickup_phone', v_phone,
    'pickup_address', coalesce(c.pickup_address, v_cat.default_pickup_address, s.org_address),
    'pickup_at', v_pickup_at,
    'notes', case when public.phone_key(v_il) is distinct from public.phone_key(v_phone) then 'Phone in Israel: ' || v_il end));
  update orders set source = 'kiosk', request_key = p_request_key where id = v_order returning order_no into v_no;

  perform public._notify_staff('kiosk_request', format('New tablet request — order K-%s', v_no),
    format('%s · %s bag(s)%s', v_name, p_bags, case when v_returning then '' else ' · new client' end),
    v_order, null);

  return jsonb_build_object('order_no', v_no, 'name', v_name, 'phone', v_phone, 'israel_phone', v_il, 'bags', p_bags,
    'created_at', now(), 'returning', v_returning, 'repeat', false);
end $$;

-- ---------------------------------------------------------------
-- kiosk_track: "Track my laundry" — phone (either number) + first name.
-- Returns only order number, bags, a coarse stage and dates: no addresses, no people.
-- ---------------------------------------------------------------
create or replace function public.kiosk_track(p_phone text, p_first_name text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_key text := public.phone_key(p_phone);
  v_first text := lower(split_part(regexp_replace(trim(coalesce(p_first_name, '')), '\s+', ' ', 'g'), ' ', 1));
begin
  if not (public.has_role('kiosk') or public.is_staff()) then
    raise exception 'KVISA_FORBIDDEN: this device is not set up as a tablet' using errcode = '42501';
  end if;
  if v_key is null or length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) < 7 then
    raise exception 'KVISA_VALIDATION: enter a valid phone number';
  end if;
  if v_first = '' then raise exception 'KVISA_VALIDATION: enter your first name'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'order_no', o.order_no, 'bags', o.expected_bags, 'status', o.status,
             'created_at', o.created_at, 'completed_at', o.completed_at)
           order by o.created_at desc)
    from orders o join clients cl on cl.id = o.client_id
    where (public.phone_key(cl.phone) = v_key or public.phone_key(cl.israel_phone) = v_key)
      and (lower(split_part(cl.name, ' ', 1)) = v_first or lower(split_part(coalesce(o.pickup_contact, ''), ' ', 1)) = v_first)
      and (o.status not in ('completed','cancelled') or coalesce(o.completed_at, o.cancelled_at) > now() - interval '14 days')
      and o.created_at > now() - interval '120 days'
  ), '[]'::jsonb);
end $$;

revoke execute on function public.kiosk_submit(text, text, text, text, text, integer, uuid) from public, anon;
grant execute on function public.kiosk_submit(text, text, text, text, text, integer, uuid) to authenticated;
revoke execute on function public.kiosk_track(text, text) from public, anon;
grant execute on function public.kiosk_track(text, text) to authenticated;
