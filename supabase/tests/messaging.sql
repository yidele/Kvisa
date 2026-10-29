-- Kvisa WhatsApp/SMS job-post & reply tests. Requires business_rules.sql (kvisa_tests.t / act_as).
-- Usage: select * from kvisa_tests.run_messaging();   -- everything is rolled back

create or replace function kvisa_tests.run_messaging()
returns table (test text, ok boolean, detail text)
language plpgsql set search_path = public as $$
declare
  res jsonb := '[]'::jsonb;
  u_disp uuid := gen_random_uuid(); u_a uuid := gen_random_uuid(); u_c uuid := gen_random_uuid();
  p_a uuid; p_b uuid; p_c uuid; p_x uuid; p_w uuid;
  v_client uuid; o1 uuid; o2 uuid; o3 uuid; o4 uuid; o5 uuid;
  v_json jsonb; v_ok boolean; v_txt text; v_cnt int; v_n int; v_id uuid;
  grp text := '120363000000000001@g.us';
  base timestamptz := now() - interval '5 hours';
begin
  begin
    grant usage on schema kvisa_tests to authenticated;
    grant execute on all functions in schema kvisa_tests to authenticated;
    perform kvisa_tests.act_as(null);
    update public.organization_settings set phone_country_code = '1', wa_enabled = false, sms_enabled = false,
      wa_group_id = null, msg_send_address = true where id = 1;

    -- ---- phone numbers ----
    res := res || kvisa_tests.t('M0 Phone numbers are normalised for sending and matching',
      public._phone_e164('(718) 555-0101') = '17185550101' and public._phone_e164('1-718-555-0101') = '17185550101'
      and public._phone_e164('+972 50-123-4567') = '972501234567' and public._phone_e164('00972501234567') = '972501234567'
      and public._phone_e164('0501234567') = '1501234567' and public._phone_e164('') is null and public._phone_e164('123') is null,
      public._phone_e164('(718) 555-0101'));

    -- ---- setup ----
    insert into public.client_categories (id, label) values ('zz_msg', 'ZZ Msg');
    insert into public.people (full_name, phone) values ('M Driver A', '(718) 555-0101') returning id into p_a;
    insert into public.people (full_name, phone) values ('M Driver B', '718-555-0102') returning id into p_b;
    insert into public.people (full_name, phone) values ('M Driver C', '718 555 0103') returning id into p_c;
    insert into public.people (full_name, phone) values ('M Driver X', null) returning id into p_x;
    insert into public.people (full_name, phone, address) values ('M Washer W', '7185550109', '45 Maple Avenue #2, Brooklyn NY 11230') returning id into p_w;
    insert into public.person_roles (person_id, role) values (p_a,'driver'),(p_b,'driver'),(p_c,'driver'),(p_x,'driver'),(p_w,'washer');
    update public.person_roles set active = false where role = 'driver' and person_id not in (p_a, p_b, p_c, p_x);
    insert into public.invites (email, roles, person_id) values ('m-disp@kvisa.test','{dispatcher}',null),
      ('m-a@kvisa.test','{driver}',p_a), ('m-c@kvisa.test','{driver}',p_c);
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, '{}', '{}', now(), now()
    from (values (u_disp,'m-disp@kvisa.test'),(u_a,'m-a@kvisa.test'),(u_c,'m-c@kvisa.test')) v(u,e);
    insert into public.user_roles (user_id, role) values (u_disp, 'dispatcher') on conflict do nothing;
    insert into public.clients (name, category_id, phone, pickup_address, default_return_address, access_instructions)
      values ('Msg Test Client', 'zz_msg', '555-0199', '12 Main Street, Apt 4B, Brooklyn NY 11230', '9 Other Road, Brooklyn NY', 'Gate code 4417')
      returning id into v_client;

    perform kvisa_tests.act_as(u_disp);
    o1 := public.create_order(jsonb_build_object('client_id', v_client, 'expected_bags', 4, 'pickup_at', base, 'washer_id', p_w));
    o2 := public.create_order(jsonb_build_object('client_id', v_client, 'expected_bags', 3, 'pickup_at', base + interval '1 min', 'washer_id', p_w));
    o3 := public.create_order(jsonb_build_object('client_id', v_client, 'expected_bags', 2, 'pickup_at', base + interval '2 min', 'washer_id', p_w));
    o4 := public.create_order(jsonb_build_object('client_id', v_client, 'expected_bags', 1, 'pickup_at', base + interval '3 min', 'washer_id', p_w));
    o5 := public.create_order(jsonb_build_object('client_id', v_client, 'expected_bags', 1, 'pickup_at', base + interval '4 min', 'washer_id', p_w));

    -- ---- posting needs the channel to be set up ----
    v_ok := false;
    begin perform public.post_jobs(array[(select id from public.order_tasks where order_id = o1 and task_type = 'pickup')], null, '{whatsapp}');
    exception when others then v_ok := sqlerrm like '%WhatsApp is not set up%'; end;
    res := res || kvisa_tests.t('M1 Posting to WhatsApp is refused until WhatsApp is set up', v_ok);
    perform kvisa_tests.act_as(null);
    update public.organization_settings set wa_enabled = true, sms_enabled = true, wa_group_id = grp where id = 1;

    -- ---- post two jobs to the group and by SMS ----
    perform kvisa_tests.act_as(u_disp);
    v_json := public.job_post_preview(array[(select id from public.order_tasks where order_id = o2 and task_type = 'pickup'),
                                            (select id from public.order_tasks where order_id = o1 and task_type = 'pickup')], null);
    res := res || kvisa_tests.t('M2 Preview numbers the jobs by time, starting at 1',
      (v_json->'items'->0->>'item_no')::int = 1 and (v_json->'items'->1->>'item_no')::int = 2
      and v_json->>'body' like '%1. Pickup from client — Main Street → Maple Avenue%', v_json->>'body');
    v_json := public.post_jobs(array[(select id from public.order_tasks where order_id = o2 and task_type = 'pickup'),
                                     (select id from public.order_tasks where order_id = o1 and task_type = 'pickup')],
                               'Jobs today:', '{whatsapp,sms}');
    v_txt := v_json->>'body';
    res := res || kvisa_tests.t('M3 Post creates numbered job offers (1 = earliest pickup)',
      (v_json->>'jobs')::int = 2
      and (select item_no from public.job_post_items where order_id = o1) = 1
      and (select item_no from public.job_post_items where order_id = o2) = 2
      and (select count(*) from public.task_offers f join public.job_post_items i on i.offer_id = f.id where f.status = 'available') = 2
      and v_txt like 'Jobs today:%1. Pickup from client — Main Street → Maple Avenue — % — 4 bags%2. Pickup from client%3 bags%Reply DONE%', v_txt);
    res := res || kvisa_tests.t('M3 The post shows street names only — no house number, apartment, city, phone or gate code',
      v_txt not like '%12 Main%' and v_txt not like '%4B%' and v_txt not like '%Brooklyn%' and v_txt not like '%555%' and v_txt not like '%4417%', v_txt);
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('M3 One message is queued for the group and one SMS per driver with a phone',
      (select count(*) from public.message_outbox where channel = 'whatsapp' and to_kind = 'group' and to_address = grp and purpose = 'post') = 1
      and (select count(*) from public.message_outbox where channel = 'sms' and purpose = 'post') = 3
      and (select array_agg(to_address order by to_address) from public.message_outbox where channel = 'sms' and purpose = 'post')
          = array['17185550101','17185550102','17185550103']);

    perform kvisa_tests.act_as(u_disp);
    v_ok := false;
    begin perform public.post_jobs(array[(select id from public.order_tasks where order_id = o1 and task_type = 'pickup')], null, '{whatsapp}');
    exception when others then v_ok := sqlerrm like '%already posted as job 1%'; end;
    res := res || kvisa_tests.t('M4 A job that is still open cannot be posted twice', v_ok);
    v_json := public.job_post_preview(array[(select id from public.order_tasks where order_id = o3 and task_type = 'pickup')], null);
    res := res || kvisa_tests.t('M4 A new post continues after the open numbers', (v_json->'items'->0->>'item_no')::int = 3, v_json::text);

    -- ---- drivers cannot post, read the message log, or fake an incoming message ----
    perform kvisa_tests.act_as(u_a);
    v_ok := false;
    begin perform public.post_jobs(array[gen_random_uuid()], null, '{}'); exception when others then v_ok := sqlerrm like '%only administrators and dispatchers%'; end;
    res := res || kvisa_tests.t('M5 Drivers cannot post jobs', v_ok);
    res := res || kvisa_tests.t('M5 Drivers cannot read posts or messages',
      (select count(*) from public.message_outbox) = 0 and (select count(*) from public.message_inbox) = 0
      and (select count(*) from public.job_posts) = 0 and (select count(*) from public.job_post_items) = 0);
    v_ok := false;
    begin perform public.message_inbound('whatsapp', '17185550101', '2', 'fake-1'); exception when insufficient_privilege then v_ok := true; end;
    res := res || kvisa_tests.t('M5 Only the server can submit incoming messages', v_ok);
    v_ok := false;
    begin perform public.outbox_claim(10); exception when insufficient_privilege then v_ok := true; end;
    res := res || kvisa_tests.t('M5 Only the server can claim messages to send', v_ok);
    perform set_config('kvisa.as_person', p_b::text, true);
    res := res || kvisa_tests.t('M5 A signed-in user cannot act as someone else', public.my_person_id() = p_a);
    perform set_config('kvisa.as_person', '', true);

    -- ---- incoming replies ----
    perform kvisa_tests.act_as(null);
    v_json := public.message_inbound('whatsapp', '19995550000', '1', 'w-unknown');
    res := res || kvisa_tests.t('M6 A number from an unknown phone gets no reply and changes nothing',
      v_json->>'outcome' = 'unknown_sender' and (select count(*) from public.message_outbox where purpose = 'reply') = 0
      and (select assignee_id from public.order_tasks where order_id = o1 and task_type = 'pickup') is null);
    v_json := public.message_inbound('whatsapp', '17185550101', 'Hi, running 5 min late', 'w-chat');
    res := res || kvisa_tests.t('M6 Ordinary chat from a driver is left for the dispatcher (no auto-reply)',
      v_json->>'outcome' = 'ignored' and (select count(*) from public.message_outbox where purpose = 'reply') = 0);

    perform kvisa_tests.act_as(null);
    v_json := public.message_inbound('whatsapp', '17185550101', '2', 'w-a-2');
    v_txt := v_json->>'reply';
    res := res || kvisa_tests.t('M7 Replying "2" gives driver A job 2',
      v_json->>'outcome' = 'take' and (select assignee_id from public.order_tasks where order_id = o2 and task_type = 'pickup') = p_a
      and (select status from public.task_offers f join public.job_post_items i on i.offer_id = f.id where i.order_id = o2) = 'accepted', v_txt);
    res := res || kvisa_tests.t('M7 …and the private reply has the full job details',
      v_txt like 'Job 2 is yours: Pickup from client + Drop-off to washer (K-%' and v_txt like '%From: 12 Main Street, Apt 4B%' and v_txt like '%To: 45 Maple Avenue #2%'
      and v_txt like '%Contact: % 555-0199%' and v_txt like '%Gate code 4417%' and v_txt like '%Reply DONE%', v_txt);
    res := res || kvisa_tests.t('M7 …sent back by WhatsApp to the same number',
      exists (select 1 from public.message_outbox where purpose = 'reply' and channel = 'whatsapp' and to_address = '17185550101' and person_id = p_a));
    select body into v_txt from public.message_outbox where purpose = 'covered' order by created_at desc limit 1;
    res := res || kvisa_tests.t('M7 …and the group gets "2 covered @driver" with the driver tagged',
      v_txt = '2 covered @17185550101'
      and (select mentions from public.message_outbox where purpose = 'covered' order by created_at desc limit 1) = array['17185550101']
      and (select to_address from public.message_outbox where purpose = 'covered' order by created_at desc limit 1) = grp
      and (select covered_person_id from public.job_post_items where order_id = o2) = p_a, v_txt);
    v_cnt := (select count(*) from public.message_outbox);
    v_json := public.message_inbound('whatsapp', '17185550101', '2', 'w-a-2');
    res := res || kvisa_tests.t('M8 The same message delivered twice is handled once',
      v_json->>'outcome' = 'duplicate' and (select count(*) from public.message_outbox) = v_cnt);

    v_json := public.message_inbound('sms', '+1 (718) 555-0102', '2', 'SM-b-2');
    res := res || kvisa_tests.t('M9 A second driver asking for a covered job is told it is taken (by SMS)',
      v_json->>'reply' = 'Sorry, job 2 is already covered.'
      and (select assignee_id from public.order_tasks where order_id = o2 and task_type = 'pickup') = p_a
      and exists (select 1 from public.message_outbox where purpose = 'reply' and channel = 'sms' and to_address = '17185550102'), v_json->>'reply');
    v_json := public.message_inbound('sms', '+17185550102', '#1.', 'SM-b-1');
    res := res || kvisa_tests.t('M9 "#1." also works and gives B job 1',
      (select assignee_id from public.order_tasks where order_id = o1 and task_type = 'pickup') = p_b, v_json->>'reply');
    v_json := public.message_inbound('whatsapp', '17185550101', '2', 'w-a-2b');
    res := res || kvisa_tests.t('M9 Asking again for your own job says it is already yours', v_json->>'reply' = 'Job 2 is already yours.', v_json->>'reply');
    res := res || kvisa_tests.t('M9 With everything covered, numbering starts again at 1', public._next_item_no() = 1);

    -- ---- DONE ----
    res := res || kvisa_tests.t('M10 Taking a pickup also gives the driver the drop-off to the washer (same trip)',
      (select assignee_id from public.order_tasks where order_id = o2 and task_type = 'dropoff') = p_a
      and (select mi.detail from public.message_inbox mi where mi.provider_message_id = 'w-a-2') like 'Job 2 is yours: Pickup from client + Drop-off to washer (K-%');
    v_json := public.message_inbound('whatsapp', '17185550101', 'Done!', 'w-a-done');
    res := res || kvisa_tests.t('M10 DONE records pickup and drop-off with the expected bags',
      v_json->>'outcome' = 'done'
      and (select status from public.order_tasks where order_id = o2 and task_type = 'pickup') = 'completed'
      and (select status from public.order_tasks where order_id = o2 and task_type = 'dropoff') = 'completed'
      and (select actual_bags from public.order_tasks where order_id = o2 and task_type = 'dropoff') = 3
      and (select status from public.orders where id = o2) = 'awaiting_washing'
      and (select count(*) from public.order_exceptions where order_id = o2) = 0, v_json->>'reply');
    res := res || kvisa_tests.t('M10 …recorded as the driver, noted as a WhatsApp reply',
      (select count(*) from public.handoff_events where order_id = o2 and notes = 'Marked done by WhatsApp reply') = 2
      and (select from_person_id from public.handoff_events where order_id = o2 and event_type = 'delivered_to_washer') = p_a
      and v_json->>'reply' like 'Thanks! Marked done: Pickup from client + Drop-off to washer — K-%, 3 bags.%', v_json->>'reply');
    v_json := public.message_inbound('whatsapp', '17185550101', 'done', 'w-a-done2');
    res := res || kvisa_tests.t('M10 DONE with nothing open says so', v_json->>'reply' = 'You have no open jobs to mark done.', v_json->>'reply');
    v_json := public.message_inbound('whatsapp', '17185550109', 'done', 'w-w-done');
    res := res || kvisa_tests.t('M11 The washer''s DONE confirms receipt and completes washing',
      (select status from public.order_tasks where order_id = o2 and task_type = 'washing') = 'completed'
      and exists (select 1 from public.handoff_events where order_id = o2 and event_type = 'received_by_washer' and actual_bags = 3)
      and (select status from public.orders where id = o2) = 'ready_for_return', v_json->>'reply');

    -- B has two ready jobs → DONE asks which; "DONE 1" picks job 1
    perform kvisa_tests.act_as(u_disp);
    perform public.post_jobs(array[(select id from public.order_tasks where order_id = o3 and task_type = 'pickup')], null, '{whatsapp}');
    perform kvisa_tests.act_as(null);
    v_n := (select item_no from public.job_post_items where order_id = o3);
    v_json := public.message_inbound('whatsapp', '17185550109', v_n::text, 'w-w-1');
    res := res || kvisa_tests.t('M12 A washer replying a job number is told only drivers take jobs',
      v_json->>'reply' like 'Only drivers can take job%'
      and (select assignee_id from public.order_tasks where order_id = o3 and task_type = 'pickup') is null, v_json->>'reply');
    perform public.message_inbound('sms', '7185550102', v_n::text, 'SM-b-3');
    v_json := public.message_inbound('sms', '7185550102', 'done', 'SM-b-done');
    res := res || kvisa_tests.t('M12 DONE with two open jobs asks which one (by order number, since both were "job 1")',
      v_n = 1 and v_json->>'reply' like 'You have more than one job open.%DONE K-' || (select order_no from public.orders where id = o1)
        || ' — Pickup from client%DONE K-' || (select order_no from public.orders where id = o3) || ' — Pickup from client%'
      and (select status from public.order_tasks where order_id = o1 and task_type = 'pickup') = 'pending', v_json->>'reply');
    v_json := public.message_inbound('sms', '7185550102', 'Done K-' || (select order_no from public.orders where id = o1), 'SM-b-done1');
    res := res || kvisa_tests.t('M12 "DONE K-…" completes that job only, noted as a text reply',
      (select status from public.order_tasks where order_id = o1 and task_type = 'pickup') = 'completed'
      and (select status from public.order_tasks where order_id = o3 and task_type = 'pickup') = 'pending'
      and exists (select 1 from public.handoff_events where order_id = o1 and notes = 'Marked done by text message reply'), v_json->>'reply');
    v_json := public.message_inbound('sms', '7185550102', 'done 1', 'SM-b-done3');
    res := res || kvisa_tests.t('M12 "DONE 1" means the job 1 they took most recently',
      (select status from public.order_tasks where order_id = o3 and task_type = 'pickup') = 'completed', v_json->>'reply');

    -- ---- the dispatcher assigns a posted job directly ----
    perform kvisa_tests.act_as(u_disp);
    perform public.post_jobs(array[(select id from public.order_tasks where order_id = o4 and task_type = 'pickup')], null, '{whatsapp}');
    v_n := (select item_no from public.job_post_items where order_id = o4);
    update public.order_tasks set assignee_id = p_x where order_id = o4 and task_type = 'pickup';
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('M13 Assigning a posted job directly closes the offer and tells the group',
      (select status from public.task_offers f join public.job_post_items i on i.offer_id = f.id where i.order_id = o4) = 'cancelled'
      and (select body from public.message_outbox where purpose = 'covered' order by created_at desc limit 1) = v_n || ' covered M Driver X',
      (select body from public.message_outbox where purpose = 'covered' order by created_at desc limit 1));
    v_json := public.message_inbound('whatsapp', '17185550101', v_n::text, 'w-a-late');
    res := res || kvisa_tests.t('M13 …so a later reply for it is told it is covered',
      v_json->>'reply' = format('Sorry, job %s is already covered.', v_n)
      and (select assignee_id from public.order_tasks where order_id = o4 and task_type = 'pickup') = p_x, v_json->>'reply');

    -- ---- accepting in the app also posts "covered" ----
    perform kvisa_tests.act_as(u_disp);
    perform public.post_jobs(array[(select id from public.order_tasks where order_id = o5 and task_type = 'pickup')], null, '{whatsapp}');
    select item_no, offer_id into v_n, v_id from public.job_post_items where order_id = o5;
    perform kvisa_tests.act_as(u_c);
    perform public.respond_offer(v_id, true);
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('M14 Accepting a posted job in the app also posts "covered" in the group',
      (select body from public.message_outbox where purpose = 'covered' order by created_at desc limit 1) = v_n || ' covered @17185550103');

    -- ---- address setting ----
    update public.organization_settings set msg_send_address = false where id = 1;
    v_txt := public._job_details((select id from public.order_tasks where order_id = o5 and task_type = 'pickup'), 9);
    res := res || kvisa_tests.t('M15 With "send address" off, replies give streets only and point to the app',
      v_txt like '%Route: Main Street → Maple Avenue%' and v_txt not like '%12 Main%' and v_txt not like '%4417%', v_txt);

    -- ---- the sender's queue ----
    perform set_config('role', 'service_role', true);
    select count(*) into v_cnt from public.outbox_claim(100);
    perform set_config('role', 'postgres', true);
    res := res || kvisa_tests.t('M16 The sender claims every pending message once',
      v_cnt > 0 and v_cnt = (select count(*) from public.message_outbox where status = 'sending')
      and (select count(*) from public.message_outbox where status = 'pending') = 0);
    select id into v_id from public.message_outbox where purpose = 'post' and channel = 'whatsapp' order by created_at limit 1;
    perform public.outbox_finish(v_id, true, 'wamid.1');
    perform public.outbox_finish((select id from public.message_outbox where status = 'sending' limit 1), false, null, 'HTTP 401 bad token');
    res := res || kvisa_tests.t('M16 Sent and failed results are recorded',
      (select status || '/' || provider_message_id from public.message_outbox where id = v_id) = 'sent/wamid.1'
      and (select count(*) from public.message_outbox where status = 'failed' and error = 'HTTP 401 bad token') = 1);
    select count(*) into v_cnt from public.outbox_claim(100) where status = 'sending' and attempts = 2;
    res := res || kvisa_tests.t('M16 A failed message is retried automatically (up to 3 tries)', v_cnt = 1);
    perform kvisa_tests.act_as(u_disp);
    v_ok := false;
    begin perform public.outbox_cancel((select id from public.message_outbox where status = 'sending' limit 1));
    exception when others then v_ok := sqlerrm like '%already sent%'; end;
    res := res || kvisa_tests.t('M16 A message being sent right now cannot be cancelled', v_ok);
    perform kvisa_tests.act_as(null);
    select id into v_id from public.message_outbox where status = 'sending' limit 1;
    perform public.outbox_finish(v_id, false, null, 'timeout');
    perform kvisa_tests.act_as(u_disp);
    perform public.outbox_cancel(v_id);
    v_txt := (select status from public.message_outbox where id = v_id);
    perform public.outbox_retry(v_id);
    res := res || kvisa_tests.t('M16 A dispatcher can cancel a failed message, or send it again',
      v_txt = 'cancelled' and (select status from public.message_outbox where id = v_id) = 'pending', v_txt);

    raise exception 'KVISA_TEST_ROLLBACK';
  exception when others then
    if sqlerrm <> 'KVISA_TEST_ROLLBACK' then res := res || kvisa_tests.t('!! Unexpected error', false, sqlerrm); end if;
  end;
  return query select x->>'test', (x->>'ok')::boolean, x->>'detail' from jsonb_array_elements(res) x;
end $$;
