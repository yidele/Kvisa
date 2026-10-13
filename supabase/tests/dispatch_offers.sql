-- Kvisa dispatch-offer & address-privacy tests. Requires business_rules.sql (kvisa_tests.t / act_as).
-- Usage: select * from kvisa_tests.run_offers();   -- everything is rolled back

create or replace function kvisa_tests.run_offers()
returns table (test text, ok boolean, detail text)
language plpgsql set search_path = public as $$
declare
  res jsonb := '[]'::jsonb;
  u_disp uuid := gen_random_uuid(); u_a uuid := gen_random_uuid(); u_b uuid := gen_random_uuid();
  u_c uuid := gen_random_uuid(); u_d uuid := gen_random_uuid(); u_w uuid := gen_random_uuid();
  p_a uuid; p_b uuid; p_c uuid; p_d uuid; p_w uuid;
  v_client uuid; o1 uuid; o2 uuid; t_pick uuid; t_drop uuid; t_wash uuid; t_ret uuid; t_del uuid;
  v_offer uuid; v_offer2 uuid; v_json jsonb; v_ok boolean; v_txt text; v_cnt int; r record;
  base timestamptz := now() - interval '5 hours';
begin
  begin
    grant usage on schema kvisa_tests to authenticated;
    grant execute on all functions in schema kvisa_tests to authenticated;
    perform kvisa_tests.act_as(null);

    insert into public.client_categories (id, label) values ('zz_offer', 'ZZ Offer');
    insert into public.people (full_name, address) values ('O Driver A', '1 A St') returning id into p_a;
    insert into public.people (full_name, address) values ('O Driver B', '2 B St') returning id into p_b;
    insert into public.people (full_name, address) values ('O Driver C', '3 C St') returning id into p_c;
    insert into public.people (full_name, address) values ('O Driver D', '4 D St') returning id into p_d;
    insert into public.people (full_name, address) values ('O Washer W', '45 Maple Avenue #2, Brooklyn NY 11230') returning id into p_w;
    insert into public.person_roles (person_id, role) values (p_a,'driver'),(p_b,'driver'),(p_c,'driver'),(p_d,'driver'),(p_w,'washer');
    insert into public.invites (email, roles, person_id) values
      ('o-disp@kvisa.test','{dispatcher}',null), ('o-a@kvisa.test','{driver}',p_a), ('o-b@kvisa.test','{driver}',p_b),
      ('o-c@kvisa.test','{driver}',p_c), ('o-d@kvisa.test','{driver}',p_d), ('o-w@kvisa.test','{volunteer}',p_w);
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, '{}', '{}', now(), now()
    from (values (u_disp,'o-disp@kvisa.test'),(u_a,'o-a@kvisa.test'),(u_b,'o-b@kvisa.test'),(u_c,'o-c@kvisa.test'),(u_d,'o-d@kvisa.test'),(u_w,'o-w@kvisa.test')) v(u,e);
    -- if this is the very first account, it became admin; make sure the dispatcher is staff either way
    insert into public.user_roles (user_id, role) values (u_disp, 'dispatcher') on conflict do nothing;
    -- only the test drivers should receive offers in this test
    update public.person_roles set active = false where role = 'driver' and person_id not in (p_a, p_b, p_c, p_d);
    insert into public.clients (name, category_id, phone, pickup_address, default_return_address, access_instructions)
      values ('Offer Test Client', 'zz_offer', '555-0199', '12 Main Street, Apt 4B, Brooklyn NY 11230', '9 Other Road, Brooklyn NY', 'Gate code 4417')
      returning id into v_client;

    -- ---- readiness: no washer yet → cannot dispatch ----
    perform kvisa_tests.act_as(u_disp);
    o1 := public.create_order(jsonb_build_object('client_id', v_client, 'expected_bags', 4, 'pickup_at', base,
      'dropoff_driver_id', p_b, 'delivery_driver_id', null));
    select id into t_pick from public.order_tasks where order_id = o1 and task_type = 'pickup';
    select id into t_drop from public.order_tasks where order_id = o1 and task_type = 'dropoff';
    select id into t_wash from public.order_tasks where order_id = o1 and task_type = 'washing';
    select id into t_ret from public.order_tasks where order_id = o1 and task_type = 'return_collection';
    select id into t_del from public.order_tasks where order_id = o1 and task_type = 'delivery';
    v_ok := false;
    begin perform public.dispatch_task(t_pick); exception when others then v_ok := sqlerrm like '%washing volunteer first%'; end;
    res := res || kvisa_tests.t('O0 Dispatch Call needs a washing volunteer first', v_ok);

    perform kvisa_tests.act_as(u_disp);
    update public.order_tasks set assignee_id = p_w where id = t_wash;
    v_offer := public.dispatch_task(t_pick, null, 60, 'Two bags are heavy');
    res := res || kvisa_tests.t('O0 Dispatch Call creates an open offer for every active driver',
      (select status from public.task_offers where id = v_offer) = 'available'
      and (select count(*) from public.offer_recipients where offer_id = v_offer) = 4);
    res := res || kvisa_tests.t('O0 Dispatching one stage does not dispatch or assign another',
      (select count(*) from public.task_offers where order_id = o1) = 1
      and (select assignee_id from public.order_tasks where id = t_drop) = p_b
      and (select assignee_id from public.order_tasks where id = t_ret) is null);

    -- ---- 1. before accepting: street names only ----
    perform kvisa_tests.act_as(u_a);
    select row_to_json(x)::text into v_txt from public.my_offers() x where x.offer_id = v_offer;
    res := res || kvisa_tests.t('01 Driver sees street names before accepting',
      v_txt like '%"from_street":"Main Street"%' and v_txt like '%"to_street":"Maple Avenue"%', v_txt);
    res := res || kvisa_tests.t('01 …but no house number, apartment, city, contact or access code',
      v_txt not like '%12 %' and v_txt not like '%4B%' and v_txt not like '%45 %' and v_txt not like '%Brooklyn%'
      and v_txt not like '%555%' and v_txt not like '%4417%', v_txt);
    select count(*) into v_cnt from public.my_tasks(null, null, true);
    res := res || kvisa_tests.t('01 No exact address through my tasks before accepting', v_cnt = 0);
    select count(*) into v_cnt from public.order_tasks;
    res := res || kvisa_tests.t('01 Direct API reads of stages/orders/offers return nothing for drivers', v_cnt = 0
      and (select count(*) from public.orders) = 0 and (select count(*) from public.task_offers) = 0
      and (select count(*) from public.offer_recipients) = 0 and (select count(*) from public.task_dispatch) = 0);
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('01 Offer notification text has no house number',
      not exists (select 1 from public.notifications where user_id = u_a and kind = 'offer' and (body like '%12 %' or body like '%4B%' or title like '%12 %'))
      and exists (select 1 from public.notifications where user_id = u_a and kind = 'offer'));

    -- ---- 2. accept → exact address ----
    perform kvisa_tests.act_as(u_a);
    v_json := public.respond_offer(v_offer, true);
    select from_address into v_txt from public.my_tasks() where task_id = t_pick;
    res := res || kvisa_tests.t('02 Accepting assigns the job and reveals the exact address',
      (v_json->>'accepted')::boolean and v_txt = '12 Main Street, Apt 4B, Brooklyn NY 11230', v_txt);
    select instructions into v_txt from public.my_tasks() where task_id = t_pick;
    res := res || kvisa_tests.t('02 Access instructions appear only after accepting', v_txt like '%4417%', v_txt);
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('02 Acceptance time and driver are recorded in history',
      (select accepted_person_id from public.task_offers where id = v_offer) = p_a
      and (select accepted_at from public.task_offers where id = v_offer) is not null
      and exists (select 1 from public.audit_logs where order_id = o1 and action = 'offer.accepted')
      and exists (select 1 from public.notifications n join public.user_roles ur on ur.user_id = n.user_id and ur.role in ('admin','dispatcher')
                  where n.title like 'O Driver A accepted%'));

    -- ---- 3 & 7. another driver cannot get it / cannot also accept ----
    perform kvisa_tests.act_as(u_b);
    select count(*) into v_cnt from public.my_offers() where offer_id = v_offer;
    v_ok := false;
    begin perform public.respond_offer(v_offer, true); exception when others then v_ok := sqlerrm like '%KVISA_TAKEN%'; end;
    res := res || kvisa_tests.t('07 A second driver cannot accept the same job', v_ok and v_cnt = 0);
    select count(*) into v_cnt from public.my_tasks(null, null, true) where task_id = t_pick;
    res := res || kvisa_tests.t('03 A different driver cannot retrieve the accepted job''s address', v_cnt = 0);
    perform kvisa_tests.act_as(null);
    v_ok := false;
    begin
      insert into public.task_offers (order_id, task_id, status) values (o1, t_drop, 'available');
      insert into public.task_offers (order_id, task_id, status) values (o1, t_drop, 'available');
    exception when unique_violation then v_ok := true; end;
    res := res || kvisa_tests.t('07 The database allows only one open offer per stage (atomic first-come acceptance)', v_ok);

    -- ---- 6. reassignment revokes the previous driver ----
    perform kvisa_tests.act_as(u_disp);
    update public.order_tasks set assignee_id = p_c where id = t_pick;
    perform kvisa_tests.act_as(u_a);
    select count(*) into v_cnt from public.my_tasks(null, null, true) where task_id = t_pick;
    perform kvisa_tests.act_as(u_c);
    select from_address into v_txt from public.my_tasks() where task_id = t_pick;
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('06 Reassigning revokes the previous driver''s access; the new driver gets it',
      v_cnt = 0 and v_txt like '12 Main Street%'
      and exists (select 1 from public.audit_logs where order_id = o1 and action = 'offer.access_revoked'), v_txt);

    -- move the order along: pickup by C, drop-off by B, washing by W
    perform kvisa_tests.act_as(u_c);
    perform public.record_handoff(t_pick, 'collected_from_client', 4, null, base + interval '10 min');
    perform kvisa_tests.act_as(u_disp);
    v_ok := false;
    begin perform public.dispatch_task(t_ret); exception when others then v_ok := sqlerrm like '%Washing is not completed%'; end;
    res := res || kvisa_tests.t('04 Return dispatch is not available before washing is complete', v_ok
      and (select blocked_reason from public.task_dispatch where task_id = t_ret) is not null);
    perform kvisa_tests.act_as(u_b);
    perform public.record_handoff(t_drop, 'delivered_to_washer', 4, null, base + interval '30 min');
    perform kvisa_tests.act_as(u_w);
    perform public.record_handoff(t_wash, 'received_by_washer', 4, null, base + interval '35 min');
    perform public.record_handoff(t_wash, 'wash_completed', 4, null, base + interval '2 hours');

    -- ---- 4. washing completion enables "Dispatch Return Pickup" (but does not auto-dispatch) ----
    perform kvisa_tests.act_as(u_disp);
    res := res || kvisa_tests.t('04 Washing completion enables the return dispatch action',
      (select blocked_reason from public.task_dispatch where task_id = t_ret) is null
      and (select dispatch_status from public.task_dispatch where task_id = t_ret) = 'not_dispatched');
    res := res || kvisa_tests.t('04 The return pickup is not dispatched automatically by default',
      not exists (select 1 from public.task_offers where task_id = t_ret));

    -- ---- 5. send return to a different driver (only D); different final address ----
    v_offer2 := public.dispatch_task(t_ret, array[p_d], null, null);
    perform kvisa_tests.act_as(u_a);
    select count(*) into v_cnt from public.my_offers() where offer_id = v_offer2;
    perform kvisa_tests.act_as(u_d);
    select row_to_json(x)::text into v_txt from public.my_offers() x where x.offer_id = v_offer2;
    res := res || kvisa_tests.t('05 Return job offered only to the chosen driver, street-to-street',
      v_cnt = 0 and v_txt like '%"from_street":"Maple Avenue"%' and v_txt like '%"to_street":"Other Road"%' and v_txt not like '%45 %', v_txt);
    perform public.respond_offer(v_offer2, true);
    select to_address into v_txt from public.my_tasks() where task_id = t_ret;
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('05 Return driver differs from the pickup driver and goes to a different address',
      (select assignee_id from public.order_tasks where id = t_ret) = p_d
      and (select assignee_id from public.order_tasks where id = t_pick) = p_c
      and v_txt = '9 Other Road, Brooklyn NY', v_txt);

    -- ---- 8. dispatcher tracks offers, declines and history ----
    perform kvisa_tests.act_as(u_disp);
    v_offer := public.dispatch_task(t_del, array[p_a, p_b], 30, null);
    perform kvisa_tests.act_as(u_a); perform public.respond_offer(v_offer, false);
    perform kvisa_tests.act_as(u_disp);
    res := res || kvisa_tests.t('08 Dispatcher sees who was offered and who declined',
      (select response from public.offer_recipients where offer_id = v_offer and person_id = p_a) = 'declined'
      and (select response from public.offer_recipients where offer_id = v_offer and person_id = p_b) = 'pending'
      and (select dispatch_status from public.task_dispatch where task_id = t_del) = 'available'
      and (select declined_count from public.task_dispatch where task_id = t_del) = 1);
    perform kvisa_tests.act_as(u_b); perform public.respond_offer(v_offer, false);
    perform kvisa_tests.act_as(u_disp);
    res := res || kvisa_tests.t('08 When everyone declines the offer shows Declined',
      (select dispatch_status from public.task_dispatch where task_id = t_del) = 'declined');
    v_offer := public.dispatch_task(t_del, null, 30, null);   -- resend
    perform public.cancel_offer(v_offer, 'Will call a driver directly');
    perform kvisa_tests.act_as(u_a);
    select count(*) into v_cnt from public.my_offers();
    perform kvisa_tests.act_as(u_disp);
    res := res || kvisa_tests.t('08 Dispatcher can resend and cancel; cancelled offers vanish for drivers',
      v_cnt = 0 and (select dispatch_status from public.task_dispatch where task_id = t_del) = 'cancelled'
      and (select count(*) from public.task_offers where task_id = t_del) = 2
      and (select count(*) from public.audit_logs where order_id = o1 and action like 'offer.%') >= 6);
    res := res || kvisa_tests.t('08 Return stage shows Accepted', (select dispatch_status from public.task_dispatch where task_id = t_ret) = 'accepted');
    v_ok := false;
    begin perform public.dispatch_task(t_ret); exception when others then v_ok := sqlerrm like '%already assigned%'; end;
    res := res || kvisa_tests.t('08 Re-dispatching an assigned stage requires an explicit "replace"', v_ok);

    -- ---- offer expiry ----
    v_offer := public.dispatch_task(t_del, array[p_c], 5, null);
    perform kvisa_tests.act_as(null);
    update public.task_offers set expires_at = now() - interval '1 minute' where id = v_offer;
    perform kvisa_tests.act_as(u_c);
    select count(*) into v_cnt from public.my_offers();
    v_ok := false;
    begin perform public.respond_offer(v_offer, true); exception when others then v_ok := sqlerrm like '%no longer available%'; end;
    res := res || kvisa_tests.t('08 Expired offers cannot be accepted', v_cnt = 0 and v_ok);

    -- ---- non-driver cannot use offers ----
    perform kvisa_tests.act_as(u_w);
    v_ok := false;
    begin perform public.respond_offer(v_offer2, true); exception when others then v_ok := sqlerrm like '%KVISA_FORBIDDEN%'; end;
    res := res || kvisa_tests.t('03 Someone not offered the job cannot accept it', v_ok);
    v_ok := false;
    begin perform public.dispatch_task(t_del); exception when others then v_ok := sqlerrm like '%KVISA_FORBIDDEN%'; end;
    res := res || kvisa_tests.t('03 Only staff can dispatch', v_ok);

    -- ---- optional automatic return dispatch ----
    perform kvisa_tests.act_as(null);
    update public.organization_settings set auto_dispatch_return = true where id = 1;
    perform kvisa_tests.act_as(u_disp);
    o2 := public.create_order(jsonb_build_object('client_id', v_client, 'expected_bags', 1, 'pickup_at', base,
      'pickup_driver_id', p_a, 'dropoff_driver_id', p_a, 'washer_id', p_w));
    perform public.record_handoff((select id from public.order_tasks where order_id = o2 and task_type='pickup'), 'collected_from_client', 1, null, base + interval '1 min');
    perform public.record_handoff((select id from public.order_tasks where order_id = o2 and task_type='dropoff'), 'delivered_to_washer', 1, null, base + interval '2 min');
    perform public.record_handoff((select id from public.order_tasks where order_id = o2 and task_type='washing'), 'received_by_washer', 1, null, base + interval '3 min');
    perform public.record_handoff((select id from public.order_tasks where order_id = o2 and task_type='washing'), 'wash_completed', 1, null, base + interval '4 min');
    res := res || kvisa_tests.t('04 With the admin rule on, washing completion dispatches the return pickup',
      (select dispatch_status from public.task_dispatch t join public.order_tasks x on x.id = t.task_id
        where x.order_id = o2 and x.task_type = 'return_collection') = 'available');

    -- ---- street masking edge cases ----
    res := res || kvisa_tests.t('01 Street masking handles common address formats',
      public.street_only('12-14 Main St Apt 3') = 'Main St' and public.street_only('77B Ocean Pkwy, Unit 9') = 'Ocean Pkwy'
      and public.street_only('100 W 34th Street #5') = 'W 34th Street' and public.street_only('5') = 'Address on file'
      and public.street_only(null) = 'Address on file', public.street_only('100 W 34th Street #5'));

    raise exception 'KVISA_TEST_ROLLBACK';
  exception when others then
    if sqlerrm <> 'KVISA_TEST_ROLLBACK' then res := res || kvisa_tests.t('!! Unexpected error', false, sqlerrm); end if;
  end;
  return query select x->>'test', (x->>'ok')::boolean, x->>'detail' from jsonb_array_elements(res) x;
end $$;
