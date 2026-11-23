-- Kvisa 013: SMS per-part tracking and a per-number daily cap (branch only — not applied anywhere).
--
-- A long text is sent to Twilio as several separate messages ("parts"). Each part is now:
--   * checked again right before its own provider call (STOP / revoked / switched off / cap reached
--     stop the remaining parts);
--   * recorded before the call, so a retry never resends a part Twilio already accepted;
--   * if the outcome is unclear (timeout, network error, 5xx, odd response), the whole message moves
--     to "needs_review": nothing resends it automatically; staff decide after checking Twilio's log.
--
-- Daily cap: sms_max_per_day = the most separate text messages (parts) KVISA lets go to one phone
-- number per calendar day in the organization's time zone, counting every purpose (job posts,
-- replies, the enrollment confirmation, HELP). Parts that were accepted, are in flight, or whose
-- outcome is unclear all count; only parts Twilio definitely refused do not. HELP is answered at
-- most once per number per day. The count and the decision are serialized per number.

alter table public.message_outbox drop constraint message_outbox_status_check;
alter table public.message_outbox add constraint message_outbox_status_check
  check (status in ('pending','sending','sent','failed','cancelled','needs_review'));

create table public.message_outbox_parts (
  outbox_id uuid not null references public.message_outbox(id) on delete restrict,
  part_no integer not null check (part_no >= 1),
  part_count integer not null check (part_count >= 1 and part_no <= part_count),
  to_address text not null,
  purpose text not null,
  status text not null check (status in ('sending','accepted','failed','unknown')),
  attempts integer not null default 1,
  provider_message_id text,
  error text,
  local_day date not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  primary key (outbox_id, part_no)
);
create index message_outbox_parts_cap_idx on public.message_outbox_parts (to_address, local_day)
  where status in ('sending','accepted','unknown');
alter table public.message_outbox_parts enable row level security;
revoke all on public.message_outbox_parts from anon;
revoke insert, update, delete on public.message_outbox_parts from authenticated;
create policy message_outbox_parts_staff_read on public.message_outbox_parts for select to authenticated using (public.is_staff());

-- Parts that count against today's cap for a number.
create or replace function public._sms_parts_today(p_phone text, p_purpose text default null)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from message_outbox_parts
  where to_address = p_phone and local_day = public._today() and status in ('sending','accepted','unknown')
    and (p_purpose is null or purpose = p_purpose)
$$;

-- Same rules as 012, plus the daily cap and the once-a-day HELP limit.
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
  if public._sms_parts_today(p_phone) >= s.sms_max_per_day then
    return 'daily text limit reached for this number';
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
      if public._sms_parts_today(p_phone, 'help') > 0 then return 'HELP was already answered today'; end if;
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

-- Right before the provider call for ONE part. Returns:
--   'send'           record made; call the provider now
--   'skip'           this part was already accepted earlier — do not send it again
--   'stop:<reason>'  do not send this or any later part; the message's status is already updated
create or replace function public.sms_part_begin(p_id uuid, p_part integer, p_count integer)
returns text language plpgsql security definer set search_path = public as $$
declare m message_outbox%rowtype; pr message_outbox_parts%rowtype; v_reason text; v_done int;
begin
  select * into m from message_outbox where id = p_id for update;
  if not found or m.status <> 'sending' then return 'stop:not claimed'; end if;
  if m.channel <> 'sms' or p_part < 1 or p_count < 1 or p_part > p_count then return 'stop:invalid part'; end if;
  -- one decision at a time per number, so concurrent senders cannot both slip under the cap
  perform pg_advisory_xact_lock(hashtextextended('kvisa-sms:' || m.to_address, 0));

  select * into pr from message_outbox_parts where outbox_id = p_id and part_no = p_part;
  if found and pr.status = 'accepted' then return 'skip'; end if;
  if (found and pr.status in ('sending','unknown'))
     or exists (select 1 from message_outbox_parts where outbox_id = p_id and part_count <> p_count) then
    update message_outbox set status = 'needs_review', locked_at = null,
      error = format('Unclear whether part %s of %s reached Twilio. Check the Twilio log before resending.', p_part, p_count)
      where id = p_id;
    return 'stop:needs_review';
  end if;

  v_reason := case when m.to_kind <> 'person' then 'texts can only go to one person'
                   else public._sms_block_reason(m.person_id, m.to_address, m.purpose, m.enrollment_id) end;
  if v_reason is not null then
    select count(*) into v_done from message_outbox_parts where outbox_id = p_id and status = 'accepted';
    update message_outbox set status = 'cancelled', locked_at = null,
      error = 'Not sent: ' || v_reason || case when v_done > 0 then format(' (stopped after %s of %s parts)', v_done, p_count) else '' end
      where id = p_id;
    return 'stop:' || v_reason;
  end if;

  insert into message_outbox_parts (outbox_id, part_no, part_count, to_address, purpose, status, local_day)
    values (p_id, p_part, p_count, m.to_address, m.purpose, 'sending', public._today())
  on conflict (outbox_id, part_no) do update
    set status = 'sending', attempts = message_outbox_parts.attempts + 1, error = null, finished_at = null,
        started_at = clock_timestamp(), local_day = public._today()
    where message_outbox_parts.status = 'failed';
  return 'send';
end $$;

-- After the provider call for ONE part: 'accepted' (Twilio created it), 'failed' (Twilio definitely
-- refused it — safe to try again later) or 'unknown' (anything else — never retried automatically).
create or replace function public.sms_part_finish(p_id uuid, p_part integer, p_outcome text, p_provider_id text default null, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_outcome not in ('accepted','failed','unknown') then raise exception 'KVISA_VALIDATION: bad outcome'; end if;
  update message_outbox_parts set status = p_outcome, provider_message_id = coalesce(p_provider_id, provider_message_id),
      error = left(p_error, 1000), finished_at = clock_timestamp()
    where outbox_id = p_id and part_no = p_part and status = 'sending';
  if not found then raise exception 'KVISA_VALIDATION: part % of this message was not being sent', p_part; end if;
  if p_outcome = 'unknown' then
    update message_outbox set status = 'needs_review', locked_at = null,
      error = format('Unclear whether part %s reached Twilio (%s). Check the Twilio log before resending.', p_part, coalesce(left(p_error, 300), 'no answer'))
      where id = p_id and status = 'sending';
  end if;
end $$;

-- Staff decision on a message whose delivery is unclear, after checking Twilio's log:
--   'delivered'      it went out → mark the unclear parts accepted, message sent (they still count toward the cap)
--   'not_delivered'  it did not → unclear parts marked failed; parts not yet accepted are sent on the next run
--                    (only if the person is still eligible and under the daily cap)
--   'cancel'         send nothing more
create or replace function public.outbox_resolve(p_id uuid, p_decision text)
returns void language plpgsql security definer set search_path = public as $$
declare m message_outbox%rowtype; v_reason text;
begin
  perform public._require_staff();
  select * into m from message_outbox where id = p_id for update;
  if not found or m.status <> 'needs_review' then raise exception 'KVISA_VALIDATION: this message is not waiting for review'; end if;
  perform public._wf('outbox.resolved', p_decision);
  case p_decision
    when 'delivered' then
      update message_outbox_parts set status = 'accepted', finished_at = coalesce(finished_at, now()),
        error = coalesce(error || ' — ', '') || 'marked delivered by staff' where outbox_id = p_id and status in ('sending','unknown');
      if exists (select 1 from message_outbox_parts where outbox_id = p_id and part_no = part_count and status = 'accepted') then
        update message_outbox set status = 'sent', sent_at = now(), error = null where id = p_id;
      else
        update message_outbox set status = 'cancelled', error = 'Stopped by staff after the parts marked delivered' where id = p_id;
      end if;
    when 'not_delivered' then
      v_reason := public._sms_block_reason(m.person_id, m.to_address, m.purpose, m.enrollment_id);
      if v_reason is not null then raise exception 'KVISA_VALIDATION: this text cannot be sent: %', v_reason; end if;
      update message_outbox_parts set status = 'failed', finished_at = coalesce(finished_at, now()),
        error = coalesce(error || ' — ', '') || 'marked not delivered by staff' where outbox_id = p_id and status in ('sending','unknown');
      update message_outbox set status = 'pending', attempts = 0, error = null where id = p_id;
    when 'cancel' then
      update message_outbox set status = 'cancelled', error = 'Cancelled by staff after review' where id = p_id;
    else
      raise exception 'KVISA_VALIDATION: choose delivered, not_delivered or cancel';
  end case;
end $$;

-- Plain "send again" is refused for unclear messages (use outbox_resolve), and re-checks SMS rules.
create or replace function public.outbox_retry(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m message_outbox%rowtype; v_reason text;
begin
  perform public._require_staff();
  select * into m from message_outbox where id = p_id;
  if found and m.status = 'needs_review' then
    raise exception 'KVISA_VALIDATION: it is unclear whether this text went out — check Twilio, then choose Delivered / Not delivered';
  end if;
  if not found or m.status not in ('failed','cancelled') then
    raise exception 'KVISA_VALIDATION: only failed or cancelled messages can be sent again';
  end if;
  if m.channel = 'sms' then
    v_reason := public._sms_block_reason(m.person_id, m.to_address, m.purpose, m.enrollment_id);
    if v_reason is not null then raise exception 'KVISA_VALIDATION: this text cannot be sent: %', v_reason; end if;
    if exists (select 1 from message_outbox_parts where outbox_id = p_id and status in ('sending','unknown')) then
      raise exception 'KVISA_VALIDATION: part of this text may already have gone out — it needs review first';
    end if;
  end if;
  update message_outbox set status = 'pending', attempts = 0, error = null where id = p_id;
end $$;

create or replace function public.outbox_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_staff();
  update message_outbox set status = 'cancelled' where id = p_id and status in ('pending','failed');
  if not found then raise exception 'KVISA_VALIDATION: this message was already sent, is being sent, or needs review'; end if;
end $$;

-- Claim: as in 012, but an abandoned SMS (sender crashed mid-send) whose part may have gone out is
-- moved to needs_review instead of being cancelled or resent.
create or replace function public.outbox_claim(p_limit integer default 25)
returns setof public.message_outbox language plpgsql security definer set search_path = public as $$
begin
  update message_outbox m set status = 'needs_review', locked_at = null,
      error = 'The sender stopped mid-send; part of this text may have gone out. Check the Twilio log.'
    where m.channel = 'sms' and m.status = 'sending' and m.locked_at < now() - interval '5 minutes'
      and exists (select 1 from message_outbox_parts pt where pt.outbox_id = m.id and pt.status in ('sending','unknown'));
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

revoke execute on function public._sms_parts_today(text, text) from public, anon, authenticated;
revoke execute on function public.sms_part_begin(uuid, integer, integer), public.sms_part_finish(uuid, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.sms_part_begin(uuid, integer, integer), public.sms_part_finish(uuid, integer, text, text, text) to service_role;
revoke execute on function public.outbox_resolve(uuid, text) from public, anon;
grant execute on function public.outbox_resolve(uuid, text) to authenticated;
