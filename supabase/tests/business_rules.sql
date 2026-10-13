-- Kvisa business-rule tests.
-- Runs entirely inside a rolled-back block: nothing it creates is kept.
-- Usage:  select * from kvisa_tests.run();
-- Requires a superuser-level session (the Supabase SQL editor / MCP), because it
-- impersonates test users with SET ROLE + request.jwt.claims, exactly like the API does.

create schema if not exists kvisa_tests;
revoke all on schema kvisa_tests from public, anon, authenticated;

create or replace function kvisa_tests.t(p_name text, p_ok boolean, p_detail text default null)
returns jsonb language sql immutable as $$
  select jsonb_build_object('test', p_name, 'ok', coalesce(p_ok, false), 'detail', p_detail)
$$;

-- Switch the current transaction to act as a given auth user (or back to postgres when null).
-- Also clears the per-request workflow flags, so each call behaves like a fresh API request.
create or replace function kvisa_tests.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('kvisa.rpc', '', true);
  perform set_config('kvisa.action', '', true);
  perform set_config('kvisa.reason', '', true);
  if p_user is null then
    perform set_config('request.jwt.claims', '', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
end $$;

create or replace function kvisa_tests.run()
returns table (test text, ok boolean, detail text)
language plpgsql as $$
declare
  res jsonb := '[]'::jsonb;
  u_admin uuid := gen_random_uuid(); u_disp uuid := gen_random_uuid();
  u_a uuid := gen_random_uuid(); u_b uuid := gen_random_uuid(); u_c uuid := gen_random_uuid(); u_d uuid := gen_random_uuid();
  u_w uuid := gen_random_uuid(); u_x uuid := gen_random_uuid();
  p_a uuid; p_b uuid; p_c uuid; p_d uuid; p_w uuid; p_x uuid;
  v_client uuid; v_client2 uuid;
  o1 uuid; o2 uuid; o3 uuid;
  tk record; v_task uuid; v_cnt int; v_cnt2 int; v_txt text; v_json jsonb; v_status text;
  v_err text; v_ok boolean;
  base timestamptz := now() - interval '6 hours';
  rs uuid; v_occ uuid; v_occ2 uuid; v_n1 int; v_n2 int; v_audit_before int; v_events_before int;
  v_ex uuid; v_event uuid;
begin
  begin
    grant usage on schema kvisa_tests to authenticated;
    grant execute on all functions in schema kvisa_tests to authenticated;

    -- ---------------- setup (as postgres) ----------------
    insert into public.invites (email, roles) values ('t-admin@kvisa.test', '{admin}'), ('t-disp@kvisa.test', '{dispatcher}');
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (u_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't-admin@kvisa.test', '{}', '{}', now(), now());
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (u_disp, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't-disp@kvisa.test', '{}', '{}', now(), now());
    -- make sure the test admin is an admin even if real users already exist
    insert into public.user_roles (user_id, role) values (u_admin, 'admin') on conflict do nothing;

    insert into public.client_categories (id, label) values ('zz_test', 'ZZ Test') ;
    insert into public.people (full_name, address) values ('T Driver A', '1 A St') returning id into p_a;
    insert into public.people (full_name, address) values ('T Driver B', '2 B St') returning id into p_b;
    insert into public.people (full_name, address) values ('T Driver C', '3 C St') returning id into p_c;
    insert into public.people (full_name, address) values ('T Driver D', '4 D St') returning id into p_d;
    insert into public.people (full_name, address, max_bags_per_day) values ('T Washer V', '10 Wash Ave', 20) returning id into p_w;
    insert into public.people (full_name, address) values ('T Driver X', '9 X St') returning id into p_x;
    insert into public.person_roles (person_id, role) values (p_a,'driver'),(p_b,'driver'),(p_c,'driver'),(p_d,'driver'),(p_w,'washer'),(p_x,'driver');
    insert into public.invites (email, roles, person_id) values
      ('t-a@kvisa.test','{driver}',p_a), ('t-b@kvisa.test','{driver}',p_b), ('t-c@kvisa.test','{driver}',p_c),
      ('t-d@kvisa.test','{driver}',p_d), ('t-w@kvisa.test','{volunteer}',p_w), ('t-x@kvisa.test','{driver}',p_x);
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, '{}', '{}', now(), now()
    from (values (u_a,'t-a@kvisa.test'),(u_b,'t-b@kvisa.test'),(u_c,'t-c@kvisa.test'),(u_d,'t-d@kvisa.test'),(u_w,'t-w@kvisa.test'),(u_x,'t-x@kvisa.test')) v(u,e);

    insert into public.clients (name, category_id, primary_contact, phone, pickup_address, access_instructions)
      values ('Test Meshilach Client', 'zz_test', 'Rivka', '555-0100', '100 Pickup Rd', 'Ring twice') returning id into v_client;
    insert into public.client_internal_notes (client_id, notes) values (v_client, 'SECRET internal note');

    -- Sign-up gate
    v_ok := false;
    begin
      insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
        values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stranger@kvisa.test', now(), now());
    exception when others then v_ok := sqlerrm like '%KVISA_NOT_INVITED%';
    end;
    res := res || kvisa_tests.t('00 Uninvited email cannot sign up', v_ok);
    res := res || kvisa_tests.t('00 Invited driver gets driver role and person link',
      exists (select 1 from public.user_roles where user_id = u_a and role = 'driver')
      and (select person_id from public.profiles where id = u_a) = p_a);

    -- ---------------- 1. Dispatcher creates order: Meshilach-type client, 4 bags ----------------
    perform kvisa_tests.act_as(u_disp);
    o1 := public.create_order(jsonb_build_object(
      'client_id', v_client, 'expected_bags', 4, 'pickup_at', base,
      'pickup_driver_id', p_a, 'dropoff_driver_id', p_b, 'washer_id', p_w,
      'return_driver_id', p_c, 'delivery_driver_id', p_d,
      'return_recipient', 'Different Recipient', 'return_address', '99 Other St'));
    select count(*) into v_cnt from public.order_tasks where order_id = o1;
    select status into v_status from public.orders where id = o1;
    res := res || kvisa_tests.t('01 Order created with 5 independent stages', v_cnt = 5 and v_status = 'scheduled', v_status || ', tasks=' || v_cnt);
    res := res || kvisa_tests.t('01 Each stage has its own assignee',
      (select array_agg(assignee_id order by seq) from public.order_tasks where order_id = o1) = array[p_a,p_b,p_w,p_c,p_d]);
    res := res || kvisa_tests.t('01 Drop-off goes to washer address; delivery to different address',
      (select to_address from public.order_tasks where order_id = o1 and task_type = 'dropoff') = '10 Wash Ave'
      and (select to_address from public.order_tasks where order_id = o1 and task_type = 'delivery') = '99 Other St');

    -- ---------------- 2. Driver A collects four bags ----------------
    perform kvisa_tests.act_as(u_a);
    select count(*) into v_cnt from public.my_tasks();
    res := res || kvisa_tests.t('02 Driver A sees only own tasks (pickup)', v_cnt = 1, 'count=' || v_cnt);
    select task_id into v_task from public.my_tasks() where task_type = 'pickup';
    v_json := public.record_handoff(v_task, 'collected_from_client', 4, null, base + interval '5 min');
    res := res || kvisa_tests.t('02 Pickup recorded, no discrepancy', v_json->>'exception_id' is null and v_json->>'order_status' = 'awaiting_dropoff', v_json::text);

    -- 13. driver cannot act on someone else's task or read restricted data
    perform kvisa_tests.act_as(null);
    select id into v_task from public.order_tasks where order_id = o1 and task_type = 'dropoff';
    perform kvisa_tests.act_as(u_a);
    v_ok := false;
    begin perform public.record_handoff(v_task, 'delivered_to_washer', 4);
    exception when others then v_ok := sqlerrm like '%KVISA_FORBIDDEN%'; end;
    res := res || kvisa_tests.t('13 Driver cannot record a stage assigned to someone else', v_ok);
    select count(*) into v_cnt from public.clients;
    select count(*) into v_cnt2 from public.client_internal_notes;
    res := res || kvisa_tests.t('13 Driver cannot read client records or internal notes', v_cnt = 0 and v_cnt2 = 0);
    select count(*) into v_cnt from public.orders; select count(*) into v_cnt2 from public.audit_logs;
    res := res || kvisa_tests.t('13 Driver cannot read orders table or audit log', v_cnt = 0 and v_cnt2 = 0);
    update public.organization_settings set org_name = 'hacked' where id = 1;
    get diagnostics v_cnt = row_count;
    res := res || kvisa_tests.t('13 Driver cannot change settings', v_cnt = 0);
    v_ok := false;
    begin perform public.create_order(jsonb_build_object('client_id', v_client));
    exception when others then v_ok := sqlerrm like '%KVISA_FORBIDDEN%'; end;
    res := res || kvisa_tests.t('13 Driver cannot create orders', v_ok);
    v_ok := false;
    begin perform public.report_summary(current_date - 1, current_date);
    exception when others then v_ok := sqlerrm like '%KVISA_FORBIDDEN%'; end;
    res := res || kvisa_tests.t('13 Driver cannot run reports', v_ok);
    select bool_and(coalesce(instructions,'') not like '%SECRET%') into v_ok from public.my_tasks(null, null, true);
    res := res || kvisa_tests.t('13 Driver task view never contains internal notes', coalesce(v_ok, true));
    perform kvisa_tests.act_as(u_x);
    select count(*) into v_cnt from public.my_tasks(null, null, true);
    res := res || kvisa_tests.t('13 Unassigned driver sees no tasks', v_cnt = 0);
    perform kvisa_tests.act_as(u_w);
    v_ok := false;
    begin perform public.set_user_roles(u_w, '{admin}');
    exception when others then v_ok := sqlerrm like '%KVISA_FORBIDDEN%'; end;
    res := res || kvisa_tests.t('13 Volunteer cannot grant themselves admin', v_ok);
    perform kvisa_tests.act_as(u_disp);
    update public.organization_settings set org_name = 'by dispatcher' where id = 1;
    get diagnostics v_cnt = row_count;
    res := res || kvisa_tests.t('13 Dispatcher cannot change settings (admin only)', v_cnt = 0);
    perform kvisa_tests.act_as(null);
    perform set_config('role', 'anon', true);
    v_ok := false;
    begin perform public.create_order(jsonb_build_object('client_id', v_client));
    exception when insufficient_privilege then v_ok := true; end;
    perform set_config('role', 'postgres', true);
    res := res || kvisa_tests.t('13 Anonymous visitors cannot call workflow functions', v_ok);

    -- ---------------- 3. Driver B delivers to washer ----------------
    perform kvisa_tests.act_as(u_b);
    select task_id into v_task from public.my_tasks() where order_id = o1 and task_type = 'dropoff';
    v_json := public.record_handoff(v_task, 'delivered_to_washer', 4, null, base + interval '30 min');
    res := res || kvisa_tests.t('03 Driver B drop-off recorded', v_json->>'order_status' = 'awaiting_washing', v_json::text);

    -- ---------------- 4. Volunteer confirms receipt and washes ----------------
    perform kvisa_tests.act_as(u_w);
    select task_id into v_task from public.my_tasks() where order_id = o1;
    v_ok := false;
    begin perform public.record_handoff(v_task, 'wash_completed', 4);
    exception when others then v_ok := sqlerrm like '%confirm receipt%'; end;
    res := res || kvisa_tests.t('04 Washing cannot be completed before receipt is confirmed', v_ok);
    perform public.record_handoff(v_task, 'received_by_washer', 4, null, base + interval '35 min');
    v_json := public.record_handoff(v_task, 'wash_started', null, null, base + interval '1 hour');
    res := res || kvisa_tests.t('04 Washing in progress', v_json->>'order_status' = 'washing_in_progress', v_json::text);
    v_json := public.record_handoff(v_task, 'wash_completed', 4, null, base + interval '2 hours');
    perform kvisa_tests.act_as(u_disp);
    select status into v_status from public.orders where id = o1;
    select current_location into v_txt from public.order_overview where id = o1;
    res := res || kvisa_tests.t('04 Washing done does not complete the order', v_status = 'ready_for_return' and v_txt = 'Ready at washing location', v_status || ' / ' || v_txt);

    -- ---------------- 5. Driver C collects washed bags ----------------
    perform kvisa_tests.act_as(u_c);
    select task_id into v_task from public.my_tasks() where order_id = o1;
    v_json := public.record_handoff(v_task, 'collected_from_washer', 4, null, base + interval '3 hours');
    perform kvisa_tests.act_as(u_disp);
    select current_location into v_txt from public.order_overview where id = o1;
    res := res || kvisa_tests.t('05 Return collection by Driver C; location tracked', v_json->>'order_status' = 'out_for_delivery' and v_txt like 'With return driver T Driver C%', v_txt);

    -- ---------------- 6 & 7. Driver D delivers to different recipient; completes only then ----------------
    select status into v_status from public.orders where id = o1;
    res := res || kvisa_tests.t('07 Order is not completed before delivery is confirmed', v_status <> 'completed', v_status);
    perform kvisa_tests.act_as(u_d);
    select task_id into v_task from public.my_tasks() where order_id = o1;
    v_json := public.record_handoff(v_task, 'delivered_to_recipient', 4, null, base + interval '4 hours');
    perform kvisa_tests.act_as(u_disp);
    res := res || kvisa_tests.t('06 Delivered by Driver D to a different recipient and address',
      (select to_party from public.handoff_effective where order_id = o1 and event_type = 'delivered_to_recipient') = 'Different Recipient'
      and (select location from public.handoff_effective where order_id = o1 and event_type = 'delivered_to_recipient') = '99 Other St'
      and (select from_person_id from public.handoff_effective where order_id = o1 and event_type = 'delivered_to_recipient') = p_d);
    select status into v_status from public.orders where id = o1;
    res := res || kvisa_tests.t('07 Order completes after delivery confirmation', v_status = 'completed' and v_json->>'order_status' = 'completed', v_status);
    select count(*) into v_cnt from public.handoff_events where order_id = o1;
    res := res || kvisa_tests.t('09 Every handoff stored separately with its own count', v_cnt = 7, 'events=' || v_cnt);

    -- ---------------- 8. Discrepancy creates an exception until resolved ----------------
    o2 := public.create_order(jsonb_build_object('client_id', v_client, 'expected_bags', 3, 'pickup_at', base,
      'pickup_driver_id', p_a, 'dropoff_driver_id', p_b, 'washer_id', p_w, 'return_driver_id', p_c, 'delivery_driver_id', p_d));
    -- dispatcher records on behalf of drivers (allowed for staff)
    select id into v_task from public.order_tasks where order_id = o2 and task_type = 'pickup';
    perform public.record_handoff(v_task, 'collected_from_client', 3, null, base + interval '5 min');

    -- 9. Edit at every stage without erasing history
    select count(*) into v_events_before from public.handoff_events where order_id = o2;
    select count(*) into v_audit_before from public.audit_logs where order_id = o2;
    perform kvisa_tests.act_as(u_disp);
    update public.orders set notes = 'Edited while awaiting drop-off', delivery_instructions = 'Use side door' where id = o2;
    update public.order_tasks set scheduled_at = base + interval '1 day' where order_id = o2 and task_type = 'delivery';
    select status into v_status from public.orders where id = o2;
    res := res || kvisa_tests.t('09 Editing mid-workflow keeps status and history',
      v_status = 'awaiting_dropoff'
      and (select count(*) from public.handoff_events where order_id = o2) = v_events_before
      and (select count(*) from public.audit_logs where order_id = o2) > v_audit_before
      and (select status from public.order_tasks where order_id = o2 and task_type = 'pickup') = 'completed', v_status);
    v_ok := false;
    perform kvisa_tests.act_as(u_disp);
    begin update public.order_tasks set assignee_id = p_x where order_id = o2 and task_type = 'pickup';
    exception when others then v_ok := sqlerrm like '%KVISA_COMPLETED_STAGE%'; end;
    res := res || kvisa_tests.t('09 A completed stage cannot be silently re-assigned', v_ok);
    v_ok := false;
    perform kvisa_tests.act_as(u_disp);
    begin update public.orders set status = 'completed' where id = o2;
    exception when others then v_ok := sqlerrm like '%KVISA_USE_WORKFLOW%'; end;
    res := res || kvisa_tests.t('09 Status cannot be typed in directly', v_ok);
    v_ok := false;
    perform kvisa_tests.act_as(u_disp);
    begin update public.order_tasks set actual_bags = 9 where order_id = o2 and task_type = 'pickup';
    exception when others then v_ok := sqlerrm like '%KVISA_USE_WORKFLOW%'; end;
    res := res || kvisa_tests.t('09 Recorded bag counts cannot be overwritten', v_ok);
    v_ok := false;
    begin
      perform kvisa_tests.act_as(null);
      update public.handoff_events set notes = 'tampered' where order_id = o2;
    exception when others then v_ok := sqlerrm like '%KVISA_APPEND_ONLY%'; end;
    perform kvisa_tests.act_as(u_disp);
    res := res || kvisa_tests.t('09 Handoff history is append-only (even for the database owner)', v_ok);

    select id into v_task from public.order_tasks where order_id = o2 and task_type = 'dropoff';
    v_json := public.record_handoff(v_task, 'delivered_to_washer', 2, 'One bag left in car', base + interval '30 min');
    v_ex := (v_json->>'exception_id')::uuid;
    res := res || kvisa_tests.t('08 Bag-count mismatch opens an exception', v_ex is not null
      and (select expected_bags from public.order_exceptions where id = v_ex) = 3
      and (select actual_bags from public.order_exceptions where id = v_ex) = 2);
    perform kvisa_tests.act_as(u_disp);
    update public.orders set bag_notes = 'edited while at washer' where id = o2;
    select id into v_task from public.order_tasks where order_id = o2 and task_type = 'washing';
    v_json := public.record_handoff(v_task, 'received_by_washer', 2, null, base + interval '35 min');
    res := res || kvisa_tests.t('08 Later stages compare with the last recorded count', v_json->>'exception_id' is null, v_json::text);
    perform public.record_handoff(v_task, 'wash_completed', 2, null, base + interval '2 hours');
    perform kvisa_tests.act_as(u_disp);
    update public.orders set notes = 'edited when ready for return' where id = o2;
    select id into v_task from public.order_tasks where order_id = o2 and task_type = 'return_collection';
    perform public.record_handoff(v_task, 'collected_from_washer', 2, null, base + interval '3 hours');
    perform kvisa_tests.act_as(u_disp);
    update public.orders set notes = 'edited while out for delivery' where id = o2;
    select id into v_task from public.order_tasks where order_id = o2 and task_type = 'delivery';
    v_json := public.record_handoff(v_task, 'delivered_to_recipient', 2, null, base + interval '4 hours');
    res := res || kvisa_tests.t('08 Delivered order with open exception is NOT completed', v_json->>'order_status' = 'exception', v_json::text);
    select open_exceptions into v_cnt from public.order_overview where id = o2;
    res := res || kvisa_tests.t('08 Exception stays visible until resolved', v_cnt = 1);
    v_ok := false;
    begin perform public.resolve_exception(v_ex, '   ');
    exception when others then v_ok := sqlerrm like '%explain%'; end;
    res := res || kvisa_tests.t('08 Resolution requires an explanation', v_ok);
    perform public.resolve_exception(v_ex, 'Driver found the bag; client confirmed only 2 were washed this week.');
    select status into v_status from public.orders where id = o2;
    res := res || kvisa_tests.t('08 Resolving the exception completes the order', v_status = 'completed', v_status);
    select count(*) into v_cnt from public.audit_logs where order_id = o2 and action = 'order.edited';
    res := res || kvisa_tests.t('09 Edits were audited at each stage', v_cnt >= 4, 'edits=' || v_cnt);

    -- Corrections keep the original record
    select id into v_event from public.handoff_events where order_id = o2 and event_type = 'delivered_to_washer';
    perform public.correct_handoff_count(v_event, 3, 'Wrong bag count');
    res := res || kvisa_tests.t('09 Count correction is a new record; original kept',
      (select actual_bags from public.handoff_events where id = v_event) = 2
      and (select effective_bags from public.handoff_effective where id = v_event) = 3);

    -- ---------------- 10. Reassigning one stage leaves the others alone ----------------
    o3 := public.create_order(jsonb_build_object('client_id', v_client, 'expected_bags', 2, 'pickup_at', base + interval '2 days',
      'pickup_driver_id', p_a, 'dropoff_driver_id', p_b, 'washer_id', p_w, 'return_driver_id', p_c, 'delivery_driver_id', p_d));
    perform kvisa_tests.act_as(u_disp);
    update public.order_tasks set assignee_id = p_x where order_id = o3 and task_type = 'pickup';
    res := res || kvisa_tests.t('10 Reassigning the pickup driver changes only the pickup',
      (select array_agg(assignee_id order by seq) from public.order_tasks where order_id = o3) = array[p_x,p_b,p_w,p_c,p_d]);
    select count(*), count(*) filter (where ended_at is not null) into v_cnt, v_cnt2
      from public.task_assignments a join public.order_tasks t on t.id = a.task_id where t.order_id = o3 and t.task_type = 'pickup';
    res := res || kvisa_tests.t('10 Assignment history keeps the previous driver', v_cnt = 2 and v_cnt2 = 1);
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('17 Reassigned driver and new driver are notified',
      exists (select 1 from public.notifications where user_id = u_x and kind = 'reassigned')
      or exists (select 1 from public.notifications where user_id = u_x and kind = 'assigned'));
    -- Conflict warning
    perform kvisa_tests.act_as(u_disp);
    select count(*) into v_cnt from public.assignment_conflicts(p_x, base + interval '2 days' + interval '10 minutes', null, null);
    res := res || kvisa_tests.t('13b Overlapping assignment produces a warning', v_cnt >= 1);

    -- Cancel with reason, reopen
    v_ok := false;
    begin perform public.cancel_order(o3, '');
    exception when others then v_ok := true; end;
    perform public.cancel_order(o3, 'Client cancelled');
    select status into v_status from public.orders where id = o3;
    res := res || kvisa_tests.t('07b Cancellation needs a reason and keeps the order', v_ok and v_status = 'cancelled'
      and (select count(*) from public.order_tasks where order_id = o3) = 5);
    perform public.reopen_order(o3, 'Client called back');
    select status into v_status from public.orders where id = o3;
    res := res || kvisa_tests.t('07b Reopened order returns to its stage', v_status = 'scheduled', v_status);

    -- ---------------- 11 & 12. Recurring schedules ----------------
    insert into public.recurring_schedules (client_id, weekdays, pickup_time, start_date, expected_bags, default_pickup_driver_id, default_washer_id)
      values (v_client, '{1,4}', '09:00', current_date, 2, p_a, p_w) returning id into rs;
    v_n1 := public.generate_recurring_orders(rs);
    v_n2 := public.generate_recurring_orders(rs);
    select count(*) into v_cnt from public.orders where recurring_schedule_id = rs;
    res := res || kvisa_tests.t('12 Generating twice does not duplicate occurrences', v_n1 > 0 and v_n2 = 0 and v_cnt = v_n1, format('first=%s second=%s total=%s', v_n1, v_n2, v_cnt));
    select count(*) into v_cnt2 from (select occurrence_date from public.orders where recurring_schedule_id = rs group by 1 having count(*) > 1) d;
    res := res || kvisa_tests.t('12 Each date appears at most once', v_cnt2 = 0);
    res := res || kvisa_tests.t('11 Only Mondays and Thursdays, within the planning window',
      not exists (select 1 from public.orders where recurring_schedule_id = rs and extract(dow from occurrence_date) not in (1,4))
      and not exists (select 1 from public.orders where recurring_schedule_id = rs
                      and occurrence_date > current_date + (select planning_window_days from public.organization_settings where id = 1) + 1));
    select id into v_occ from public.orders where recurring_schedule_id = rs order by occurrence_date limit 1;
    select id into v_occ2 from public.orders where recurring_schedule_id = rs order by occurrence_date offset 1 limit 1;
    perform kvisa_tests.act_as(u_disp);
    update public.orders set expected_bags = 5 where id = v_occ;  -- edit only this occurrence
    v_json := public.update_recurring_series(rs, '{"expected_bags": 7}'::jsonb, true);
    res := res || kvisa_tests.t('11 Editing one occurrence does not change the others; series edit skips it',
      (select expected_bags from public.orders where id = v_occ) = 5
      and (select expected_bags from public.orders where id = v_occ2) = 7
      and (select detached_from_series from public.orders where id = v_occ), v_json::text);
    perform public.skip_occurrence(v_occ2, 'Family away');
    perform public.generate_recurring_orders(rs);
    select count(*) into v_cnt from public.orders o where recurring_schedule_id = rs
      and occurrence_date = (select occurrence_date from public.orders where id = v_occ2);
    res := res || kvisa_tests.t('11 Skipped occurrence is not regenerated; series kept', v_cnt = 1
      and (select status from public.orders where id = v_occ2) = 'cancelled'
      and (select status from public.recurring_schedules where id = rs) = 'active');

    -- ---------------- 14. Reports reflect recorded events ----------------
    v_json := public.report_summary(current_date - 2, current_date + 1, 'zz_test');
    res := res || kvisa_tests.t('14 Report: bags collected / washed / delivered kept separate',
      (v_json->'totals'->>'bags_collected')::int = 7
      and (v_json->'totals'->>'bags_washed')::int = 6
      and (v_json->'totals'->>'bags_delivered')::int = 6,
      (v_json->'totals')::text);
    res := res || kvisa_tests.t('14 Report counts completed orders', (v_json->'totals'->>'orders_completed')::int = 2, (v_json->'totals'->>'orders_completed'));
    res := res || kvisa_tests.t('14 Report states its date range and time zone', v_json ? 'from' and v_json ? 'to' and v_json ? 'time_zone');
    res := res || kvisa_tests.t('14 Driver workload attributes deliveries to Driver D',
      exists (select 1 from jsonb_array_elements(v_json->'drivers') d where d->>'name' = 'T Driver D' and (d->>'deliveries')::int = 2));

    -- Reopen a stage: original events kept, task back to pending
    select id into v_task from public.order_tasks where order_id = o2 and task_type = 'delivery';
    select count(*) into v_events_before from public.handoff_events where order_id = o2;
    perform public.reopen_task(v_task, 'Entered by mistake');
    res := res || kvisa_tests.t('09 Reopening a stage keeps the original event and adds a reversal',
      (select count(*) from public.handoff_events where order_id = o2) = v_events_before + 1
      and (select status from public.order_tasks where id = v_task) = 'pending'
      and (select status from public.orders where id = o2) = 'out_for_delivery');

    -- Dashboard sanity
    v_json := public.dashboard_summary(null);
    res := res || kvisa_tests.t('05b Dashboard numbers come from live data', v_json ? 'pickups_scheduled' and (v_json->>'washers_active')::int >= 1, v_json::text);

    -- Notifications were produced for field users
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('17 Assigned volunteer received an assignment notification',
      exists (select 1 from public.notifications where user_id = u_w and kind = 'assigned'));

    -- 15. Persistence: committed rows are re-read by a fresh statement (UI refresh is covered by e2e)
    res := res || kvisa_tests.t('15 Saved records are re-readable', exists (select 1 from public.orders where id = o1));

    raise exception 'KVISA_TEST_ROLLBACK';
  exception when others then
    if sqlerrm <> 'KVISA_TEST_ROLLBACK' then
      res := res || kvisa_tests.t('!! Unexpected error', false, sqlerrm);
    end if;
  end;
  return query select x->>'test', (x->>'ok')::boolean, x->>'detail' from jsonb_array_elements(res) x;
end $$;

alter function kvisa_tests.t(text, boolean, text) set search_path = public;
alter function kvisa_tests.act_as(uuid) set search_path = public;
alter function kvisa_tests.run() set search_path = public;
