-- Kvisa 014: tablet calls go into the main app (Nekius Dispatch) as Open requests.
-- Kvisa's server calls the main app's tablet_request / tablet_status / tablet_cancel (see
-- supabase/main-app/001_tablet_bridge.sql) over HTTPS with a secret kept in Kvisa's vault
-- (name 'main_app_tablet_secret'). Pickup status and cancelling follow the main app, where dispatchers work.

do $$ begin
  create extension if not exists http with schema extensions;
exception when others then
  raise notice 'http extension not available here (a test database); the main-app link will not work';
end $$;

alter table public.orders add column if not exists main_request_id bigint;   -- the request's number in the main app

-- Call one of the main app's tablet functions; raises KVISA_MAIN_APP (or the main app's own message) on failure.
create or replace function public._main_app(p_fn text, p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_url constant text := 'https://icghbewmvapvrxmwxlyg.supabase.co/rest/v1/rpc/';
  -- the main app's public (anon) key, the same one its website uses
  v_key constant text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImljZ2hiZXdtdmFwdnJ4bXd4bHlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzNDQ0OTksImV4cCI6MjEwNjkyMDQ5OX0.QJmeQ9LMZ7bDuniwH1LmkbZDcP3xgxvhrqmzDg5ybE0';
  v_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'main_app_tablet_secret' limit 1);
  r extensions.http_response;
begin
  if v_secret is null then raise exception 'KVISA_MAIN_APP: the main app key is not set up'; end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '10000');
  r := extensions.http(('POST', v_url || p_fn,
         array[extensions.http_header('apikey', v_key), extensions.http_header('Authorization', 'Bearer ' || v_key)],
         'application/json', (p_args || jsonb_build_object('p_secret', v_secret))::text)::extensions.http_request);
  if r.status >= 300 then
    raise exception 'KVISA_MAIN_APP: %', coalesce(nullif(r.content, '')::jsonb->>'message', 'the dispatch system answered ' || r.status);
  end if;
  return nullif(r.content, '')::jsonb;
exception when others then
  if sqlerrm like 'KVISA_MAIN_APP%' then raise; end if;
  raise exception 'KVISA_MAIN_APP: could not reach the dispatch system (%)', sqlerrm;
end $$;

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
  v_il text := nullif(trim(coalesce(p_israel_phone, '')), '');
  v_keys text[];
  v_cat client_categories%rowtype;
  c clients%rowtype;
  v_returning boolean := true;
  v_order uuid; v_no bigint;
  v_pickup_at timestamptz;
  v_main jsonb;
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
  if length(coalesce(v_il, '')) > 30 then raise exception 'KVISA_VALIDATION: the phone number in Israel is too long'; end if;
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

  -- Find the client by either number against either saved number; no match means a new client.
  -- A match on the Israeli number wins (it doesn't change between visits), then active, then the tablet category.
  v_keys := array_remove(array[public.phone_key(v_phone), public.phone_key(v_il)], null);
  select cl.* into c from clients cl
   where public.phone_key(cl.phone) = any(v_keys) or public.phone_key(cl.israel_phone) = any(v_keys)
   order by (v_il is not null and public.phone_key(cl.israel_phone) = public.phone_key(v_il)) desc, cl.active desc,
            (cl.category_id = v_cat.id) desc,
            (select max(o.created_at) from orders o where o.client_id = cl.id) desc nulls last, cl.created_at desc
   limit 1;
  if not found then
    v_returning := false;
    insert into clients (name, category_id, primary_contact, phone, israel_phone, pickup_address, access_instructions)
    values (v_name, v_cat.id, v_name, v_phone, v_il, coalesce(v_cat.default_pickup_address, s.org_address), v_cat.default_pickup_note)
    returning * into c;
  else
    -- Keep the newest numbers on file (an empty Israeli number keeps the saved one); old ones stay in the history.
    update clients set active = true, phone = v_phone, israel_phone = coalesce(v_il, israel_phone)
     where id = c.id and (not active or phone is distinct from v_phone or (v_il is not null and israel_phone is distinct from v_il));
    select * into c from clients where id = c.id;
  end if;

  v_pickup_at := greatest(now(), public._local_ts(public._today(), s.default_pickup_time));
  v_order := public._create_order(jsonb_build_object(
    'client_id', c.id, 'expected_bags', p_bags, 'pickup_contact', v_name, 'pickup_phone', v_phone,
    'pickup_address', coalesce(c.pickup_address, v_cat.default_pickup_address, s.org_address),
    'pickup_at', v_pickup_at,
    'notes', case when v_il is not null and public.phone_key(v_il) is distinct from public.phone_key(v_phone) then 'Phone in Israel: ' || v_il end));
  update orders set source = 'kiosk', request_key = p_request_key where id = v_order returning order_no into v_no;

  -- The same drop-off becomes an Open request in the main app (Nekius Dispatch). If the main app can't be
  -- reached, this whole step is undone and the tablet asks to try again, so no labels print for a call the
  -- dispatchers would never see. Retrying sends the same key, which never makes a second request.
  v_main := public._main_app('tablet_request', jsonb_build_object('p_key', p_request_key, 'p_ref', v_no,
    'p_name', v_name, 'p_phone', v_phone, 'p_phone2', v_il, 'p_bags', p_bags));
  update orders set main_request_id = (v_main->>'request_id')::bigint where id = v_order;

  perform public._notify_staff('kiosk_request', format('New tablet request — order K-%s', v_no),
    format('%s · %s bag(s)%s', v_name, p_bags, case when v_returning then '' else ' · new client' end),
    v_order, null);

  return jsonb_build_object('order_no', v_no, 'name', v_name, 'phone', v_phone, 'israel_phone', coalesce(v_il, c.israel_phone), 'bags', p_bags,
    'created_at', now(), 'returning', v_returning, 'repeat', false);
end $$;

-- Look up: pickup status comes from the main app (the dispatchers update it there).
create or replace function public.kiosk_lookup(p_order_no bigint, p_last4 text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  o orders%rowtype := public._kiosk_find(p_order_no, p_last4);
  v_state text; v_main jsonb; v_st text;
begin
  v_state := case when o.status = 'cancelled' then 'cancelled' when o.status = 'completed' then 'returned'
                  when public._kiosk_waiting(o.id) then 'waiting' else 'picked_up' end;
  if o.main_request_id is not null then
    begin
      v_main := public._main_app('tablet_status', jsonb_build_object('p_key', o.request_key));
      v_st := v_main->>'status';
      v_state := case when v_st is null then v_state
                      when v_st = 'cancelled' then 'cancelled'
                      when v_st = 'completed' then 'returned'
                      when v_st in ('open', 'assigned', 'posted_pickup', 'not_covered') then 'waiting'
                      else 'picked_up' end;
    exception when others then null;   -- main app unreachable: show what Kvisa knows
    end;
  end if;
  return jsonb_build_object(
    'order_no', o.order_no, 'first_name', split_part(coalesce(o.pickup_contact, ''), ' ', 1), 'bags', o.expected_bags,
    'created_at', o.created_at, 'state', v_state, 'can_cancel', v_state = 'waiting');
end $$;

-- Cancel: in the main app first (it refuses once the bags were picked up), then in Kvisa.
create or replace function public.kiosk_cancel(p_order_no bigint, p_last4 text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o orders%rowtype := public._kiosk_find(p_order_no, p_last4); r record;
  v_reason text := 'Cancelled by the client on the tablet';
begin
  perform 1 from orders where id = o.id for update;
  if o.main_request_id is not null then
    begin
      perform public._main_app('tablet_cancel', jsonb_build_object('p_key', o.request_key));
    exception when others then
      if sqlerrm like '%TABLET_PICKED_UP%' then
        raise exception 'KVISA_VALIDATION: this drop-off was already picked up and can no longer be cancelled here. Please ask the office';
      end if;
      raise;
    end;
  elsif not public._kiosk_waiting(o.id) then
    raise exception 'KVISA_VALIDATION: this drop-off was already picked up and can no longer be cancelled here. Please ask the office';
  end if;
  if o.status <> 'cancelled' then
    perform public._wf('order.cancelled', v_reason);
    update orders set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = v_reason where id = o.id;
    for r in select id, assignee_id, task_type from order_tasks where order_id = o.id and status in ('pending','in_progress') loop
      update order_tasks set status = 'cancelled' where id = r.id;
      perform public._notify_person(r.assignee_id, 'schedule_changed', format('Cancelled: order K-%s', o.order_no),
        public.task_type_label(r.task_type) || ' is no longer needed. Reason: ' || v_reason, o.id, r.id);
    end loop;
    perform public._notify_staff('kiosk_request', format('Tablet request cancelled — order K-%s', o.order_no),
      format('%s cancelled on the tablet (%s bag(s))', o.pickup_contact, o.expected_bags), o.id, null);
  end if;
  return jsonb_build_object('order_no', o.order_no, 'state', 'cancelled');
end $$;

revoke execute on function public._main_app(text, jsonb) from public, anon, authenticated;
