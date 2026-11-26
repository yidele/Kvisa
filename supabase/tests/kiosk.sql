-- Kvisa tablet (kiosk) tests. Requires business_rules.sql (kvisa_tests.t / act_as).
-- Usage: select * from kvisa_tests.run_kiosk();   -- everything is rolled back

create or replace function kvisa_tests.run_kiosk()
returns table (test text, ok boolean, detail text)
language plpgsql set search_path = public as $$
declare
  res jsonb := '[]'::jsonb;
  u_k uuid := gen_random_uuid(); u_disp uuid := gen_random_uuid(); u_drv uuid := gen_random_uuid();
  p_drv uuid; v_json jsonb; v_json2 jsonb; v_ok boolean; v_client uuid; v_key uuid := gen_random_uuid(); v_no bigint;
begin
  begin
    grant usage on schema kvisa_tests to authenticated;
    grant execute on all functions in schema kvisa_tests to authenticated;
    perform kvisa_tests.act_as(null);

    -- A stand-in for the main app (Nekius Dispatch), so the tests never touch the real one.
    -- Everything here, including the swapped function, is rolled back at the end.
    create table kvisa_tests.main_requests (key uuid primary key, id bigint generated always as identity, status text not null default 'open');
    create table kvisa_tests.main_down (down boolean);
    create or replace function public._main_app(p_fn text, p_args jsonb)
    returns jsonb language plpgsql security definer set search_path = public, kvisa_tests as $f$
    declare r record;
    begin
      if exists (select 1 from kvisa_tests.main_down) then raise exception 'KVISA_MAIN_APP: could not reach the dispatch system (test)'; end if;
      if p_fn = 'tablet_request' then
        insert into kvisa_tests.main_requests (key) values ((p_args->>'p_key')::uuid) on conflict (key) do nothing;
      end if;
      select * into r from kvisa_tests.main_requests where key = (p_args->>'p_key')::uuid;
      if not found then return null; end if;
      if p_fn = 'tablet_cancel' then
        if r.status not in ('open','assigned','posted_pickup','not_covered','cancelled') then raise exception 'TABLET_PICKED_UP: already picked up'; end if;
        update kvisa_tests.main_requests set status = 'cancelled' where key = r.key;
        return jsonb_build_object('request_id', r.id, 'status', 'cancelled');
      end if;
      return jsonb_build_object('request_id', r.id, 'status', r.status);
    end $f$;

    insert into public.client_categories (id, label, default_pickup_address) values ('zz_kiosk', 'ZZ Kiosk', '1 Guest House Lane');
    update public.organization_settings set kiosk_category_id = 'zz_kiosk', kiosk_max_bags = 10 where id = 1;
    insert into public.people (full_name) values ('K Driver') returning id into p_drv;
    insert into public.person_roles (person_id, role) values (p_drv, 'driver');
    insert into public.invites (email, roles, person_id) values
      ('k-tablet@kvisa.test', '{kiosk}', null), ('k-disp@kvisa.test', '{dispatcher}', null), ('k-drv@kvisa.test', '{driver}', p_drv);
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, '{}', '{}', now(), now()
    from (values (u_k, 'k-tablet@kvisa.test'), (u_disp, 'k-disp@kvisa.test'), (u_drv, 'k-drv@kvisa.test')) v(u, e);
    insert into public.user_roles (user_id, role) values (u_disp, 'dispatcher') on conflict do nothing;
    -- on an empty database the first account becomes admin; the tablet must hold only its own role
    insert into public.user_roles (user_id, role) values (u_k, 'kiosk') on conflict do nothing;
    delete from public.user_roles where user_id = u_k and role <> 'kiosk';

    -- ---- new meshulach ----
    perform kvisa_tests.act_as(u_k);
    v_json := public.kiosk_submit('  Moshe ', 'Yosef', ' Levi', '718-555-0101', '052-123-4567', 3, v_key);
    perform kvisa_tests.act_as(null);
    select client_id into v_client from public.orders where order_no = (v_json->>'order_no')::bigint;
    res := res || kvisa_tests.t('K1 Tablet request creates a client with both phones and an open order',
      (select name = 'Moshe Yosef Levi' and category_id = 'zz_kiosk' and pickup_address = '1 Guest House Lane'
              and phone = '718-555-0101' and israel_phone = '052-123-4567' from public.clients where id = v_client)
      and (select status = 'requested' and source = 'kiosk' and expected_bags = 3 and pickup_contact = 'Moshe Yosef Levi'
           and pickup_address = '1 Guest House Lane' and notes like '%052-123-4567%' from public.orders where client_id = v_client)
      and (select count(*) from public.order_tasks t join public.orders o on o.id = t.order_id where o.client_id = v_client) = 5
      and not (v_json->>'returning')::boolean, v_json::text);
    res := res || kvisa_tests.t('K15 The drop-off became an Open request in the main app, and Kvisa remembers its number',
      (select status from kvisa_tests.main_requests where key = v_key) = 'open'
      and (select main_request_id from public.orders where client_id = v_client)
          = (select id from kvisa_tests.main_requests where key = v_key));
    res := res || kvisa_tests.t('K1 Staff are notified of a tablet request',
      exists (select 1 from public.notifications where user_id = u_disp and kind = 'kiosk_request'
              and title like '%K-' || (v_json->>'order_no') || '%'));

    -- ---- double tap: same request key ----
    perform kvisa_tests.act_as(u_k);
    v_json2 := public.kiosk_submit('Moshe', '', 'Levi', '718-555-0101', '052-123-4567', 3, v_key);
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('K2 Sending the same request twice does not create a second order',
      v_json2->>'order_no' = v_json->>'order_no' and (select count(*) from public.orders where client_id = v_client) = 1);

    -- ---- next visit: new American number, same Israeli number (in another format) ----
    perform kvisa_tests.act_as(u_k);
    v_json2 := public.kiosk_submit('Moshe', '', 'Levi', '347-555-0199', '+972 52 123 4567', 2, gen_random_uuid());
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('K3 A new American number with the same Israeli number is the same client',
      (v_json2->>'returning')::boolean and (select count(*) from public.orders where client_id = v_client) = 2
      and (select count(*) from public.clients where public.phone_key(israel_phone) = '521234567') = 1
      and (select phone = '347-555-0199' and name = 'Moshe Yosef Levi' from public.clients where id = v_client), v_json2::text);

    -- ---- only one number, typed twice; matches the saved American number ----
    perform kvisa_tests.act_as(u_k);
    v_json2 := public.kiosk_submit('Moshe', '', 'Levi', '347 555 0199', '347 555 0199', 1, gen_random_uuid());
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('K3 The same number typed in both boxes is accepted and matched',
      (v_json2->>'returning')::boolean and (select count(*) from public.orders where client_id = v_client) = 3);

    -- ---- inactive client comes back ----
    update public.clients set active = false, israel_phone = '052-123-4567' where id = v_client;
    perform kvisa_tests.act_as(u_k);
    perform public.kiosk_submit('Moshe', '', 'Levi', '347-555-0199', '0521234567', 1, gen_random_uuid());
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('K4 An inactive client who returns is reactivated, not duplicated',
      (select active from public.clients where id = v_client) and (select count(*) from public.orders where client_id = v_client) = 4);

    -- ---- validation ----
    perform kvisa_tests.act_as(u_k);
    v_ok := true;
    begin perform public.kiosk_submit('', '', 'Levi', '0521234567', '0521234567', 1, gen_random_uuid()); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%first name%'; end;
    begin perform public.kiosk_submit('Abe', '', '', '0521234567', '0521234567', 1, gen_random_uuid()); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%last name%'; end;
    begin perform public.kiosk_submit('Abe', '', 'Cohen', '123', '0521234567', 1, gen_random_uuid()); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%valid phone%'; end;
    begin perform public.kiosk_submit('Abe', '', 'Cohen', '0521234567', '0521234567', 0, gen_random_uuid()); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%from 1 to 10%'; end;
    begin perform public.kiosk_submit('Abe', '', 'Cohen', '0521234567', '0521234567', 11, gen_random_uuid()); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%from 1 to 10%'; end;
    res := res || kvisa_tests.t('K5 Names, phone and bag count are validated (max bags from Settings)', v_ok);

    -- ---- the phone in Israel is optional and accepted in any format ----
    perform kvisa_tests.act_as(u_k);
    v_json2 := public.kiosk_submit('Abe', '', 'Cohen', '053-111-2222', '12', 1, gen_random_uuid());
    v_ok := not (v_json2->>'returning')::boolean;
    v_json2 := public.kiosk_submit('Sara', '', 'Klein', '053-222-3333', '', 1, gen_random_uuid());
    v_ok := v_ok and not (v_json2->>'returning')::boolean;
    v_json2 := public.kiosk_submit('Sara', '', 'Klein', '053-222-3333', '  ', 2, gen_random_uuid());
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('K11 Any Israeli number (or none) is accepted; an unmatched number opens a new client; a blank one keeps the saved one',
      v_ok and (v_json2->>'returning')::boolean
      and (select israel_phone is null from public.clients where phone = '053-222-3333')
      and (select israel_phone = '12' from public.clients where phone = '053-111-2222'), v_json2::text);

    -- ---- "I have an ID number": look up and cancel ----
    perform kvisa_tests.act_as(u_k);
    v_json2 := public.kiosk_lookup((v_json->>'order_no')::bigint, '0101');
    res := res || kvisa_tests.t('K12 ID + last 4 digits of the phone used shows the drop-off as waiting, cancellable, without addresses',
      v_json2->>'state' = 'waiting' and (v_json2->>'can_cancel')::boolean and v_json2->>'first_name' = 'Moshe'
      and (v_json2->>'bags')::int = 3 and not (v_json2::text like '%Guest House%') and not (v_json2::text like '%Levi%'), v_json2::text);
    v_ok := (public.kiosk_lookup((v_json->>'order_no')::bigint, '4567')->>'state') = 'waiting'
        and (public.kiosk_lookup((v_json->>'order_no')::bigint, '0199')->>'state') = 'waiting';
    res := res || kvisa_tests.t('K12 The last 4 digits of any of his numbers work', v_ok);
    v_ok := true;
    begin perform public.kiosk_lookup((v_json->>'order_no')::bigint, '9999'); v_ok := false; exception when others then v_ok := sqlerrm like '%KVISA_NOT_FOUND%'; end;
    begin perform public.kiosk_lookup(999999999, '0101'); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%KVISA_NOT_FOUND%'; end;
    begin perform public.kiosk_lookup((v_json->>'order_no')::bigint, '01'); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%KVISA_NOT_FOUND%'; end;
    res := res || kvisa_tests.t('K12 A wrong ID or wrong digits find nothing (same message for both)', v_ok);

    v_json2 := public.kiosk_cancel((v_json->>'order_no')::bigint, '4567');
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('K13 Cancelling while waiting cancels the order and all its stages, and tells the office',
      v_json2->>'state' = 'cancelled'
      and (select status = 'cancelled' and cancel_reason like '%tablet%' from public.orders where order_no = (v_json->>'order_no')::bigint)
      and not exists (select 1 from public.order_tasks t join public.orders o on o.id = t.order_id
                      where o.order_no = (v_json->>'order_no')::bigint and t.status <> 'cancelled')
      and exists (select 1 from public.notifications where user_id = u_disp and title like 'Tablet request cancelled%'), v_json2::text);
    perform kvisa_tests.act_as(u_k);
    v_json2 := public.kiosk_lookup((v_json->>'order_no')::bigint, '0101');
    v_ok := v_json2->>'state' = 'cancelled' and not (v_json2->>'can_cancel')::boolean
        and (public.kiosk_cancel((v_json->>'order_no')::bigint, '0101')->>'state') = 'cancelled';
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('K13 A cancelled drop-off shows as cancelled (no cancel button); a second cancel changes nothing',
      v_ok and (select status from kvisa_tests.main_requests where key = v_key) = 'cancelled'
      and (select count(*) from public.notifications where user_id = u_disp and title like 'Tablet request cancelled%') = 1);
    perform kvisa_tests.act_as(u_k);

    -- once the main app shows the bags picked up, it can no longer be cancelled from the tablet
    perform kvisa_tests.act_as(null);
    select o.order_no into v_no from public.orders o where o.client_id = v_client and o.status = 'requested' order by o.created_at limit 1;
    update kvisa_tests.main_requests set status = 'delivered'
     where key = (select request_key from public.orders where order_no = v_no);
    perform kvisa_tests.act_as(u_k);
    v_json2 := public.kiosk_lookup(v_no, '0199');
    v_ok := v_json2->>'state' = 'picked_up' and not (v_json2->>'can_cancel')::boolean;
    begin perform public.kiosk_cancel(v_no, '0199'); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%already picked up%'; end;
    res := res || kvisa_tests.t('K14 After pickup has started it shows as picked up and cannot be cancelled', v_ok, v_json2::text);

    perform kvisa_tests.act_as(u_drv);
    v_ok := false;
    begin perform public.kiosk_lookup(v_no, '0199'); exception when others then v_ok := sqlerrm like '%KVISA_FORBIDDEN%'; end;
    begin perform public.kiosk_cancel(v_no, '0199'); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%KVISA_FORBIDDEN%'; end;
    res := res || kvisa_tests.t('K14 Only the tablet (or staff) can look up or cancel', v_ok);

    -- ---- main app unreachable: nothing is saved, and the tablet is asked to try again ----
    perform kvisa_tests.act_as(null);
    insert into kvisa_tests.main_down values (true);
    perform kvisa_tests.act_as(u_k);
    v_ok := false;
    begin perform public.kiosk_submit('Down', '', 'Test', '0526666666', '', 1, gen_random_uuid());
    exception when others then v_ok := sqlerrm like 'KVISA_MAIN_APP%'; end;
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('K16 If the main app cannot be reached, nothing is saved and the tablet is told',
      v_ok and not exists (select 1 from public.clients where phone = '0526666666'));
    delete from kvisa_tests.main_down;

    -- ---- the tablet login can do nothing else ----
    perform kvisa_tests.act_as(u_k);
    res := res || kvisa_tests.t('K6 Tablet cannot read clients, orders, tasks, people or notes',
      (select count(*) from public.clients) = 0 and (select count(*) from public.orders) = 0
      and (select count(*) from public.order_tasks) = 0 and (select count(*) from public.people) = 0
      and (select count(*) from public.client_internal_notes) = 0 and (select count(*) from public.order_overview) = 0);
    v_ok := false;
    begin perform public.create_order(jsonb_build_object('client_id', v_client)); exception when others then v_ok := sqlerrm like '%KVISA_FORBIDDEN%'; end;
    res := res || kvisa_tests.t('K6 Tablet cannot create orders directly', v_ok);
    v_ok := false;
    begin insert into public.clients (name, category_id) values ('Sneaky', 'zz_kiosk'); exception when others then v_ok := true; end;
    res := res || kvisa_tests.t('K6 Tablet cannot insert clients directly', v_ok);
    v_ok := false;
    begin perform public.dashboard_summary(); exception when others then v_ok := sqlerrm like '%KVISA_FORBIDDEN%'; end;
    res := res || kvisa_tests.t('K6 Tablet cannot see the dashboard', v_ok);

    -- ---- other roles ----
    perform kvisa_tests.act_as(u_drv);
    v_ok := false;
    begin perform public.kiosk_submit('Driver', '', 'Test', '0529999999', '0529999999', 1, gen_random_uuid()); exception when others then v_ok := sqlerrm like '%KVISA_FORBIDDEN%'; end;
    res := res || kvisa_tests.t('K7 A driver cannot submit tablet requests', v_ok);
    perform kvisa_tests.act_as(null);
    perform set_config('role', 'anon', true);
    v_ok := false;
    begin perform public.kiosk_submit('Anon', '', 'Test', '0529999999', '0529999999', 1, gen_random_uuid()); exception when others then v_ok := true; end;
    begin perform public.kiosk_lookup(1001, '9999'); v_ok := false; exception when others then v_ok := v_ok; end;
    begin perform public.kiosk_cancel(1001, '9999'); v_ok := false; exception when others then v_ok := v_ok; end;
    perform set_config('role', 'postgres', true);
    res := res || kvisa_tests.t('K7 Signed-out visitors cannot submit, look up or cancel', v_ok);
    perform kvisa_tests.act_as(u_disp);
    v_json2 := public.kiosk_submit('Office', '', 'Test', '0528888888', '0528888888', 1, gen_random_uuid());
    res := res || kvisa_tests.t('K7 Staff can use the tablet screen (for testing)', (v_json2->>'order_no') is not null);

    -- ---- flood guard ----
    perform kvisa_tests.act_as(null);
    update public.orders set created_by = u_k where source = 'kiosk';
    insert into public.orders (client_id, category_id, source, created_by)
      select v_client, 'zz_kiosk', 'kiosk', u_k from generate_series(1, 30);
    perform kvisa_tests.act_as(u_k);
    v_ok := false;
    begin perform public.kiosk_submit('Flood', '', 'Test', '0527777777', '0527777777', 1, gen_random_uuid()); exception when others then v_ok := sqlerrm like '%too many%'; end;
    res := res || kvisa_tests.t('K8 The tablet is limited to 30 requests per 10 minutes', v_ok);

    -- ---- phone matching ----
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('K9 phone_key matches local and international forms',
      public.phone_key('052-123-4567') = public.phone_key('+972-52-123-4567') and public.phone_key('718 555 0100') = public.phone_key('1-718-555-0100')
      and public.phone_key('') is null);

    raise exception 'KVISA_TEST_ROLLBACK';
  exception when others then
    if sqlerrm <> 'KVISA_TEST_ROLLBACK' then res := res || kvisa_tests.t('!! Unexpected error', false, sqlerrm); end if;
  end;
  return query select x->>'test', (x->>'ok')::boolean, x->>'detail' from jsonb_array_elements(res) x;
end $$;
