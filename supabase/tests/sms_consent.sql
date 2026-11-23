-- Kvisa SMS consent & safety tests (migration 012). Synthetic data only; everything is rolled back.
-- Requires business_rules.sql (kvisa_tests.t / act_as).
-- Usage: select * from kvisa_tests.run_sms();
-- Also provides helpers used by messaging.sql: kvisa_tests.sms_configure(), kvisa_tests.sms_enroll().

-- Fill every required SMS setting with obviously fake values and switch SMS on (tests only).
create or replace function kvisa_tests.sms_configure(p_enabled boolean default true) returns void
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from public.sms_disclosures where version = 'test-v1') then
    insert into public.sms_disclosures (version, body) values ('test-v1',
      'SYNTHETIC TEST DISCLOSURE: example program texts. Frequency varies. Msg & data rates may apply. STOP to stop, HELP for help.');
  end if;
  update public.organization_settings set sms_program_number = '+15550100000', sms_support_email = 'support@example.test',
    sms_terms_url = 'https://example.test/terms', sms_privacy_url = 'https://example.test/privacy', sms_retention_days = 365,
    sms_participant_type = 'volunteer', sms_max_per_day = 5, sms_consent_version = 'test-v1', sms_enabled = p_enabled where id = 1;
end $$;

-- Run the full chain for one person: operator approval → code → person texts JOIN → confirmation sent → YES.
create or replace function kvisa_tests.sms_enroll(p_staff uuid, p_person uuid) returns text
language plpgsql set search_path = public as $$
declare v_e uuid; v_code text; v_phone text;
begin
  perform kvisa_tests.act_as(p_staff);
  v_e := public.sms_approve(p_person);
  v_code := public.sms_issue_code(v_e)->>'code';
  perform kvisa_tests.act_as(null);
  select phone_e164 into v_phone from public.sms_enrollments where id = v_e;
  perform public.message_inbound('sms', '+' || v_phone, 'JOIN ' || v_code, 'enroll-join-' || v_e);
  update public.message_outbox set status = 'sent', sent_at = now()
    where id = (select confirm_outbox_id from public.sms_enrollments where id = v_e);
  perform public.message_inbound('sms', '+' || v_phone, 'YES', 'enroll-yes-' || v_e);
  return (select status from public.sms_enrollments where id = v_e);
end $$;

create or replace function kvisa_tests.run_sms()
returns table (test text, ok boolean, detail text)
language plpgsql set search_path = public as $$
declare
  res jsonb := '[]'::jsonb;
  u_admin uuid := gen_random_uuid(); u_disp uuid := gen_random_uuid(); u_drv uuid := gen_random_uuid();
  p_dana uuid; p_eli uuid; p_fay uuid; p_gil uuid; p_nophone uuid; p_norole uuid; p_wash uuid;
  v_client uuid; o1 uuid; o2 uuid;
  e_dana uuid; e_eli uuid; e_fay uuid; e_dana2 uuid; v_code text; v_code2 text; v_json jsonb; v_ok boolean; v_txt text; v_id uuid; v_cnt int;
  dana text := '12125550141'; eli text := '12125550142'; fay text := '12125550143'; gil text := '12125550144';
  base timestamptz := now() - interval '5 hours';
begin
  begin
    grant usage on schema kvisa_tests to authenticated;
    grant execute on all functions in schema kvisa_tests to authenticated;
    perform kvisa_tests.act_as(null);

    -- ---------------- setup (synthetic) ----------------
    insert into public.client_categories (id, label) values ('zz_sms', 'ZZ SMS');
    insert into public.people (full_name, phone) values ('S Dana', '(212) 555-0141') returning id into p_dana;
    insert into public.people (full_name, phone) values ('S Eli', '212-555-0142') returning id into p_eli;
    insert into public.people (full_name, phone) values ('S Fay', '212 555 0143') returning id into p_fay;
    insert into public.people (full_name, phone) values ('S Gil', '2125550144') returning id into p_gil;
    insert into public.people (full_name, phone) values ('S NoPhone', null) returning id into p_nophone;
    insert into public.people (full_name, phone) values ('S NoRole', '212-555-0149') returning id into p_norole;
    insert into public.people (full_name, phone, address) values ('S Washer', '212-555-0148', '45 Maple Avenue, Testville') returning id into p_wash;
    insert into public.person_roles (person_id, role) values (p_dana,'driver'),(p_eli,'driver'),(p_fay,'driver'),(p_gil,'driver'),(p_nophone,'driver'),(p_wash,'washer');
    update public.person_roles set active = false where role = 'driver' and person_id not in (p_dana, p_eli, p_fay, p_gil, p_nophone);
    insert into public.invites (email, roles, person_id) values ('s-admin@kvisa.test','{admin}',null), ('s-disp@kvisa.test','{dispatcher}',null),
      ('s-drv@kvisa.test','{driver}',p_dana);
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e, '{}', '{}', now(), now()
    from (values (u_admin,'s-admin@kvisa.test'),(u_disp,'s-disp@kvisa.test'),(u_drv,'s-drv@kvisa.test')) v(u,e);
    insert into public.user_roles (user_id, role) values (u_admin, 'admin'), (u_disp, 'dispatcher') on conflict do nothing;
    insert into public.clients (name, category_id, phone, pickup_address) values ('SMS Test Client', 'zz_sms', '555-0199', '12 Main Street, Testville')
      returning id into v_client;
    update public.organization_settings set sms_enabled = false, wa_enabled = false, sms_help_reply_by_app = false,
      sms_consent_version = null, sms_program_number = null, sms_support_email = null, sms_support_phone = null,
      sms_terms_url = null, sms_privacy_url = null, sms_retention_days = null, sms_participant_type = null, sms_max_per_day = null where id = 1;

    -- ---------------- S0: off by default, cannot be switched on half-configured ----------------
    res := res || kvisa_tests.t('S0 SMS is off by default and nobody is enrolled',
      not (select sms_enabled from public.organization_settings where id = 1) and (select count(*) from public.sms_enrollments) = 0);
    perform kvisa_tests.act_as(u_admin);
    v_ok := false;
    begin update public.organization_settings set sms_enabled = true where id = 1; exception when check_violation then v_ok := true; end;
    res := res || kvisa_tests.t('S0 SMS cannot be switched on while program details are missing', v_ok);

    -- ---------------- S1: versioned disclosure ----------------
    perform kvisa_tests.act_as(u_disp);
    v_ok := false;
    begin perform public.sms_approve(p_dana); exception when others then v_ok := sqlerrm like '%add the text-message disclosure%'; end;
    res := res || kvisa_tests.t('S1 No approval is possible before a disclosure version exists', v_ok);
    v_ok := false;
    begin perform public.sms_add_disclosure('v1', 'SYNTHETIC DISCLOSURE v1: program texts, frequency varies, msg & data rates, STOP, HELP.');
    exception when others then v_ok := sqlerrm like '%only administrators%'; end;
    res := res || kvisa_tests.t('S1 Only an administrator can add a disclosure version', v_ok);
    perform kvisa_tests.act_as(u_admin);
    perform public.sms_add_disclosure('v1', 'SYNTHETIC DISCLOSURE v1: program texts, frequency varies, msg & data rates, STOP, HELP.');
    res := res || kvisa_tests.t('S1 A new disclosure becomes the current version',
      (select sms_consent_version from public.organization_settings where id = 1) = 'v1');
    perform kvisa_tests.act_as(null);
    v_ok := false;
    begin update public.sms_disclosures set body = body || ' changed' where version = 'v1'; exception when others then v_ok := sqlerrm like '%KVISA_APPEND_ONLY%'; end;
    res := res || kvisa_tests.t('S1 A saved disclosure version can never be edited', v_ok);

    -- ---------------- S2: operator approval ----------------
    perform kvisa_tests.act_as(u_drv);
    v_ok := false;
    begin perform public.sms_approve(p_dana); exception when others then v_ok := sqlerrm like '%only administrators and dispatchers%'; end;
    res := res || kvisa_tests.t('S2 A driver cannot approve anyone for texts', v_ok);
    res := res || kvisa_tests.t('S2 Drivers cannot read approvals, opt-outs or disclosures',
      (select count(*) from public.sms_enrollments) = 0 and (select count(*) from public.sms_optouts) = 0 and (select count(*) from public.sms_disclosures) = 0);
    perform kvisa_tests.act_as(u_disp);
    v_ok := false;
    begin perform public.sms_approve(p_nophone); exception when others then v_ok := sqlerrm like '%valid mobile number%'; end;
    res := res || kvisa_tests.t('S2 A person without a valid mobile number cannot be approved', v_ok);
    v_ok := false;
    begin perform public.sms_approve(p_norole); exception when others then v_ok := sqlerrm like '%only drivers and washing volunteers%'; end;
    res := res || kvisa_tests.t('S2 Only drivers and washing volunteers can be approved', v_ok);
    e_dana := public.sms_approve(p_dana, 'Synthetic note: written card handed over');
    e_eli := public.sms_approve(p_eli);
    res := res || kvisa_tests.t('S2 Approval records who approved, when, the phone and the disclosure version',
      (select status = 'approved' and approved_by = u_disp and phone_e164 = dana and disclosure_version = 'v1'
         and evidence_note like 'Synthetic%' from public.sms_enrollments where id = e_dana));
    v_ok := false;
    begin perform public.sms_approve(p_dana); exception when others then v_ok := sqlerrm like '%already has a text-message approval%'; end;
    res := res || kvisa_tests.t('S2 A person cannot be approved twice at once', v_ok);
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('S2 Approval itself sends nothing', (select count(*) from public.message_outbox where channel = 'sms') = 0);

    -- ---------------- S3: single-use code, stored only as a hash ----------------
    perform kvisa_tests.act_as(u_disp);
    v_json := public.sms_issue_code(e_dana);
    v_code := v_json->>'code';
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('S3 The code is 6 digits, shown once, and stored only as a hash',
      v_code ~ '^[0-9]{6}$' and (v_json->>'phone_last4') = '0141'
      and (select code_hash <> v_code and length(code_hash) = 64 and status = 'code_issued' from public.sms_enrollments where id = e_dana)
      and not exists (select 1 from public.sms_enrollments e where to_jsonb(e)::text like '%"' || v_code || '"%'), v_json::text);

    -- ---------------- S4: with SMS off, nothing goes and JOIN is refused ----------------
    v_json := public.message_inbound('sms', '+' || dana, 'JOIN ' || v_code, 'sm-s4-join');
    res := res || kvisa_tests.t('S4 JOIN is refused while SMS is switched off',
      v_json->>'outcome' = 'join_rejected' and (select status from public.sms_enrollments where id = e_dana) = 'code_issued');
    insert into public.message_outbox (channel, to_kind, to_address, person_id, body, purpose)
      values ('sms', 'person', dana, p_dana, 'synthetic', 'reply') returning id into v_id;
    res := res || kvisa_tests.t('S4 A text queued while SMS is off is stored as cancelled, never pending',
      (select status = 'cancelled' and error = 'Not sent: text messages are switched off' from public.message_outbox where id = v_id));

    perform kvisa_tests.act_as(u_admin);
    update public.organization_settings set sms_program_number = '+15550100000', sms_support_email = 'support@example.test',
      sms_terms_url = 'https://example.test/terms', sms_privacy_url = 'https://example.test/privacy', sms_retention_days = 365,
      sms_participant_type = 'volunteer', sms_max_per_day = 5, sms_enabled = true where id = 1;
    perform kvisa_tests.act_as(null);

    -- ---------------- S5: before JOIN, nothing can be sent to an approved person ----------------
    insert into public.message_outbox (channel, to_kind, to_address, person_id, body, purpose)
      values ('sms', 'person', dana, p_dana, 'synthetic', 'reply') returning id into v_id;
    res := res || kvisa_tests.t('S5 Approved but not enrolled: a text to them is cancelled at the queue',
      (select status = 'cancelled' and error like '%not enrolled%' from public.message_outbox where id = v_id));

    -- ---------------- S6: JOIN must come from the approved phone with the valid code ----------------
    v_json := public.message_inbound('sms', '+' || dana, 'JOIN 000000', 'sm-s6-wrong');
    res := res || kvisa_tests.t('S6 JOIN with a wrong code is rejected and counted',
      v_json->>'outcome' = 'join_rejected' and (select failed_attempts = 1 and status = 'code_issued' from public.sms_enrollments where id = e_dana));
    v_json := public.message_inbound('sms', '+' || eli, 'JOIN ' || v_code, 'sm-s6-othernum');
    res := res || kvisa_tests.t('S6 Dana''s code texted from another approved person''s phone does not enroll anyone',
      v_json->>'outcome' = 'join_rejected' and (select status from public.sms_enrollments where id = e_eli) = 'approved');
    v_json := public.message_inbound('sms', '+19995550000', 'JOIN ' || v_code, 'sm-s6-unknown');
    res := res || kvisa_tests.t('S6 JOIN from an unknown number: rejected, and nothing is queued to it',
      v_json->>'outcome' = 'join_rejected' and not exists (select 1 from public.message_outbox where to_address = '19995550000'));
    v_json := public.message_inbound('sms', '+' || dana, 'JOIN', 'sm-s6-nocode');
    res := res || kvisa_tests.t('S6 JOIN without a code is rejected', v_json->>'outcome' = 'join_rejected');
    v_json := public.message_inbound('sms', '+' || dana, 'yes', 'sm-s6-yes');
    res := res || kvisa_tests.t('S6 YES before JOIN changes nothing', v_json->>'outcome' = 'yes_ignored'
      and (select status from public.sms_enrollments where id = e_dana) = 'code_issued');
    v_json := public.message_inbound('sms', '+' || gil, 'START', 'sm-s6-start');
    res := res || kvisa_tests.t('S6 START from a never-approved number enrolls nobody',
      v_json->>'outcome' = 'start_ignored' and not exists (select 1 from public.sms_enrollments where phone_e164 = gil));
    v_json := public.message_inbound('sms', '+' || gil, '2', 'sm-s6-take');
    res := res || kvisa_tests.t('S6 A known but never-enrolled driver texting a job number is not acted on or answered',
      v_json->>'outcome' = 'not_enrolled' and not exists (select 1 from public.message_outbox where to_address = gil));

    -- ---------------- S7: valid JOIN → one confirmation, code is single-use ----------------
    v_json := public.message_inbound('sms', '+1 (212) 555-0141', 'join ' || v_code, 'sm-s7-join');
    select body into v_txt from public.message_outbox where enrollment_id = e_dana and purpose = 'sms_confirm';
    res := res || kvisa_tests.t('S7 A valid JOIN from the approved phone records the enrollment and queues one confirmation',
      v_json->>'outcome' = 'join'
      and (select status = 'joined' and join_inbox_id is not null and joined_at is not null and code_hash is null from public.sms_enrollments where id = e_dana)
      and (select count(*) from public.message_outbox where enrollment_id = e_dana and purpose = 'sms_confirm' and status = 'pending') = 1, v_txt);
    res := res || kvisa_tests.t('S7 The confirmation names the program and gives frequency, rates, HELP, STOP, terms and privacy',
      v_txt like 'KVISA: Reply YES to confirm volunteer pickup texts from KVISA.%' and v_txt like '%up to 5/day%' and v_txt like '%Msg & data rates may apply%'
      and v_txt like '%HELP%' and v_txt like '%STOP%' and v_txt like '%https://example.test/terms%' and v_txt like '%https://example.test/privacy%', v_txt);
    v_json := public.message_inbound('sms', '+' || dana, 'JOIN ' || v_code, 'sm-s7-again');
    res := res || kvisa_tests.t('S7 The same code cannot be used twice',
      v_json->>'outcome' = 'join_rejected' and (select count(*) from public.message_outbox where enrollment_id = e_dana) = 1);

    -- ---------------- S8: YES only after the confirmation actually went out ----------------
    v_json := public.message_inbound('sms', '+' || dana, 'YES', 'sm-s8-early');
    res := res || kvisa_tests.t('S8 YES while the confirmation has not been sent yet changes nothing',
      v_json->>'outcome' = 'yes_ignored' and (select status from public.sms_enrollments where id = e_dana) = 'joined');
    update public.message_outbox set status = 'sent', sent_at = now() where enrollment_id = e_dana and purpose = 'sms_confirm';
    v_json := public.message_inbound('sms', '+' || dana, 'Yes!', 'sm-s8-yes');
    res := res || kvisa_tests.t('S8 YES after the confirmation activates the enrollment, with evidence kept',
      v_json->>'outcome' = 'confirmed' and (select status = 'active' and yes_inbox_id is not null and confirmed_at is not null
        from public.sms_enrollments where id = e_dana));
    res := res || kvisa_tests.t('S8 Approval, code, JOIN and YES are all in the audit history',
      (select count(distinct action) from public.audit_logs where entity = 'sms_enrollments' and entity_id = e_dana::text
         and action in ('sms.approved','sms.code_issued','sms.joined','sms.confirmed')) = 4);

    -- ---------------- S9: duplicates and malformed webhooks ----------------
    v_cnt := (select count(*) from public.message_inbox);
    v_json := public.message_inbound('sms', '+' || dana, 'YES', 'sm-s8-yes');
    res := res || kvisa_tests.t('S9 The same incoming text delivered twice is handled once',
      v_json->>'outcome' = 'duplicate' and (select count(*) from public.message_inbox) = v_cnt);
    v_json := public.message_inbound('sms', '+' || dana, 'STOP', '');
    res := res || kvisa_tests.t('S9 An SMS without a provider message id is ignored (not stored, not acted on)',
      v_json->>'outcome' = 'invalid' and (select count(*) from public.message_inbox) = v_cnt
      and (select status from public.sms_enrollments where id = e_dana) = 'active');

    -- ---------------- S10/S11: expiry and too many wrong codes ----------------
    perform kvisa_tests.act_as(u_disp);
    v_code2 := public.sms_issue_code(e_eli)->>'code';
    perform kvisa_tests.act_as(null);
    update public.sms_enrollments set code_expires_at = now() - interval '1 minute' where id = e_eli;
    v_json := public.message_inbound('sms', '+' || eli, 'JOIN ' || v_code2, 'sm-s10-expired');
    res := res || kvisa_tests.t('S10 An expired code is rejected', v_json->>'outcome' = 'join_rejected'
      and (select status from public.sms_enrollments where id = e_eli) = 'code_issued');
    perform kvisa_tests.act_as(u_disp);
    v_code2 := public.sms_issue_code(e_eli)->>'code';
    perform kvisa_tests.act_as(null);
    for i in 1..5 loop perform public.message_inbound('sms', '+' || eli, 'JOIN 99999' || i, 'sm-s11-' || i); end loop;
    v_json := public.message_inbound('sms', '+' || eli, 'JOIN ' || v_code2, 'sm-s11-right');
    res := res || kvisa_tests.t('S11 Five wrong attempts burn the code; even the right one then fails',
      v_json->>'outcome' = 'join_rejected' and (select code_hash is null and status = 'code_issued' from public.sms_enrollments where id = e_eli));

    -- ---------------- S12: job posts go only to actively enrolled people ----------------
    perform kvisa_tests.act_as(u_disp);
    o1 := public.create_order(jsonb_build_object('client_id', v_client, 'expected_bags', 2, 'pickup_at', base, 'washer_id', p_wash));
    v_json := public.post_jobs(array[(select id from public.order_tasks where order_id = o1 and task_type = 'pickup')], null, '{sms}');
    perform kvisa_tests.act_as(null);
    select body into v_txt from public.message_outbox where purpose = 'post' and channel = 'sms';
    res := res || kvisa_tests.t('S12 An SMS job post goes only to the enrolled driver (not approved/unenrolled ones)',
      (v_json->>'sms')::int = 1 and (select array_agg(to_address) from public.message_outbox where purpose = 'post' and channel = 'sms') = array[dana], v_json::text);
    res := res || kvisa_tests.t('S12 SMS posts carry the program name and the STOP line',
      v_txt like 'KVISA: %' and v_txt like '%Reply STOP to opt out.', v_txt);

    -- ---------------- S13: STOP ----------------
    insert into public.message_outbox (channel, to_kind, to_address, person_id, body, purpose)
      values ('sms', 'person', dana, p_dana, 'synthetic pending', 'reply') returning id into v_id;
    v_json := public.message_inbound('sms', '+' || dana, ' Stop. ', 'sm-s13-stop');
    res := res || kvisa_tests.t('S13 STOP opts the number out and ends the enrollment',
      v_json->>'outcome' = 'opt_out' and (select status from public.sms_enrollments where id = e_dana) = 'opted_out'
      and exists (select 1 from public.sms_optouts where phone_e164 = dana and cleared_at is null and source = 'keyword'));
    res := res || kvisa_tests.t('S13 STOP cancels every text still waiting for that number',
      (select status from public.message_outbox where id = v_id) = 'cancelled'
      and not exists (select 1 from public.message_outbox where to_address = dana and status in ('pending','failed')));
    res := res || kvisa_tests.t('S13 The app sends no reply of its own to STOP (Twilio confirms it)',
      not exists (select 1 from public.message_outbox where inbox_id = (select id from public.message_inbox where provider_message_id = 'sm-s13-stop')));
    insert into public.message_outbox (channel, to_kind, to_address, person_id, body, purpose)
      values ('sms', 'person', dana, p_dana, 'synthetic after stop', 'reply') returning id into v_id;
    res := res || kvisa_tests.t('S13 Anything queued after STOP is cancelled at the queue',
      (select status = 'cancelled' and error = 'Not sent: the recipient opted out' from public.message_outbox where id = v_id));
    v_json := public.message_inbound('sms', '+' || dana, 'START', 'sm-s13-start');
    perform public.message_inbound('sms', '+' || dana, 'YES', 'sm-s13-yes');
    perform public.message_inbound('sms', '+' || dana, 'JOIN ' || v_code, 'sm-s13-join');
    res := res || kvisa_tests.t('S13 START, YES or an old code after STOP do not re-enroll',
      v_json->>'outcome' = 'start_ignored' and (select status from public.sms_enrollments where id = e_dana) = 'opted_out'
      and exists (select 1 from public.sms_optouts where phone_e164 = dana and cleared_at is null)
      and not exists (select 1 from public.sms_enrollments where phone_e164 = dana and status in ('approved','code_issued','joined','active')));
    perform kvisa_tests.act_as(u_disp);
    v_ok := false;
    begin perform public.outbox_retry(v_id); exception when others then v_ok := sqlerrm like '%opted out%'; end;
    res := res || kvisa_tests.t('S13 A dispatcher cannot resend a text to someone who opted out', v_ok);
    perform kvisa_tests.act_as(null);

    -- ---------------- S14: coming back needs a new approval, code, JOIN and YES ----------------
    perform kvisa_tests.act_as(u_disp);
    e_dana2 := public.sms_approve(p_dana);
    v_code := public.sms_issue_code(e_dana2)->>'code';
    perform kvisa_tests.act_as(null);
    v_json := public.message_inbound('sms', '+' || dana, 'JOIN ' || v_code, 'sm-s14-join');
    res := res || kvisa_tests.t('S14 After STOP, a new approval + new code + JOIN clears the opt-out',
      v_json->>'outcome' = 'join' and not exists (select 1 from public.sms_optouts where phone_e164 = dana and cleared_at is null)
      and (select cleared_by_enrollment from public.sms_optouts where phone_e164 = dana order by opted_out_at desc limit 1) = e_dana2
      and (select status from public.message_outbox where enrollment_id = e_dana2 and purpose = 'sms_confirm') = 'pending');
    update public.message_outbox set status = 'sent' where enrollment_id = e_dana2 and purpose = 'sms_confirm';
    perform public.message_inbound('sms', '+' || dana, 'YES', 'sm-s14-yes');
    res := res || kvisa_tests.t('S14 …and YES makes them active again', (select status from public.sms_enrollments where id = e_dana2) = 'active');

    -- ---------------- S15: claim-time and send-time re-checks ----------------
    insert into public.message_outbox (channel, to_kind, to_address, person_id, body, purpose)
      values ('sms', 'person', dana, p_dana, 'synthetic send-time', 'reply') returning id into v_id;
    perform set_config('role', 'service_role', true);
    perform count(*) from public.outbox_claim(100);
    perform set_config('role', 'postgres', true);
    perform public.sms_carrier_optout('+1 212 555 0141');
    v_txt := public.outbox_precheck(v_id);
    res := res || kvisa_tests.t('S15 An opt-out arriving after a text was claimed stops it right before sending',
      v_txt = 'the recipient opted out' and (select status from public.message_outbox where id = v_id) = 'cancelled'
      and exists (select 1 from public.sms_optouts where phone_e164 = dana and source = 'carrier' and cleared_at is null)
      and (select status from public.sms_enrollments where id = e_dana2) = 'opted_out', v_txt);
    -- a pending text whose approval was revoked before claiming is never handed to the sender
    perform kvisa_tests.sms_enroll(u_disp, p_fay);
    insert into public.message_outbox (channel, to_kind, to_address, person_id, body, purpose)
      values ('sms', 'person', fay, p_fay, 'synthetic claim-time', 'reply') returning id into v_id;
    update public.sms_enrollments set status = 'revoked', ended_at = now(), ended_reason = 'synthetic direct revoke' where person_id = p_fay and status = 'active';
    perform set_config('role', 'service_role', true);
    select count(*) into v_cnt from public.outbox_claim(100) c where c.id = v_id;
    perform set_config('role', 'postgres', true);
    res := res || kvisa_tests.t('S15 A text that is no longer allowed is cancelled at claim time, not handed to the sender',
      v_cnt = 0 and (select status = 'cancelled' and error like 'Not sent:%not enrolled%' from public.message_outbox where id = v_id));
    v_ok := false;
    begin perform public.outbox_precheck(v_id); perform kvisa_tests.act_as(u_drv); perform public.outbox_precheck(v_id);
    exception when insufficient_privilege then v_ok := true; end;
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('S15 Only the server can run the send-time check', v_ok);

    -- ---------------- S16: revoke, phone change, deactivation ----------------
    perform kvisa_tests.sms_enroll(u_disp, p_gil);
    insert into public.message_outbox (channel, to_kind, to_address, person_id, body, purpose)
      values ('sms', 'person', gil, p_gil, 'synthetic', 'reply') returning id into v_id;
    perform kvisa_tests.act_as(u_disp);
    update public.people set phone = '212-555-0199' where id = p_gil;
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('S16 Changing the person''s phone ends the approval and cancels waiting texts',
      not exists (select 1 from public.sms_enrollments where person_id = p_gil and status in ('approved','code_issued','joined','active'))
      and (select ended_reason from public.sms_enrollments where person_id = p_gil order by approved_at desc limit 1) = 'Phone number changed'
      and (select status from public.message_outbox where id = v_id) = 'cancelled');
    perform kvisa_tests.act_as(u_disp);
    e_eli := (select id from public.sms_enrollments where person_id = p_eli and status = 'code_issued');
    perform public.sms_revoke(e_eli, 'Synthetic: operator changed mind');
    v_ok := false;
    begin perform public.sms_issue_code(e_eli); exception when others then v_ok := sqlerrm like '%waiting for the person to join%'; end;
    perform kvisa_tests.act_as(null);
    res := res || kvisa_tests.t('S16 A revoked approval cannot get a new code', v_ok
      and (select status from public.sms_enrollments where id = e_eli) = 'revoked');

    -- ---------------- S17: HELP ----------------
    v_json := public.message_inbound('sms', '+' || eli, 'HELP', 'sm-s17-help1');
    res := res || kvisa_tests.t('S17 With app HELP replies off (default), HELP is logged and left to Twilio',
      v_json->>'outcome' = 'help' and not exists (select 1 from public.message_outbox where purpose = 'help'));
    update public.organization_settings set sms_help_reply_by_app = true where id = 1;
    perform public.message_inbound('sms', '+' || eli, 'help', 'sm-s17-help2');
    select body into v_txt from public.message_outbox where purpose = 'help' and to_address = eli;
    res := res || kvisa_tests.t('S17 With app HELP replies on, HELP gets program name, support contact, rates, STOP and terms',
      v_txt like 'KVISA: volunteer pickup texts. Help: support@example.test.%' and v_txt like '%Msg & data rates may apply%'
      and v_txt like '%Reply STOP%' and v_txt like '%https://example.test/terms%', v_txt);
    perform public.message_inbound('sms', '+' || dana, 'HELP', 'sm-s17-help3');
    res := res || kvisa_tests.t('S17 HELP from an opted-out number gets nothing from the app',
      not exists (select 1 from public.message_outbox where purpose = 'help' and to_address = dana and status <> 'cancelled'));

    -- ---------------- S18: permissions on the server-only entry points ----------------
    perform kvisa_tests.act_as(u_disp);
    v_ok := false;
    begin perform public.message_inbound('sms', '+' || dana, 'JOIN 123456', 'sm-s18'); exception when insufficient_privilege then v_ok := true; end;
    res := res || kvisa_tests.t('S18 Staff cannot fake an incoming text', v_ok);
    v_ok := false;
    begin perform public.sms_carrier_optout('+' || eli); exception when insufficient_privilege then v_ok := true; end;
    res := res || kvisa_tests.t('S18 Staff cannot fake a carrier opt-out', v_ok);
    perform kvisa_tests.act_as(null);

    -- ---------------- S19: switching SMS off stops everything new ----------------
    update public.organization_settings set sms_enabled = false where id = 1;
    insert into public.message_outbox (channel, to_kind, to_address, person_id, body, purpose)
      values ('sms', 'person', fay, p_fay, 'synthetic off', 'reply') returning id into v_id;
    res := res || kvisa_tests.t('S19 After switching SMS off, new texts are cancelled at the queue',
      (select status from public.message_outbox where id = v_id) = 'cancelled');

    raise exception 'KVISA_TEST_ROLLBACK';
  exception when others then
    if sqlerrm <> 'KVISA_TEST_ROLLBACK' then res := res || kvisa_tests.t('!! Unexpected error', false, sqlerrm); end if;
  end;
  return query select x->>'test', (x->>'ok')::boolean, x->>'detail' from jsonb_array_elements(res) x;
end $$;
