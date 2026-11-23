-- Kvisa 012: SMS consent and safety (branch only — not applied to any project).
--
-- Nobody receives a text unless ALL of these are true, checked when a text is queued AND
-- again right before it is sent (fail closed):
--   * SMS is switched on, and every required program setting is filled in;
--   * the number has not opted out;
--   * for job posts and replies: an operator approved this person for texts, the person then
--     enrolled themselves by texting JOIN + a single-use code from that same approved phone,
--     received the confirmation, and replied YES;
--   * for the one confirmation text: the person has just enrolled (JOIN) as above.
-- Nothing is ever sent before the person's own JOIN text. JOIN with no valid code, YES with no
-- pending enrollment, and START/UNSTOP never enroll anyone. STOP opts the number out at once,
-- ends the enrollment and cancels everything still waiting to be sent to it; coming back needs
-- a new operator approval, a new code and a new JOIN.
--
-- Wording of the disclosure, confirmation and HELP texts is a DRAFT for review: the disclosure
-- itself is stored as admin-entered, versioned text, and the system texts are built only from
-- settings the owner must fill in (no support contact, URL, frequency, retention or
-- volunteer/paid wording is assumed here).

-- ---------------------------------------------------------------
-- Settings: required program facts (empty until the owner fills them in)
-- ---------------------------------------------------------------
alter table public.organization_settings
  add column sms_program_name text not null default 'KVISA' check (length(btrim(sms_program_name)) between 2 and 30),
  add column sms_program_number text check (sms_program_number is null or sms_program_number ~ '^\+[1-9][0-9]{7,14}$'),
  add column sms_support_email text check (sms_support_email is null or sms_support_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add column sms_support_phone text check (sms_support_phone is null or length(btrim(sms_support_phone)) between 7 and 30),
  add column sms_terms_url text check (sms_terms_url is null or sms_terms_url ~ '^https://'),
  add column sms_privacy_url text check (sms_privacy_url is null or sms_privacy_url ~ '^https://'),
  add column sms_retention_days integer check (sms_retention_days is null or sms_retention_days between 30 and 3650),
  add column sms_participant_type text check (sms_participant_type is null or sms_participant_type in ('volunteer','paid')),
  add column sms_max_per_day integer check (sms_max_per_day is null or sms_max_per_day between 1 and 50),
  add column sms_consent_version text,
  add column sms_code_ttl_hours integer not null default 72 check (sms_code_ttl_hours between 1 and 336),
  add column sms_help_reply_by_app boolean not null default false;

-- Versioned written disclosures (the card a person reads before choosing to text JOIN).
-- Append-only: a version, once saved, can never be edited — make a new version instead.
create table public.sms_disclosures (
  version text primary key check (version ~ '^[A-Za-z0-9._-]{1,30}$'),
  body text not null check (length(btrim(body)) between 40 and 2000),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create trigger t_append_only before update or delete on public.sms_disclosures
  for each row execute function public.forbid_change();

alter table public.organization_settings
  add constraint organization_settings_sms_consent_version_fkey
    foreign key (sms_consent_version) references public.sms_disclosures(version),
  -- SMS cannot be switched on while any required program fact is missing.
  add constraint organization_settings_sms_ready check (not sms_enabled or (
    sms_program_number is not null and (sms_support_email is not null or sms_support_phone is not null)
    and sms_terms_url is not null and sms_privacy_url is not null and sms_retention_days is not null
    and sms_participant_type is not null and sms_max_per_day is not null and sms_consent_version is not null));

-- One row per enrollment attempt: operator approval → code → the person's JOIN → YES.
create table public.sms_enrollments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people(id) on delete restrict,
  phone_e164 text not null check (phone_e164 ~ '^[1-9][0-9]{7,14}$'),
  disclosure_version text not null references public.sms_disclosures(version),
  evidence_note text check (evidence_note is null or length(evidence_note) <= 500),
  status text not null default 'approved'
    check (status in ('approved','code_issued','joined','active','opted_out','revoked')),
  approved_by uuid references public.profiles(id) default auth.uid(),
  approved_at timestamptz not null default clock_timestamp(),
  code_hash text,
  code_expires_at timestamptz,
  code_issued_by uuid references public.profiles(id),
  code_issued_at timestamptz,
  failed_attempts integer not null default 0,
  join_inbox_id uuid references public.message_inbox(id),
  joined_at timestamptz,
  confirm_outbox_id uuid references public.message_outbox(id),
  yes_inbox_id uuid references public.message_inbox(id),
  confirmed_at timestamptz,
  ended_at timestamptz,
  ended_reason text
);
create unique index sms_enrollments_one_open_per_person on public.sms_enrollments (person_id)
  where status in ('approved','code_issued','joined','active');
create unique index sms_enrollments_one_open_per_phone on public.sms_enrollments (phone_e164)
  where status in ('approved','code_issued','joined','active');

-- Opt-outs by phone number (a STOP from any number counts, enrolled or not). History is kept:
-- an opt-out is cleared only by a new valid JOIN after a new operator approval.
create table public.sms_optouts (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  source text not null check (source in ('keyword','carrier')),
  inbox_id uuid references public.message_inbox(id),
  opted_out_at timestamptz not null default clock_timestamp(),
  cleared_at timestamptz,
  cleared_by_enrollment uuid references public.sms_enrollments(id)
);
create unique index sms_optouts_one_active on public.sms_optouts (phone_e164) where cleared_at is null;

alter table public.message_outbox add column enrollment_id uuid references public.sms_enrollments(id);
alter table public.message_outbox drop constraint message_outbox_purpose_check;
alter table public.message_outbox add constraint message_outbox_purpose_check
  check (purpose in ('post','covered','reply','sms_confirm','help'));

alter table public.sms_disclosures enable row level security;
alter table public.sms_enrollments enable row level security;
alter table public.sms_optouts enable row level security;
revoke all on public.sms_disclosures, public.sms_enrollments, public.sms_optouts from anon;
revoke insert, update, delete on public.sms_disclosures, public.sms_enrollments, public.sms_optouts from authenticated;
create policy sms_disclosures_staff_read on public.sms_disclosures for select to authenticated using (public.is_staff());
create policy sms_enrollments_staff_read on public.sms_enrollments for select to authenticated using (public.is_staff());
create policy sms_optouts_staff_read on public.sms_optouts for select to authenticated using (public.is_staff());
create trigger t_audit after insert or update on public.sms_enrollments for each row execute function public.audit_row();
create trigger t_audit after insert on public.sms_disclosures for each row execute function public.audit_row();
create trigger t_audit after insert or update on public.sms_optouts for each row execute function public.audit_row();

-- ---------------------------------------------------------------
-- Eligibility (one place, used when queueing and again before sending)
-- ---------------------------------------------------------------
create or replace function public._sms_ready(s organization_settings)
returns boolean language sql stable as $$
  select s.sms_enabled and s.sms_program_number is not null
    and (s.sms_support_email is not null or s.sms_support_phone is not null)
    and s.sms_terms_url is not null and s.sms_privacy_url is not null and s.sms_retention_days is not null
    and s.sms_participant_type is not null and s.sms_max_per_day is not null and s.sms_consent_version is not null
$$;

-- Why a text may NOT go out (null = it may). Purposes: post / reply need an active enrollment
-- for that person on that exact number; sms_confirm needs that enrollment to be freshly joined;
-- help needs the app-HELP setting. Anything else is refused.
create or replace function public._sms_block_reason(p_person uuid, p_phone text, p_purpose text, p_enrollment uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare s organization_settings%rowtype := public._settings();
begin
  if not s.sms_enabled then return 'text messages are switched off'; end if;
  if not public._sms_ready(s) then return 'text message settings are incomplete'; end if;
  if p_phone is null or p_phone !~ '^[1-9][0-9]{7,14}$' then return 'no valid phone number'; end if;
  if exists (select 1 from sms_optouts where phone_e164 = p_phone and cleared_at is null) then
    return 'the recipient opted out';
  end if;
  case p_purpose
    when 'sms_confirm' then
      if not exists (select 1 from sms_enrollments e join people p on p.id = e.person_id
                     where e.id = p_enrollment and e.status = 'joined' and e.phone_e164 = p_phone
                       and e.person_id is not distinct from p_person and p.active) then
        return 'no fresh enrollment for this number';
      end if;
    when 'help' then
      if not s.sms_help_reply_by_app then return 'HELP replies are left to the carrier/Twilio'; end if;
    when 'post', 'reply' then
      if p_person is null or not exists (
          select 1 from sms_enrollments e join people p on p.id = e.person_id
          where e.person_id = p_person and e.status = 'active' and e.phone_e164 = p_phone
            and p.active and public._phone_e164(p.phone) = p_phone) then
        return 'the person is not enrolled for texts on this number';
      end if;
    else
      return 'this kind of message is never sent by text';
  end case;
  return null;
end $$;

-- Queue-time gate: an SMS that may not go out is stored as cancelled with the reason, never pending.
-- Texts that may go out get the program name in front; job posts also get the STOP line.
create or replace function public.message_outbox_sms_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_reason text; v_name text := (select sms_program_name from organization_settings where id = 1);
begin
  if new.channel <> 'sms' then return new; end if;
  if new.to_kind <> 'person' then
    v_reason := 'texts can only go to one person';
  else
    v_reason := public._sms_block_reason(new.person_id, new.to_address, new.purpose, new.enrollment_id);
  end if;
  if v_reason is not null then
    new.status := 'cancelled';
    new.error := 'Not sent: ' || v_reason;
    return new;
  end if;
  if new.body not like v_name || ':%' then new.body := v_name || ': ' || new.body; end if;
  if new.purpose = 'post' and new.body !~* 'reply stop' then new.body := new.body || E'\nReply STOP to opt out.'; end if;
  return new;
end $$;
create trigger t_sms_guard before insert on public.message_outbox
  for each row execute function public.message_outbox_sms_guard();

-- ---------------------------------------------------------------
-- System texts (DRAFT wording; built only from the owner's settings)
-- ---------------------------------------------------------------
create or replace function public._sms_label() returns text language sql stable security definer set search_path = public as $$
  select case sms_participant_type when 'volunteer' then 'volunteer' when 'paid' then 'driver' end
  from organization_settings where id = 1
$$;

create or replace function public._sms_support() returns text language sql stable security definer set search_path = public as $$
  select concat_ws(' or ', sms_support_email, sms_support_phone) from organization_settings where id = 1
$$;

create or replace function public._sms_confirm_text() returns text language sql stable security definer set search_path = public as $$
  select format('Reply YES to confirm %s pickup texts from %s. Msg frequency varies, up to %s/day. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Terms: %s Privacy: %s',
    public._sms_label(), sms_program_name, sms_max_per_day, sms_terms_url, sms_privacy_url)
  from organization_settings where id = 1
$$;

create or replace function public._sms_help_text() returns text language sql stable security definer set search_path = public as $$
  select format('%s: %s pickup texts. Help: %s. Msg & data rates may apply. Reply STOP to opt out. Terms: %s',
    sms_program_name, public._sms_label(), public._sms_support(), sms_terms_url)
  from organization_settings where id = 1
$$;

-- ---------------------------------------------------------------
-- Opt-out: record it, end the enrollment, cancel everything waiting for that number
-- ---------------------------------------------------------------
create or replace function public._sms_record_optout(p_phone text, p_source text, p_inbox uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_phone is null then return; end if;
  insert into sms_optouts (phone_e164, source, inbox_id) values (p_phone, p_source, p_inbox)
    on conflict (phone_e164) where cleared_at is null do nothing;
  perform public._wf('sms.opted_out', case p_source when 'carrier' then 'Carrier reported opt-out' else 'Replied STOP' end);
  update sms_enrollments set status = 'opted_out', ended_at = now(), ended_reason = 'Opted out (' || p_source || ')', code_hash = null
    where phone_e164 = p_phone and status in ('approved','code_issued','joined','active');
  update message_outbox set status = 'cancelled', error = 'Not sent: the recipient opted out'
    where channel = 'sms' and to_address = p_phone and status in ('pending','failed');
end $$;

-- ---------------------------------------------------------------
-- Operator actions (staff)
-- ---------------------------------------------------------------
create or replace function public.sms_add_disclosure(p_version text, p_body text, p_make_current boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'KVISA_FORBIDDEN: only administrators can do this' using errcode = '42501'; end if;
  if exists (select 1 from sms_disclosures where version = p_version) then
    raise exception 'KVISA_VALIDATION: version % already exists — use a new version name', p_version;
  end if;
  perform public._wf('sms.disclosure_added', null);
  insert into sms_disclosures (version, body) values (btrim(p_version), btrim(p_body));
  if p_make_current then update organization_settings set sms_consent_version = btrim(p_version) where id = 1; end if;
end $$;

-- Step 1: the operator approves a person for texts (nothing is sent).
create or replace function public.sms_approve(p_person uuid, p_evidence_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare s organization_settings%rowtype := public._settings(); p people%rowtype; v_phone text; v_id uuid;
begin
  perform public._require_staff();
  if s.sms_consent_version is null then
    raise exception 'KVISA_VALIDATION: add the text-message disclosure (Settings) before approving anyone';
  end if;
  select * into p from people where id = p_person;
  if not found or not p.active then raise exception 'KVISA_VALIDATION: this person is not active'; end if;
  if not exists (select 1 from person_roles where person_id = p_person and active and role in ('driver','washer')) then
    raise exception 'KVISA_VALIDATION: only drivers and washing volunteers can get texts';
  end if;
  v_phone := public._phone_e164(p.phone);
  if v_phone is null then raise exception 'KVISA_VALIDATION: add a valid mobile number to this person first'; end if;
  if exists (select 1 from sms_enrollments where person_id = p_person and status in ('approved','code_issued','joined','active')) then
    raise exception 'KVISA_VALIDATION: this person already has a text-message approval';
  end if;
  if exists (select 1 from sms_enrollments where phone_e164 = v_phone and status in ('approved','code_issued','joined','active')) then
    raise exception 'KVISA_VALIDATION: another person is already approved on this phone number';
  end if;
  perform public._wf('sms.approved', p_evidence_note);
  insert into sms_enrollments (person_id, phone_e164, disclosure_version, evidence_note)
    values (p_person, v_phone, s.sms_consent_version, nullif(btrim(p_evidence_note), ''))
    returning id into v_id;
  return v_id;
end $$;

-- Step 2: a single-use enrollment code for the approved person (shown once; only a hash is kept).
create or replace function public.sms_issue_code(p_enrollment uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e sms_enrollments%rowtype; s organization_settings%rowtype := public._settings(); v_code text; v_exp timestamptz;
begin
  perform public._require_staff();
  select * into e from sms_enrollments where id = p_enrollment for update;
  if not found or e.status not in ('approved','code_issued') then
    raise exception 'KVISA_VALIDATION: a code can only be issued for an approval that is waiting for the person to join';
  end if;
  if public._phone_e164((select phone from people where id = e.person_id)) is distinct from e.phone_e164 then
    raise exception 'KVISA_VALIDATION: the person''s phone number changed since approval — revoke and approve again';
  end if;
  v_code := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
  v_exp := now() + make_interval(hours => s.sms_code_ttl_hours);
  perform public._wf('sms.code_issued', null);
  update sms_enrollments set status = 'code_issued', code_hash = encode(sha256(convert_to(e.id::text || ':' || v_code, 'UTF8')), 'hex'),
    code_expires_at = v_exp, code_issued_by = auth.uid(), code_issued_at = now(), failed_attempts = 0
    where id = e.id;
  return jsonb_build_object('code', v_code, 'expires_at', v_exp, 'phone_last4', right(e.phone_e164, 4),
    'program_number', s.sms_program_number, 'disclosure_version', e.disclosure_version,
    'disclosure', (select body from sms_disclosures where version = e.disclosure_version));
end $$;

create or replace function public._sms_end(p_enrollment uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare e sms_enrollments%rowtype;
begin
  update sms_enrollments set status = 'revoked', ended_at = now(), ended_reason = p_reason, code_hash = null
    where id = p_enrollment and status in ('approved','code_issued','joined','active') returning * into e;
  if not found then return; end if;
  update message_outbox set status = 'cancelled', error = 'Not sent: text-message approval ended'
    where channel = 'sms' and status in ('pending','failed') and (person_id = e.person_id or to_address = e.phone_e164);
end $$;

create or replace function public.sms_revoke(p_enrollment uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_staff();
  if not exists (select 1 from sms_enrollments where id = p_enrollment and status in ('approved','code_issued','joined','active')) then
    raise exception 'KVISA_VALIDATION: this approval has already ended';
  end if;
  perform public._wf('sms.revoked', p_reason);
  perform public._sms_end(p_enrollment, coalesce(nullif(btrim(p_reason), ''), 'Revoked by operator'));
end $$;

-- The approval is bound to the phone it was given for: a new number, or a deactivated person,
-- ends it (and cancels anything waiting).
create or replace function public.sms_people_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if public._phone_e164(new.phone) is distinct from public._phone_e164(old.phone) or (old.active and not new.active) then
    for r in select id from sms_enrollments where person_id = new.id and status in ('approved','code_issued','joined','active') loop
      perform public._sms_end(r.id, case when old.active and not new.active then 'Person deactivated' else 'Phone number changed' end);
    end loop;
  end if;
  return new;
end $$;
create trigger t_sms_people_guard after update of phone, active on public.people
  for each row execute function public.sms_people_guard();

-- ---------------------------------------------------------------
-- Incoming texts
-- ---------------------------------------------------------------
-- Keywords for SMS only. Returns the outcome; never enrolls anyone without the full chain.
create or replace function public._sms_keyword(p_phone text, p_raw text, p_inbox uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_kw text := upper(btrim(regexp_replace(coalesce(p_raw, ''), '[^A-Za-z0-9 ]', ' ', 'g')));
  e sms_enrollments%rowtype; v_code text; v_out uuid;
begin
  v_kw := regexp_replace(v_kw, '\s+', ' ', 'g');
  if v_kw in ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT','OPT OUT') then
    perform public._sms_record_optout(p_phone, 'keyword', p_inbox);
    return 'opt_out';                         -- Twilio sends its own STOP confirmation
  end if;
  if v_kw in ('HELP','INFO') then
    if public._sms_block_reason(null, p_phone, 'help', null) is null then
      insert into message_outbox (channel, to_kind, to_address, body, purpose, inbox_id)
        values ('sms', 'person', p_phone, public._sms_help_text(), 'help', p_inbox);
    end if;
    return 'help';
  end if;
  if v_kw in ('START','UNSTOP') then
    return 'start_ignored';                   -- never re-enrolls; a new approval + JOIN is required
  end if;
  if v_kw ~ '^JOIN' then
    v_code := substring(v_kw from '^JOIN ?([0-9]{6})$');
    if not public._sms_ready(public._settings()) then return 'join_rejected'; end if;
    select * into e from sms_enrollments where phone_e164 = p_phone and status = 'code_issued' for update;
    if not found or v_code is null or e.code_hash is null or e.code_expires_at < now() then return 'join_rejected'; end if;
    if e.code_hash <> encode(sha256(convert_to(e.id::text || ':' || v_code, 'UTF8')), 'hex') then
      update sms_enrollments set failed_attempts = failed_attempts + 1,
        code_hash = case when failed_attempts + 1 >= 5 then null else code_hash end
        where id = e.id;
      return 'join_rejected';
    end if;
    if not exists (select 1 from people where id = e.person_id and active and public._phone_e164(phone) = p_phone)
       or exists (select 1 from sms_optouts where phone_e164 = p_phone and opted_out_at > e.approved_at) then
      return 'join_rejected';
    end if;
    perform public._wf('sms.joined', null);
    update sms_optouts set cleared_at = now(), cleared_by_enrollment = e.id where phone_e164 = p_phone and cleared_at is null;
    update sms_enrollments set status = 'joined', code_hash = null, join_inbox_id = p_inbox, joined_at = now() where id = e.id;
    insert into message_outbox (channel, to_kind, to_address, person_id, body, purpose, inbox_id, enrollment_id)
      values ('sms', 'person', p_phone, e.person_id, public._sms_confirm_text(), 'sms_confirm', p_inbox, e.id)
      returning id into v_out;
    update sms_enrollments set confirm_outbox_id = v_out where id = e.id;
    return 'join';
  end if;
  if v_kw = 'YES' then
    select * into e from sms_enrollments where phone_e164 = p_phone and status = 'joined' for update;
    if not found or not exists (select 1 from message_outbox where id = e.confirm_outbox_id and status = 'sent') then
      return 'yes_ignored';
    end if;
    perform public._wf('sms.confirmed', null);
    update sms_enrollments set status = 'active', yes_inbox_id = p_inbox, confirmed_at = now() where id = e.id;
    return 'confirmed';
  end if;
  return null;
end $$;

-- Same entry point as before (011). WhatsApp behaviour is unchanged. For SMS: a provider id is
-- required (duplicates are dropped), keywords are handled first, and job numbers / DONE are only
-- acted on for people actively enrolled on that number.
create or replace function public.message_inbound(p_channel text, p_from text, p_body text, p_provider_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_from text := public._phone_e164(case when p_channel = 'whatsapp' and p_from !~ '^\s*\+' then '+' || p_from else p_from end);
  v_inbox uuid; v_person uuid; v_text text; v_raw text := btrim(coalesce(p_body, ''));
  v_nums integer[]; v_no integer; v_reply text := ''; v_outcome text;
begin
  if p_channel not in ('whatsapp','sms') then raise exception 'KVISA_VALIDATION: unknown channel'; end if;
  if p_channel = 'sms' and (coalesce(btrim(p_provider_id), '') = '' or v_from is null) then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  insert into message_inbox (channel, provider_message_id, from_address, body)
    values (p_channel, coalesce(nullif(p_provider_id, ''), gen_random_uuid()::text), coalesce(v_from, p_from), left(v_raw, 2000))
    on conflict (channel, provider_message_id) do nothing
    returning id into v_inbox;
  if v_inbox is null then return jsonb_build_object('outcome', 'duplicate'); end if;

  select id into v_person from people where active and public._phone_e164(phone) = v_from order by created_at limit 1;

  if p_channel = 'sms' then
    v_outcome := public._sms_keyword(v_from, v_raw, v_inbox);
    if v_outcome is not null then
      update message_inbox set person_id = v_person, outcome = v_outcome where id = v_inbox;
      return jsonb_build_object('outcome', v_outcome);
    end if;
    if v_person is null or not exists (select 1 from sms_enrollments where person_id = v_person and phone_e164 = v_from and status = 'active') then
      update message_inbox set person_id = v_person, outcome = case when v_person is null then 'unknown_sender' else 'not_enrolled' end where id = v_inbox;
      return jsonb_build_object('outcome', case when v_person is null then 'unknown_sender' else 'not_enrolled' end);
    end if;
  end if;

  if v_person is null then
    update message_inbox set outcome = 'unknown_sender' where id = v_inbox;
    return jsonb_build_object('outcome', 'unknown_sender');
  end if;

  v_text := btrim(regexp_replace(regexp_replace(lower(v_raw), '[^a-z0-9,&\- ]', ' ', 'g'), '\s+', ' ', 'g'));
  if v_text ~ '^[0-9]{1,2}( ?(,|&|and| ) ?[0-9]{1,2})*$' then
    v_outcome := 'take';
    select array_agg(distinct m[1]::int) into v_nums from regexp_matches(v_text, '([0-9]+)', 'g') m;
    foreach v_no in array v_nums loop
      v_reply := v_reply || case when v_reply = '' then '' else E'\n\n' end || public._take_job(v_person, v_no);
    end loop;
  elsif v_text ~ '^(done|finished|all done|delivered)( .*)?$' or v_raw in ('✅', '✔️', '☑️', '👍') then
    v_outcome := 'done';
    v_reply := public._mark_done(v_person, substring(v_text from '^(?:all done|done|finished|delivered)(.*)$'), p_channel);
  else
    update message_inbox set person_id = v_person, outcome = 'ignored' where id = v_inbox;
    return jsonb_build_object('outcome', 'ignored');
  end if;

  perform set_config('kvisa.as_person', '', true);
  insert into message_outbox (channel, to_kind, to_address, person_id, body, purpose, inbox_id)
    values (p_channel, 'person', v_from, v_person, v_reply, 'reply', v_inbox);
  update message_inbox set person_id = v_person, outcome = v_outcome, detail = v_reply where id = v_inbox;
  return jsonb_build_object('outcome', v_outcome, 'reply', v_reply);
end $$;

-- Twilio refused a send because the person opted out at the carrier (error 21610).
create or replace function public.sms_carrier_optout(p_phone text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._sms_record_optout(public._phone_e164('+' || regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')), 'carrier', null);
end $$;

-- ---------------------------------------------------------------
-- Job posts by SMS: only to people actively enrolled (the queue guard checks again)
-- ---------------------------------------------------------------
create or replace function public.post_jobs(p_task_ids uuid[], p_intro text default null,
  p_channels text[] default '{}', p_expires_minutes integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s organization_settings%rowtype := public._settings();
  v_channels text[] := coalesce(p_channels, '{}');
  v_post uuid; v_post_no bigint; n integer; v_first integer; r record; v_offer uuid;
  v_lines text[] := '{}'; v_body text; v_sms integer := 0; v_dupe text;
begin
  perform public._require_staff();
  perform public._expire_offers();
  if p_task_ids is null or cardinality(p_task_ids) = 0 then raise exception 'KVISA_VALIDATION: choose at least one job to post'; end if;
  if cardinality(p_task_ids) > 30 then raise exception 'KVISA_VALIDATION: post at most 30 jobs at a time'; end if;
  if not v_channels <@ array['whatsapp','sms']::text[] then raise exception 'KVISA_VALIDATION: unknown channel'; end if;
  if 'whatsapp' = any(v_channels) and (not s.wa_enabled or coalesce(s.wa_group_id, '') = '') then
    raise exception 'KVISA_VALIDATION: WhatsApp is not set up yet (Settings → WhatsApp & text messages)';
  end if;
  if 'sms' = any(v_channels) and not public._sms_ready(s) then
    raise exception 'KVISA_VALIDATION: text messages are not set up yet (Settings → WhatsApp & text messages)';
  end if;
  select format('%s (K-%s) is already posted as job %s and still open', public.task_type_label(t.task_type), o.order_no, i.item_no)
    into v_dupe
    from job_post_items i join task_offers f on f.id = i.offer_id join order_tasks t on t.id = i.task_id join orders o on o.id = i.order_id
    where i.task_id = any(p_task_ids) and f.status = 'available' limit 1;
  if v_dupe is not null then raise exception 'KVISA_VALIDATION: %', v_dupe; end if;

  insert into job_posts (intro, channels) values (nullif(btrim(p_intro), ''), v_channels) returning id, post_no into v_post, v_post_no;
  v_first := public._next_item_no();
  n := v_first - 1;
  for r in select * from public._post_order(p_task_ids) loop
    n := n + 1;
    v_offer := public.dispatch_task(r.task_id, null, p_expires_minutes, null, false);
    insert into job_post_items (post_id, item_no, offer_id, task_id, order_id)
      select v_post, n, v_offer, t.id, t.order_id from order_tasks t where t.id = r.task_id;
    v_lines := v_lines || public._job_line(r.task_id, n);
  end loop;
  v_body := public._post_body(p_intro, v_lines);
  update job_posts set body = v_body where id = v_post;

  if 'whatsapp' = any(v_channels) then
    insert into message_outbox (channel, to_kind, to_address, body, purpose, post_id)
      values ('whatsapp', 'group', s.wa_group_id, v_body, 'post', v_post);
  end if;
  if 'sms' = any(v_channels) then
    insert into message_outbox (channel, to_kind, to_address, person_id, body, purpose, post_id)
      select distinct on (e.phone_e164) 'sms', 'person', e.phone_e164, p.id, v_body, 'post', v_post
      from job_post_items i join offer_recipients rc on rc.offer_id = i.offer_id join people p on p.id = rc.person_id
        join sms_enrollments e on e.person_id = p.id and e.status = 'active'
      where i.post_id = v_post and public._sms_block_reason(p.id, e.phone_e164, 'post', null) is null;
    get diagnostics v_sms = row_count;
  end if;
  return jsonb_build_object('post_id', v_post, 'post_no', v_post_no, 'jobs', n - v_first + 1,
    'first_no', v_first, 'last_no', n, 'whatsapp', 'whatsapp' = any(v_channels), 'sms', v_sms, 'body', v_body);
end $$;

-- ---------------------------------------------------------------
-- Sending: re-check every SMS when it is claimed and once more just before the provider call
-- ---------------------------------------------------------------
create or replace function public.outbox_claim(p_limit integer default 25)
returns setof public.message_outbox language plpgsql security definer set search_path = public as $$
begin
  update message_outbox m set status = 'cancelled', locked_at = null,
      error = 'Not sent: ' || coalesce(case when m.to_kind <> 'person' then 'texts can only go to one person' end,
                                      public._sms_block_reason(m.person_id, m.to_address, m.purpose, m.enrollment_id))
    where m.channel = 'sms' and (m.status in ('pending','failed') or (m.status = 'sending' and m.locked_at < now() - interval '5 minutes'))
      and (m.to_kind <> 'person' or public._sms_block_reason(m.person_id, m.to_address, m.purpose, m.enrollment_id) is not null);
  return query
  update message_outbox m set status = 'sending', attempts = m.attempts + 1, locked_at = now()
  where m.id in (
    select id from message_outbox
    where status = 'pending'
       or (status = 'sending' and locked_at < now() - interval '5 minutes')
       or (status = 'failed' and attempts < 3 and created_at > now() - interval '1 day')
    order by created_at limit greatest(1, least(p_limit, 100))
    for update skip locked)
  returning m.*;
end $$;

-- Called by the sender immediately before each provider call. Returns null when the message may
-- go; otherwise marks it cancelled and returns the reason.
create or replace function public.outbox_precheck(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare m message_outbox%rowtype; v_reason text;
begin
  select * into m from message_outbox where id = p_id for update;
  if not found or m.status <> 'sending' then return 'not claimed'; end if;
  if m.channel <> 'sms' then return null; end if;
  v_reason := case when m.to_kind <> 'person' then 'texts can only go to one person'
                   else public._sms_block_reason(m.person_id, m.to_address, m.purpose, m.enrollment_id) end;
  if v_reason is not null then
    update message_outbox set status = 'cancelled', error = 'Not sent: ' || v_reason, locked_at = null where id = p_id;
  end if;
  return v_reason;
end $$;

create or replace function public.outbox_retry(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m message_outbox%rowtype; v_reason text;
begin
  perform public._require_staff();
  select * into m from message_outbox where id = p_id;
  if not found or m.status not in ('failed','cancelled') then
    raise exception 'KVISA_VALIDATION: only failed or cancelled messages can be sent again';
  end if;
  if m.channel = 'sms' then
    v_reason := public._sms_block_reason(m.person_id, m.to_address, m.purpose, m.enrollment_id);
    if v_reason is not null then raise exception 'KVISA_VALIDATION: this text cannot be sent: %', v_reason; end if;
  end if;
  update message_outbox set status = 'pending', attempts = 0, error = null where id = p_id;
end $$;

-- ---------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------
revoke execute on function public._sms_ready(organization_settings), public._sms_block_reason(uuid, text, text, uuid),
  public.message_outbox_sms_guard(), public._sms_label(), public._sms_support(), public._sms_confirm_text(), public._sms_help_text(),
  public._sms_record_optout(text, text, uuid), public._sms_end(uuid, text), public.sms_people_guard(), public._sms_keyword(text, text, uuid)
  from public, anon, authenticated;
revoke execute on function public.sms_carrier_optout(text), public.outbox_precheck(uuid) from public, anon, authenticated;
grant execute on function public.sms_carrier_optout(text), public.outbox_precheck(uuid) to service_role;
revoke execute on function public.sms_add_disclosure(text, text, boolean), public.sms_approve(uuid, text),
  public.sms_issue_code(uuid), public.sms_revoke(uuid, text) from public, anon;
grant execute on function public.sms_add_disclosure(text, text, boolean), public.sms_approve(uuid, text),
  public.sms_issue_code(uuid), public.sms_revoke(uuid, text) to authenticated;
