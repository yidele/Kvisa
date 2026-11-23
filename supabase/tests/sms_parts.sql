-- Kvisa SMS per-part sending & daily cap tests (migration 013). Synthetic data only; rolled back.
-- Requires business_rules.sql (kvisa_tests.t / act_as) and sms_consent.sql (sms_configure / sms_enroll).
-- The sender's per-part protocol is driven here exactly as the Edge Function drives it:
-- outbox_claim → sms_part_begin → (provider call) → sms_part_finish → outbox_finish.
-- Usage: select * from kvisa_tests.run_sms_parts();

create or replace function kvisa_tests.sms_queue(p_person uuid, p_phone text, p_body text default 'synthetic text')
returns uuid language plpgsql set search_path = public as $$
declare v uuid;
begin
  insert into public.message_outbox (channel, to_kind, to_address, person_id, body, purpose)
    values ('sms', 'person', p_phone, p_person, p_body, 'reply') returning id into v;
  return v;
end $$;

create or replace function kvisa_tests.sms_claim() returns void language plpgsql set search_path = public as $$
begin
  perform set_config('role', 'service_role', true);
  perform count(*) from public.outbox_claim(100);
  perform set_config('role', 'postgres', true);
end $$;

create or replace function kvisa_tests.run_sms_parts()
returns table (test text, ok boolean, detail text)
language plpgsql set search_path = public as $$
declare
  res jsonb := '[]'::jsonb;
  u_disp uuid := gen_random_uuid(); u_drv uuid := gen_random_uuid();
  p_hana uuid; p_ivo uuid; p_jo uuid; p_kim uuid;
  hana text := '12125550151'; ivo text := '12125550152'; jo text := '12125550153'; kim text := '12125550154';
  r1 uuid; r2 uuid; r3 uuid; v_txt text; v_ok boolean; v_cnt int;
begin
  begin
    grant usage on schema kvisa_tests to authenticated;
    grant execute on all functions in schema kvisa_tests to authenticated;
    perform kvisa_tests.act_as(null);
    insert into public.people (full_name, phone) values ('P Hana', '212-555-0151') returning id into p_hana;
    insert into public.people (full_name, phone) values ('P Ivo', '212-555-0152') returning id into p_ivo;
    insert into public.people (full_name, phone) values ('P Jo', '212-555-0153') returning id into p_jo;
    insert into public.people (full_name, phone) values ('P Kim', '212-555-0154') returning id into p_kim;
    insert into public.person_roles (person_id, role) values (p_hana,'driver'),(p_ivo,'driver'),(p_jo,'driver'),(p_kim,'driver');
    insert into public.invites (email, roles, person_id) values ('p-disp@kvisa.test','{dispatcher}',null), ('p-drv@kvisa.test','{driver}',p_hana);
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, '{}', '{}', now(), now()
    from (values (u_disp,'p-disp@kvisa.test'),(u_drv,'p-drv@kvisa.test')) v(u,e);
    insert into public.user_roles (user_id, role) values (u_disp, 'dispatcher') on conflict do nothing;
    perform kvisa_tests.sms_configure();
    update public.organization_settings set sms_max_per_day = 20, sms_help_reply_by_app = false where id = 1;
    perform kvisa_tests.sms_enroll(u_disp, p_hana);
    perform kvisa_tests.sms_enroll(u_disp, p_ivo);
    perform kvisa_tests.sms_enroll(u_disp, p_jo);
    perform kvisa_tests.sms_enroll(u_disp, p_kim);

    -- ---------------- P1: STOP arrives between parts ----------------
    r1 := kvisa_tests.sms_queue(p_hana, hana);
    perform kvisa_tests.sms_claim();
    v_txt := public.sms_part_begin(r1, 1, 3);
    perform public.sms_part_finish(r1, 1, 'accepted', 'SMpart1');
    perform public.message_inbound('sms', '+' || hana, 'STOP', 'p1-stop');
    res := res || kvisa_tests.t('P1 Part 1 was sent normally', v_txt = 'send', v_txt);
    v_txt := public.sms_part_begin(r1, 2, 3);
    res := res || kvisa_tests.t('P1 After STOP, the next part is refused right before its provider call',
      v_txt = 'stop:the recipient opted out', v_txt);
    res := res || kvisa_tests.t('P1 …the message stops for good and says how far it got',
      (select status = 'cancelled' and error = 'Not sent: the recipient opted out (stopped after 1 of 3 parts)' from public.message_outbox where id = r1)
      and (select count(*) from public.message_outbox_parts where outbox_id = r1) = 1,
      (select error from public.message_outbox where id = r1));

    -- ---------------- P2: first part accepted, later part refused → retry skips the accepted part ----------------
    r2 := kvisa_tests.sms_queue(p_ivo, ivo);
    perform kvisa_tests.sms_claim();
    perform public.sms_part_begin(r2, 1, 3);
    perform public.sms_part_finish(r2, 1, 'accepted', 'SMivo1');
    perform public.sms_part_begin(r2, 2, 3);
    perform public.sms_part_finish(r2, 2, 'failed', null, 'HTTP 400: synthetic refusal');
    perform public.outbox_finish(r2, false, null, 'HTTP 400: synthetic refusal');
    res := res || kvisa_tests.t('P2 A definite refusal of part 2 leaves the message failed (retryable)',
      (select status from public.message_outbox where id = r2) = 'failed');
    perform kvisa_tests.sms_claim();
    res := res || kvisa_tests.t('P2 On retry, the part Twilio already accepted is skipped, not resent',
      public.sms_part_begin(r2, 1, 3) = 'skip'
      and (select attempts = 1 and provider_message_id = 'SMivo1' from public.message_outbox_parts where outbox_id = r2 and part_no = 1));
    v_txt := public.sms_part_begin(r2, 2, 3);
    res := res || kvisa_tests.t('P2 …and only the refused part is sent again',
      v_txt = 'send' and (select attempts from public.message_outbox_parts where outbox_id = r2 and part_no = 2) = 2);
    perform public.sms_part_finish(r2, 2, 'accepted', 'SMivo2');
    perform public.sms_part_begin(r2, 3, 3);
    perform public.sms_part_finish(r2, 3, 'accepted', 'SMivo3');
    perform public.outbox_finish(r2, true, 'SMivo1');
    res := res || kvisa_tests.t('P2 The message completes with each part accepted exactly once',
      (select status from public.message_outbox where id = r2) = 'sent'
      and (select count(*) from public.message_outbox_parts where outbox_id = r2 and status = 'accepted') = 3
      and (select count(distinct provider_message_id) from public.message_outbox_parts where outbox_id = r2) = 3);

    -- ---------------- P3: unclear outcome (timeout / network) → manual review, never auto-resent ----------------
    r3 := kvisa_tests.sms_queue(p_jo, jo);
    perform kvisa_tests.sms_claim();
    perform public.sms_part_begin(r3, 1, 2);
    perform public.sms_part_finish(r3, 1, 'unknown', null, 'network error: synthetic timeout');
    res := res || kvisa_tests.t('P3 An unclear provider outcome moves the message to needs_review',
      (select status = 'needs_review' and error like 'Unclear whether part 1 reached Twilio%' from public.message_outbox where id = r3));
    res := res || kvisa_tests.t('P3 …later parts are not attempted',
      public.sms_part_begin(r3, 2, 2) = 'stop:not claimed' and (select count(*) from public.message_outbox_parts where outbox_id = r3) = 1);
    perform kvisa_tests.sms_claim();
    res := res || kvisa_tests.t('P3 The sender never picks it up again by itself', (select status from public.message_outbox where id = r3) = 'needs_review');
    perform kvisa_tests.act_as(u_disp);
    v_ok := false;
    begin perform public.outbox_retry(r3); exception when others then v_ok := sqlerrm like '%unclear whether this text went out%'; end;
    res := res || kvisa_tests.t('P3 Plain "send again" is refused for an unclear message', v_ok);
    perform kvisa_tests.act_as(u_drv);
    v_ok := false;
    begin perform public.outbox_resolve(r3, 'not_delivered'); exception when others then v_ok := sqlerrm like '%only administrators and dispatchers%'; end;
    res := res || kvisa_tests.t('P3 Drivers cannot resolve it', v_ok);
    perform kvisa_tests.act_as(u_disp);
    perform public.outbox_resolve(r3, 'not_delivered');
    perform kvisa_tests.act_as(null);
    perform kvisa_tests.sms_claim();
    v_txt := public.sms_part_begin(r3, 1, 2);
    res := res || kvisa_tests.t('P3 After staff confirm "not delivered", it is sent again (second attempt recorded)',
      v_txt = 'send' and (select attempts from public.message_outbox_parts where outbox_id = r3 and part_no = 1) = 2);
    perform public.sms_part_finish(r3, 1, 'unknown', null, 'HTTP 503: synthetic');
    perform kvisa_tests.act_as(u_disp);
    perform public.outbox_resolve(r3, 'delivered');
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('P3 Staff "delivered" on a partly-sent message ends it without sending the rest',
      (select status from public.message_outbox where id = r3) = 'cancelled'
      and (select status from public.message_outbox_parts where outbox_id = r3 and part_no = 1) = 'accepted'
      and not exists (select 1 from public.message_outbox_parts where outbox_id = r3 and part_no = 2));

    -- ---------------- P4: sender crashed between begin and finish ----------------
    r1 := kvisa_tests.sms_queue(p_kim, kim);
    perform kvisa_tests.sms_claim();
    perform public.sms_part_begin(r1, 1, 1);      -- provider call made, no answer recorded
    update public.message_outbox set locked_at = now() - interval '10 minutes' where id = r1;
    perform kvisa_tests.sms_claim();
    res := res || kvisa_tests.t('P4 An abandoned mid-send text goes to needs_review, not resent or cancelled',
      (select status = 'needs_review' and error like 'The sender stopped mid-send%' from public.message_outbox where id = r1));
    r2 := kvisa_tests.sms_queue(p_kim, kim);
    perform kvisa_tests.sms_claim();
    perform public.sms_part_begin(r2, 1, 2);
    perform public.sms_part_finish(r2, 1, 'accepted', 'SMk1');
    v_txt := public.sms_part_begin(r2, 2, 3);
    res := res || kvisa_tests.t('P4 A different part count than recorded before is treated as unclear',
      v_txt = 'stop:needs_review' and (select status from public.message_outbox where id = r2) = 'needs_review');

    -- ---------------- P5: daily cap per number (parts; all purposes) ----------------
    update public.organization_settings set sms_max_per_day = 3 where id = 1;
    -- Ivo already has 3 accepted parts today (P2)
    v_cnt := public._sms_parts_today(ivo);
    r1 := kvisa_tests.sms_queue(p_ivo, ivo);
    res := res || kvisa_tests.t('P5 At the cap, a new text is cancelled at the queue',
      v_cnt = 3 and (select status = 'cancelled' and error = 'Not sent: daily text limit reached for this number' from public.message_outbox where id = r1),
      v_cnt::text);
    perform kvisa_tests.act_as(u_disp);
    v_ok := false;
    begin perform public.outbox_retry(r1); exception when others then v_ok := sqlerrm like '%daily text limit%'; end;
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('P5 …and cannot be resent by staff while the cap is reached', v_ok);
    -- Jo: 1 accepted part today (P3). One more part ends unclear → it counts too (2). A new 2-part text: only 1 fits.
    r2 := kvisa_tests.sms_queue(p_jo, jo);
    perform kvisa_tests.sms_claim();
    perform public.sms_part_begin(r2, 1, 1);
    perform public.sms_part_finish(r2, 1, 'unknown', null, 'network error: synthetic');
    r3 := kvisa_tests.sms_queue(p_jo, jo);
    perform kvisa_tests.sms_claim();
    v_txt := public.sms_part_begin(r3, 1, 2);
    perform public.sms_part_finish(r3, 1, 'accepted', 'SMjo1');
    v_cnt := public._sms_parts_today(jo);
    v_ok := v_txt = 'send';
    v_txt := public.sms_part_begin(r3, 2, 2);
    res := res || kvisa_tests.t('P5 Unclear parts count toward the cap (conservative): only one more part fits for Jo',
      v_cnt = 3 and v_ok and v_txt = 'stop:daily text limit reached for this number'
      and (select error from public.message_outbox where id = r3) = 'Not sent: daily text limit reached for this number (stopped after 1 of 2 parts)',
      (select error from public.message_outbox where id = r3));
    -- refused parts do not count
    update public.message_outbox_parts set local_day = public._today() - 1 where to_address = kim;
    r3 := kvisa_tests.sms_queue(p_kim, kim);
    perform kvisa_tests.sms_claim();
    perform public.sms_part_begin(r3, 1, 1);
    perform public.sms_part_finish(r3, 1, 'failed', null, 'HTTP 400: synthetic');
    res := res || kvisa_tests.t('P5 Parts Twilio definitely refused do not count toward the cap', public._sms_parts_today(kim) = 0);
    -- the cap is per local calendar day
    update public.message_outbox_parts set local_day = public._today() - 1 where to_address = ivo;
    perform kvisa_tests.act_as(u_disp);
    perform public.outbox_retry(r1);
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('P5 The next day the same number may receive texts again',
      (select status from public.message_outbox where id = r1) = 'pending');

    -- ---------------- P6: enrollment/control traffic cannot be used to send unsolicited texts ----------------
    update public.organization_settings set sms_help_reply_by_app = true, sms_max_per_day = 20 where id = 1;
    v_cnt := (select count(*) from public.message_outbox where to_address = '19995550001');
    perform public.message_inbound('sms', '+19995550001', 'HELP', 'p6-h1');
    perform kvisa_tests.sms_claim();
    perform public.sms_part_begin((select id from public.message_outbox where to_address = '19995550001' and purpose = 'help'), 1, 1);
    perform public.sms_part_finish((select id from public.message_outbox where to_address = '19995550001' and purpose = 'help'), 1, 'accepted', 'SMh1');
    for i in 2..6 loop perform public.message_inbound('sms', '+19995550001', 'HELP', 'p6-h' || i); end loop;
    for i in 1..5 loop perform public.message_inbound('sms', '+19995550001', 'JOIN 12345' || i, 'p6-j' || i); end loop;
    perform public.message_inbound('sms', '+19995550001', 'YES', 'p6-y');
    perform public.message_inbound('sms', '+19995550001', 'START', 'p6-s');
    res := res || kvisa_tests.t('P6 A stranger texting HELP repeatedly gets one answer a day; JOIN/YES/START get none',
      v_cnt = 0 and (select count(*) from public.message_outbox where to_address = '19995550001' and status <> 'cancelled') = 1);

    raise exception 'KVISA_TEST_ROLLBACK';
  exception when others then
    if sqlerrm <> 'KVISA_TEST_ROLLBACK' then res := res || kvisa_tests.t('!! Unexpected error', false, sqlerrm); end if;
  end;
  return query select x->>'test', (x->>'ok')::boolean, x->>'detail' from jsonb_array_elements(res) x;
end $$;
