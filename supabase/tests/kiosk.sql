-- Kvisa tablet (kiosk) tests. Requires business_rules.sql (kvisa_tests.t / act_as).
-- Usage: select * from kvisa_tests.run_kiosk();   -- everything is rolled back

create or replace function kvisa_tests.run_kiosk()
returns table (test text, ok boolean, detail text)
language plpgsql set search_path = public as $$
declare
  res jsonb := '[]'::jsonb;
  u_k uuid := gen_random_uuid(); u_disp uuid := gen_random_uuid(); u_drv uuid := gen_random_uuid();
  p_drv uuid; v_json jsonb; v_json2 jsonb; v_ok boolean; v_cnt int; v_client uuid; v_key uuid := gen_random_uuid();
  v_err text;
begin
  begin
    grant usage on schema kvisa_tests to authenticated;
    grant execute on all functions in schema kvisa_tests to authenticated;
    perform kvisa_tests.act_as(null);

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
    v_json := public.kiosk_submit('  Moshe   Levi ', '052-123-4567', 3, v_key);
    perform kvisa_tests.act_as(null);
    select client_id into v_client from public.orders where order_no = (v_json->>'order_no')::bigint;
    res := res || kvisa_tests.t('K1 Tablet request creates a client in the tablet category and an open order',
      (select name = 'Moshe Levi' and category_id = 'zz_kiosk' and pickup_address = '1 Guest House Lane' from public.clients where id = v_client)
      and (select status = 'requested' and source = 'kiosk' and expected_bags = 3 and pickup_contact = 'Moshe Levi'
           and pickup_address = '1 Guest House Lane' from public.orders where client_id = v_client)
      and (select count(*) from public.order_tasks t join public.orders o on o.id = t.order_id where o.client_id = v_client) = 5
      and not (v_json->>'returning')::boolean, v_json::text);
    res := res || kvisa_tests.t('K1 Staff are notified of a tablet request',
      exists (select 1 from public.notifications where user_id = u_disp and kind = 'kiosk_request'
              and title like '%K-' || (v_json->>'order_no') || '%'));

    -- ---- double tap: same request key ----
    perform kvisa_tests.act_as(u_k);
    v_json2 := public.kiosk_submit('Moshe Levi', '052-123-4567', 3, v_key);
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('K2 Sending the same request twice does not create a second order',
      v_json2->>'order_no' = v_json->>'order_no' and (select count(*) from public.orders where client_id = v_client) = 1);

    -- ---- returning meshulach, international format ----
    perform kvisa_tests.act_as(u_k);
    v_json2 := public.kiosk_submit('Moshe L', '+972 52 123 4567', 2, gen_random_uuid());
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('K3 Same phone in another format is the same client (no duplicate)',
      (v_json2->>'returning')::boolean and (select count(*) from public.orders where client_id = v_client) = 2
      and (select count(*) from public.clients where public.phone_key(phone) = '521234567') = 1
      and (select name from public.clients where id = v_client) = 'Moshe Levi', v_json2::text);

    -- ---- inactive client comes back ----
    update public.clients set active = false where id = v_client;
    perform kvisa_tests.act_as(u_k);
    perform public.kiosk_submit('Moshe Levi', '0521234567', 1, gen_random_uuid());
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('K4 An inactive client who returns is reactivated, not duplicated',
      (select active from public.clients where id = v_client) and (select count(*) from public.orders where client_id = v_client) = 3);

    -- ---- validation ----
    perform kvisa_tests.act_as(u_k);
    v_ok := true;
    begin perform public.kiosk_submit('A', '0521234567', 1, gen_random_uuid()); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%name%'; end;
    begin perform public.kiosk_submit('Abe', '123', 1, gen_random_uuid()); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%phone%'; end;
    begin perform public.kiosk_submit('Abe', '0521234567', 0, gen_random_uuid()); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%from 1 to 10%'; end;
    begin perform public.kiosk_submit('Abe', '0521234567', 11, gen_random_uuid()); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%from 1 to 10%'; end;
    res := res || kvisa_tests.t('K5 Name, phone and bag count are validated (max bags from Settings)', v_ok);

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
    begin perform public.kiosk_submit('Driver Test', '0529999999', 1, gen_random_uuid()); exception when others then v_ok := sqlerrm like '%KVISA_FORBIDDEN%'; end;
    res := res || kvisa_tests.t('K7 A driver cannot submit tablet requests', v_ok);
    perform kvisa_tests.act_as(null);
    perform set_config('role', 'anon', true);
    v_ok := false;
    begin perform public.kiosk_submit('Anon Test', '0529999999', 1, gen_random_uuid()); exception when others then v_ok := true; end;
    perform set_config('role', 'postgres', true);
    res := res || kvisa_tests.t('K7 Signed-out visitors cannot submit', v_ok);
    perform kvisa_tests.act_as(u_disp);
    v_json2 := public.kiosk_submit('Office Test', '0528888888', 1, gen_random_uuid());
    res := res || kvisa_tests.t('K7 Staff can use the tablet screen (for testing)', (v_json2->>'order_no') is not null);

    -- ---- flood guard ----
    perform kvisa_tests.act_as(null);
    update public.orders set created_by = u_k where source = 'kiosk';
    insert into public.orders (client_id, category_id, source, created_by)
      select v_client, 'zz_kiosk', 'kiosk', u_k from generate_series(1, 30);
    perform kvisa_tests.act_as(u_k);
    v_ok := false;
    begin perform public.kiosk_submit('Flood Test', '0527777777', 1, gen_random_uuid()); exception when others then v_ok := sqlerrm like '%too many%'; end;
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
