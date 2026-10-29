-- Kvisa 011: WhatsApp group + SMS job posts, and handling of private replies.
--
-- How it works
--  * The dispatcher picks open driver stages and presses Post. Each stage becomes a normal
--    job offer (dispatch_task) and gets a short number (1, 2, 3 …) that is unique among the
--    jobs that are still open. One numbered message goes to the WhatsApp group and/or by SMS
--    to every driver the jobs were offered to.
--  * A driver replies privately with a number → the same atomic accept as in the app
--    (respond_offer). They get the job details back; the group gets "2 covered @driver".
--  * A driver or volunteer replies DONE → their ready stage(s) are recorded with the
--    expected bag count (record_handoff), exactly as if they had pressed the buttons.
--  * Every message out goes through message_outbox; a server-side sender (the "messaging"
--    Edge Function) delivers it with the provider keys, which never reach the browser.
--  * Every message in is logged in message_inbox (unique per provider id, so a webhook
--    delivered twice is handled once).

-- ---------------------------------------------------------------
-- Settings (no secrets here — provider keys live in Edge Function secrets)
-- ---------------------------------------------------------------
alter table public.organization_settings
  add column wa_enabled boolean not null default false,
  add column wa_group_id text check (wa_group_id is null or wa_group_id ~ '^[0-9A-Za-z@._-]{5,80}$'),
  add column wa_group_name text,
  add column sms_enabled boolean not null default false,
  add column phone_country_code text not null default '1' check (phone_country_code ~ '^[1-9][0-9]{0,3}$'),
  add column msg_send_address boolean not null default true,
  add column msg_post_intro text not null default 'Jobs available — reply privately with the number you can take:'
    check (length(msg_post_intro) <= 500);

-- ---------------------------------------------------------------
-- Phone numbers: one canonical form (country code + digits, no "+") used to send to and to
-- recognise the sender of a reply. "(718) 555-0101" → "17185550101"; "+972 50…" → "97250…";
-- "050…" → "<country code>50…".
-- ---------------------------------------------------------------
create or replace function public._phone_e164(p text)
returns text language plpgsql stable security definer set search_path = public as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g'); cc text;
begin
  if d = '' then return null; end if;
  cc := (select phone_country_code from organization_settings where id = 1);
  if btrim(p) like '+%' then null;
  elsif d like '00%' then d := substr(d, 3);
  elsif d like '0%' then d := cc || substr(d, 2);
  elsif not (d like cc || '%' and length(d) > 10) then d := cc || d;
  end if;
  return case when length(d) between 8 and 15 then d end;
end $$;

-- ---------------------------------------------------------------
-- Acting for a person who has no app login (a reply by WhatsApp/SMS).
-- Only the server-side message handler sets kvisa.as_person, and it is honoured only when
-- there is no signed-in user and the caller is not the anonymous API role.
-- ---------------------------------------------------------------
create or replace function public.my_person_id() returns uuid
language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is not null then (select person_id from profiles where id = auth.uid() and active)
    when coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('', 'service_role')
      then nullif(current_setting('kvisa.as_person', true), '')::uuid
  end
$$;

-- ---------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------
create table public.job_posts (
  id uuid primary key default gen_random_uuid(),
  post_no bigint generated always as identity unique,
  intro text,
  body text not null default '',
  channels text[] not null default '{}' check (channels <@ array['whatsapp','sms']::text[]),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default clock_timestamp()
);

create table public.job_post_items (
  post_id uuid not null references public.job_posts(id) on delete restrict,
  item_no integer not null check (item_no > 0),
  offer_id uuid not null unique references public.task_offers(id) on delete restrict,
  task_id uuid not null references public.order_tasks(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  covered_person_id uuid references public.people(id),
  covered_at timestamptz,
  primary key (post_id, item_no)
);
create index job_post_items_task_idx on public.job_post_items (task_id);
create index job_post_items_no_idx on public.job_post_items (item_no);

create table public.message_inbox (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('whatsapp','sms')),
  provider_message_id text not null,
  from_address text not null,
  person_id uuid references public.people(id),
  body text,
  outcome text,          -- take | done | ignored | unknown_sender | error | duplicate
  detail text,
  received_at timestamptz not null default clock_timestamp(),
  unique (channel, provider_message_id)
);
create index message_inbox_time_idx on public.message_inbox (received_at desc);

create table public.message_outbox (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('whatsapp','sms')),
  to_kind text not null check (to_kind in ('group','person')),
  to_address text not null,
  person_id uuid references public.people(id),
  body text not null check (length(body) between 1 and 4000),
  mentions text[] not null default '{}',
  purpose text not null check (purpose in ('post','covered','reply')),
  post_id uuid references public.job_posts(id),
  inbox_id uuid references public.message_inbox(id),
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','cancelled')),
  attempts integer not null default 0,
  error text,
  provider_message_id text,
  locked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz
);
create index message_outbox_pending_idx on public.message_outbox (created_at) where status in ('pending','sending','failed');
create index message_outbox_time_idx on public.message_outbox (created_at desc);

alter table public.job_posts enable row level security;
alter table public.job_post_items enable row level security;
alter table public.message_inbox enable row level security;
alter table public.message_outbox enable row level security;
revoke all on public.job_posts, public.job_post_items, public.message_inbox, public.message_outbox from anon;
revoke insert, update, delete on public.job_posts, public.job_post_items, public.message_inbox, public.message_outbox from authenticated;
create policy job_posts_staff_read on public.job_posts for select to authenticated using (public.is_staff());
create policy job_post_items_staff_read on public.job_post_items for select to authenticated using (public.is_staff());
create policy message_inbox_staff_read on public.message_inbox for select to authenticated using (public.is_staff());
create policy message_outbox_staff_read on public.message_outbox for select to authenticated using (public.is_staff());

-- ---------------------------------------------------------------
-- Message text
-- ---------------------------------------------------------------
create or replace function public._fmt_when(p timestamptz)
returns text language sql stable security definer set search_path = public as $$
  select to_char(p at time zone (select time_zone from organization_settings where id = 1), 'Dy Mon FMDD, FMHH12:MI AM')
$$;

-- One line of a post: "2. Pickup from client — Main Street → Maple Avenue — Tue Oct 30, 10:00 AM — 4 bags"
create or replace function public._job_line(p_task uuid, p_no integer)
returns text language sql stable security definer set search_path = public as $$
  select format('%s. %s — %s → %s%s — %s bag%s', p_no, public.task_type_label(t.task_type),
    public.street_only(t.from_address), public.street_only(t.to_address),
    coalesce(' — ' || public._fmt_when(t.scheduled_at), ''),
    public._current_bags(t.order_id), case when public._current_bags(t.order_id) = 1 then '' else 's' end)
  from order_tasks t where t.id = p_task
$$;

create or replace function public._post_body(p_intro text, p_lines text[])
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(p_intro), ''), (select msg_post_intro from organization_settings where id = 1))
    || E'\n\n' || array_to_string(p_lines, E'\n')
    || E'\n\nReply privately with the job number (e.g. 2). Reply DONE when you finish.'
$$;

-- Job numbers are unique among jobs still open: a new post continues after the highest open
-- number, and starts again at 1 once everything earlier is covered or closed.
create or replace function public._next_item_no()
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(max(i.item_no), 0) + 1
  from job_post_items i join task_offers f on f.id = i.offer_id
  where f.status = 'available' and (f.expires_at is null or f.expires_at > now())
$$;

-- The stages to post, in the order they will be numbered.
create or replace function public._post_order(p_task_ids uuid[])
returns table (task_id uuid) language sql stable security definer set search_path = public as $$
  select t.id from order_tasks t join orders o on o.id = t.order_id
  where t.id = any(p_task_ids)
  order by t.scheduled_at nulls last, o.order_no, t.seq
$$;

-- ---------------------------------------------------------------
-- Staff: preview and post
-- ---------------------------------------------------------------
create or replace function public.job_post_preview(p_task_ids uuid[], p_intro text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare n integer; v_lines text[] := '{}'; v_items jsonb := '[]'; r record; v_block text;
begin
  perform public._require_staff();
  n := public._next_item_no() - 1;
  for r in select * from public._post_order(coalesce(p_task_ids, '{}')) loop
    n := n + 1;
    v_block := public._dispatch_block_reason(r.task_id);
    v_lines := v_lines || public._job_line(r.task_id, n);
    v_items := v_items || jsonb_build_object('task_id', r.task_id, 'item_no', n, 'blocked', v_block);
  end loop;
  return jsonb_build_object('body', case when cardinality(v_lines) > 0 then public._post_body(p_intro, v_lines) end, 'items', v_items);
end $$;

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
  if 'sms' = any(v_channels) and not s.sms_enabled then
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
      select distinct on (public._phone_e164(p.phone)) 'sms', 'person', public._phone_e164(p.phone), p.id, v_body, 'post', v_post
      from job_post_items i join offer_recipients rc on rc.offer_id = i.offer_id join people p on p.id = rc.person_id
      where i.post_id = v_post and public._phone_e164(p.phone) is not null;
    get diagnostics v_sms = row_count;
  end if;
  return jsonb_build_object('post_id', v_post, 'post_no', v_post_no, 'jobs', n - v_first + 1,
    'first_no', v_first, 'last_no', n, 'whatsapp', 'whatsapp' = any(v_channels), 'sms', v_sms, 'body', v_body);
end $$;

-- ---------------------------------------------------------------
-- "2 covered @driver" in the group, whenever a posted job is taken —
-- by a WhatsApp/SMS reply, in the app, or assigned by the dispatcher.
-- ---------------------------------------------------------------
create or replace function public._cover_post_item(p_offer uuid, p_person uuid)
returns void language plpgsql security definer set search_path = public as $$
declare i job_post_items%rowtype; s organization_settings%rowtype := public._settings(); v_phone text; v_name text;
begin
  update job_post_items set covered_person_id = p_person, covered_at = now()
    where offer_id = p_offer and covered_at is null returning * into i;
  if not found then return; end if;
  if not coalesce((select 'whatsapp' = any(channels) from job_posts where id = i.post_id), false) or not s.wa_enabled or coalesce(s.wa_group_id, '') = '' then
    return;
  end if;
  select public._phone_e164(phone), full_name into v_phone, v_name from people where id = p_person;
  insert into message_outbox (channel, to_kind, to_address, person_id, body, mentions, purpose, post_id)
    values ('whatsapp', 'group', s.wa_group_id, p_person,
      format('%s covered %s', i.item_no, case when v_phone is not null then '@' || v_phone else v_name end),
      case when v_phone is not null then array[v_phone] else '{}' end, 'covered', i.post_id);
end $$;

create or replace function public.post_item_on_offer_accepted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'accepted' and old.status = 'available' and new.accepted_person_id is not null then
    perform public._cover_post_item(new.id, new.accepted_person_id);
  end if;
  return new;
end $$;
create trigger t_post_item_accepted after update of status on public.task_offers
  for each row execute function public.post_item_on_offer_accepted();

-- The dispatcher assigning a posted stage directly also covers it: the open offer is closed
-- (so nobody else can take it) and the group is told.
create or replace function public.post_item_on_assign() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_offer uuid; v_action text := current_setting('kvisa.action', true); v_reason text := current_setting('kvisa.reason', true);
begin
  if new.assignee_id is null or new.assignee_id is not distinct from old.assignee_id then return new; end if;
  select f.id into v_offer from task_offers f join job_post_items i on i.offer_id = f.id
    where f.task_id = new.id and f.status = 'available' limit 1;
  if v_offer is null then return new; end if;
  perform set_config('kvisa.action', 'offer.cancelled', true);
  perform set_config('kvisa.reason', 'Assigned by dispatcher', true);
  update task_offers set status = 'cancelled', closed_at = now(), close_reason = 'Assigned by dispatcher' where id = v_offer;
  update offer_recipients set response = 'withdrawn', responded_at = now() where offer_id = v_offer and response = 'pending';
  perform set_config('kvisa.action', coalesce(v_action, ''), true);
  perform set_config('kvisa.reason', coalesce(v_reason, ''), true);
  perform public._cover_post_item(v_offer, new.assignee_id);
  return new;
end $$;
create trigger t_post_item_assign after update of assignee_id on public.order_tasks
  for each row execute function public.post_item_on_assign();

-- ---------------------------------------------------------------
-- Replies
-- ---------------------------------------------------------------
-- What the driver needs once a job is theirs.
create or replace function public._job_details(p_task uuid, p_no integer)
returns text language plpgsql stable security definer set search_path = public as $$
declare t order_tasks%rowtype; o orders%rowtype; v_full boolean := (select msg_send_address from organization_settings where id = 1);
  v_contact text; v_phone text; v_washer people%rowtype; v text;
begin
  select * into t from order_tasks where id = p_task;
  select * into o from orders where id = t.order_id;
  select p.* into v_washer from order_tasks w join people p on p.id = w.assignee_id where w.order_id = o.id and w.task_type = 'washing';
  case t.task_type
    when 'pickup' then v_contact := o.pickup_contact; v_phone := o.pickup_phone;
    when 'delivery' then v_contact := o.return_recipient; v_phone := o.return_phone;
    else v_contact := v_washer.full_name; v_phone := v_washer.phone;
  end case;
  v := format('Job %s is yours: %s%s (K-%s)', p_no, public.task_type_label(t.task_type),
    coalesce((select ' + ' || public.task_type_label(n.task_type) from order_tasks n
              where n.order_id = t.order_id and n.seq = t.seq + 1 and n.assignee_id = t.assignee_id
                and (t.task_type, n.task_type) in (('pickup','dropoff'), ('return_collection','delivery'))), ''),
    o.order_no);
  if t.scheduled_at is not null then v := v || E'\nWhen: ' || public._fmt_when(t.scheduled_at); end if;
  v := v || E'\nBags: ' || public._current_bags(o.id);
  if v_full then
    v := v || E'\nFrom: ' || coalesce(t.from_address, '—') || E'\nTo: ' || coalesce(t.to_address, '—');
    if coalesce(v_contact, v_phone) is not null then v := v || E'\nContact: ' || concat_ws(' ', v_contact, v_phone); end if;
    if nullif(btrim(t.instructions), '') is not null then v := v || E'\nNotes: ' || t.instructions; end if;
  else
    v := v || E'\nRoute: ' || public.street_only(t.from_address) || ' → ' || public.street_only(t.to_address)
      || E'\nThe exact addresses are in the Kvisa app under My tasks.';
  end if;
  return v || E'\nReply DONE when you finish.';
end $$;

-- A driver takes job number p_no. Returns the reply text.
create or replace function public._take_job(p_person uuid, p_no integer)
returns text language plpgsql security definer set search_path = public as $$
declare i record; v_err text;
begin
  select ji.*, f.open_to_all into i
    from job_post_items ji join task_offers f on f.id = ji.offer_id join job_posts jp on jp.id = ji.post_id
    where ji.item_no = p_no and f.status = 'available' and (f.expires_at is null or f.expires_at > now())
    order by jp.created_at desc limit 1;
  if not found then
    select ji.*, f.status as offer_status into i
      from job_post_items ji join task_offers f on f.id = ji.offer_id join job_posts jp on jp.id = ji.post_id
      where ji.item_no = p_no and jp.created_at > now() - interval '14 days'
      order by jp.created_at desc limit 1;
    if not found then return format('There is no job %s open right now.', p_no); end if;
    if i.covered_person_id = p_person then return format('Job %s is already yours.', p_no); end if;
    if i.covered_person_id is not null or i.offer_status = 'accepted' then return format('Sorry, job %s is already covered.', p_no); end if;
    return format('Sorry, job %s is no longer available.', p_no);
  end if;

  if not exists (select 1 from person_roles where person_id = p_person and role = 'driver' and active) then
    return format('Only drivers can take job %s. Please message the dispatcher.', p_no);
  end if;
  if not exists (select 1 from offer_recipients where offer_id = i.offer_id and person_id = p_person) then
    if not i.open_to_all then return format('Job %s was offered to other drivers. Please message the dispatcher.', p_no); end if;
    insert into offer_recipients (offer_id, order_id, person_id) values (i.offer_id, i.order_id, p_person);
  end if;

  perform set_config('kvisa.as_person', p_person::text, true);
  begin
    perform public.respond_offer(i.offer_id, true);
  exception when others then
    v_err := sqlerrm;
    perform set_config('kvisa.as_person', '', true);
    if v_err like 'KVISA_TAKEN%' then return format('Sorry, job %s is already covered.', p_no); end if;
    if v_err like '%already responded%' then return format('You already answered job %s in the app. Please message the dispatcher.', p_no); end if;
    return format('Couldn''t give you job %s: %s', p_no, regexp_replace(v_err, '^KVISA_[A-Z_]+: ', ''));
  end;
  perform set_config('kvisa.as_person', '', true);
  -- The same driver does the whole trip: pickup → washer, or washer → final delivery.
  perform public._wf('task.assigned', format('Same driver as job %s', p_no));
  update order_tasks set assignee_id = p_person
    where order_id = i.order_id and status = 'pending' and assignee_id is null
      and task_type = (select case task_type when 'pickup' then 'dropoff' when 'return_collection' then 'delivery' end
                       from order_tasks where id = i.task_id);
  return public._job_details(i.task_id, p_no);
end $$;

-- The step that completes each stage.
create or replace function public._done_event(p_type text)
returns text language sql immutable as $$
  select case p_type when 'pickup' then 'collected_from_client' when 'dropoff' then 'delivered_to_washer'
    when 'washing' then 'wash_completed' when 'return_collection' then 'collected_from_washer'
    when 'delivery' then 'delivered_to_recipient' end
$$;

-- A person replies DONE (optionally "DONE 2" with a job number, or "DONE K-1001").
-- Completes their ready stage — plus the next stage when it is the other half of the same
-- trip and also theirs (pickup + drop-off to washer; return collection + final delivery) —
-- with the bag count the order currently expects.
create or replace function public._mark_done(p_person uuid, p_text text, p_channel text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_ref_order bigint := substring(coalesce(p_text, '') from 'k ?-? ?([0-9]+)')::bigint;
  v_ref_item integer := case when v_ref_order is null then substring(coalesce(p_text, '') from '([0-9]+)')::int end;
  v_ref text := case when v_ref_order is not null then 'K-' || v_ref_order else v_ref_item::text end;
  v_target uuid; v_orders uuid[]; v_order uuid; o orders%rowtype; t order_tasks%rowtype; nxt order_tasks%rowtype;
  v_bags integer; v_done text[] := '{}'; v_list text; v_note text := 'Marked done by ' || case p_channel when 'sms' then 'text message' else 'WhatsApp' end || ' reply';
  v_err text; v_waiting text;
begin
  -- orders where this person's next stage is ready to record
  select array_agg(distinct t2.order_id) into v_orders
    from order_tasks t2 join orders o2 on o2.id = t2.order_id
    where t2.assignee_id = p_person and t2.status in ('pending','in_progress') and o2.status <> 'cancelled'
      and not exists (select 1 from order_tasks e where e.order_id = t2.order_id and e.seq < t2.seq and e.status <> 'completed');

  -- "DONE 2" means the job numbered 2 that they took most recently; "DONE K-1001" (or a number
  -- that is not one of their jobs) means an order number.
  if v_ref is not null then
    if v_ref_item is not null then
      select ji.order_id into v_target from job_post_items ji join job_posts jp on jp.id = ji.post_id
        where ji.item_no = v_ref_item and ji.covered_person_id = p_person and ji.order_id = any(coalesce(v_orders, '{}'))
        order by jp.created_at desc limit 1;
    end if;
    if v_target is null then
      select id into v_target from orders where order_no = coalesce(v_ref_order, v_ref_item) and id = any(coalesce(v_orders, '{}'));
    end if;
    if v_target is null then
      return format('I couldn''t find job %s among your open jobs. Please message the dispatcher.', v_ref);
    end if;
    v_orders := array[v_target];
  end if;

  if v_orders is null then
    select format('%s (K-%s)', public.task_type_label(t2.task_type), o2.order_no) into v_waiting
      from order_tasks t2 join orders o2 on o2.id = t2.order_id
      where t2.assignee_id = p_person and t2.status in ('pending','in_progress') and o2.status <> 'cancelled'
      order by t2.scheduled_at nulls last limit 1;
    if v_waiting is not null then
      return format('Your job %s can''t be marked done yet — the step before it isn''t recorded. Please message the dispatcher.', v_waiting);
    end if;
    return 'You have no open jobs to mark done.';
  end if;

  if cardinality(v_orders) > 1 then
    -- refer to each by its job number when that is unambiguous, otherwise by order number
    with c as (
      select o2.order_no,
        (select ji.item_no from job_post_items ji join job_posts jp on jp.id = ji.post_id
          where ji.order_id = o2.id and ji.covered_person_id = p_person order by jp.created_at desc limit 1) as item_no,
        (select task_type from order_tasks where order_id = o2.id and assignee_id = p_person and status <> 'completed' order by seq limit 1) as tt
      from orders o2 where o2.id = any(v_orders)),
    d as (select c.*, count(*) over (partition by item_no) as dup from c)
    select string_agg(format('DONE %s — %s (K-%s)',
        case when item_no is not null and dup = 1 then item_no::text else 'K-' || order_no end,
        public.task_type_label(tt), order_no), E'\n' order by order_no)
      into v_list from d;
    return E'You have more than one job open. Which one is done? Reply with:\n' || v_list;
  end if;

  v_order := v_orders[1];
  select * into o from orders where id = v_order;
  select * into t from order_tasks where order_id = v_order and assignee_id = p_person and status in ('pending','in_progress') order by seq limit 1;
  select * into nxt from order_tasks where order_id = v_order and seq = t.seq + 1;
  v_bags := public._current_bags(v_order);
  perform set_config('kvisa.as_person', p_person::text, true);
  begin
    if t.task_type = 'washing' and not exists (select 1 from handoff_effective h where h.task_id = t.id and h.event_type = 'received_by_washer') then
      perform public.record_handoff(t.id, 'received_by_washer', v_bags, v_note);
    end if;
    perform public.record_handoff(t.id, public._done_event(t.task_type), v_bags, v_note);
    v_done := v_done || public.task_type_label(t.task_type);
    if ((t.task_type = 'pickup' and nxt.task_type = 'dropoff') or (t.task_type = 'return_collection' and nxt.task_type = 'delivery'))
       and nxt.assignee_id = p_person and nxt.status <> 'completed' then
      perform public.record_handoff(nxt.id, public._done_event(nxt.task_type), v_bags, v_note);
      v_done := v_done || public.task_type_label(nxt.task_type);
    end if;
  exception when others then
    v_err := regexp_replace(sqlerrm, '^KVISA_[A-Z_]+: ', '');
    perform set_config('kvisa.as_person', '', true);
    perform public._notify_staff('exception', format('DONE reply could not be recorded — K-%s', o.order_no),
      format('%s replied DONE: %s', (select full_name from people where id = p_person), v_err), o.id, t.id);
    return format('I couldn''t mark K-%s done: %s. The dispatcher has been told.', o.order_no, v_err);
  end;
  perform set_config('kvisa.as_person', '', true);
  return format('Thanks! Marked done: %s — K-%s, %s bag%s. If the bag count was different, tell the dispatcher.',
    array_to_string(v_done, ' + '), o.order_no, v_bags, case when v_bags = 1 then '' else 's' end);
end $$;

-- Entry point for every private message that arrives (called by the messaging Edge Function
-- with the service key). Only known people get answers, and only to a job number or DONE —
-- any other chat is left for the dispatcher to read.
create or replace function public.message_inbound(p_channel text, p_from text, p_body text, p_provider_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_from text := public._phone_e164(case when p_channel = 'whatsapp' and p_from !~ '^\s*\+' then '+' || p_from else p_from end);
  v_inbox uuid; v_person uuid; v_text text; v_raw text := btrim(coalesce(p_body, ''));
  v_nums integer[]; v_no integer; v_reply text := ''; v_outcome text;
begin
  if p_channel not in ('whatsapp','sms') then raise exception 'KVISA_VALIDATION: unknown channel'; end if;
  insert into message_inbox (channel, provider_message_id, from_address, body)
    values (p_channel, coalesce(nullif(p_provider_id, ''), gen_random_uuid()::text), coalesce(v_from, p_from), left(v_raw, 2000))
    on conflict (channel, provider_message_id) do nothing
    returning id into v_inbox;
  if v_inbox is null then return jsonb_build_object('outcome', 'duplicate'); end if;

  select id into v_person from people where active and public._phone_e164(phone) = v_from order by created_at limit 1;
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

-- ---------------------------------------------------------------
-- Outbox: claimed and settled by the sender; staff can retry or cancel.
-- ---------------------------------------------------------------
create or replace function public.outbox_claim(p_limit integer default 25)
returns setof public.message_outbox language sql security definer set search_path = public as $$
  update message_outbox m set status = 'sending', attempts = m.attempts + 1, locked_at = now()
  where m.id in (
    select id from message_outbox
    where status = 'pending'
       or (status = 'sending' and locked_at < now() - interval '5 minutes')
       or (status = 'failed' and attempts < 3 and created_at > now() - interval '1 day')
    order by created_at limit greatest(1, least(p_limit, 100))
    for update skip locked)
  returning m.*
$$;

create or replace function public.outbox_finish(p_id uuid, p_ok boolean, p_provider_id text default null, p_error text default null)
returns void language sql security definer set search_path = public as $$
  update message_outbox set
    status = case when p_ok then 'sent' else 'failed' end,
    sent_at = case when p_ok then now() end,
    provider_message_id = coalesce(p_provider_id, provider_message_id),
    error = case when p_ok then null else left(p_error, 1000) end,
    locked_at = null
  where id = p_id and status = 'sending'
$$;

create or replace function public.outbox_retry(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_staff();
  update message_outbox set status = 'pending', attempts = 0, error = null where id = p_id and status in ('failed','cancelled');
  if not found then raise exception 'KVISA_VALIDATION: only failed or cancelled messages can be sent again'; end if;
end $$;

create or replace function public.outbox_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_staff();
  update message_outbox set status = 'cancelled' where id = p_id and status in ('pending','failed');
  if not found then raise exception 'KVISA_VALIDATION: this message was already sent'; end if;
end $$;

-- ---------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------
revoke execute on function public._phone_e164(text), public._fmt_when(timestamptz), public._job_line(uuid, integer),
  public._post_body(text, text[]), public._next_item_no(), public._post_order(uuid[]), public._cover_post_item(uuid, uuid),
  public._job_details(uuid, integer), public._take_job(uuid, integer), public._done_event(text), public._mark_done(uuid, text, text),
  public.post_item_on_offer_accepted(), public.post_item_on_assign()
  from public, anon, authenticated;
revoke execute on function public.message_inbound(text, text, text, text), public.outbox_claim(integer),
  public.outbox_finish(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.message_inbound(text, text, text, text), public.outbox_claim(integer),
  public.outbox_finish(uuid, boolean, text, text) to service_role;
revoke execute on function public.job_post_preview(uuid[], text), public.post_jobs(uuid[], text, text[], integer),
  public.outbox_retry(uuid), public.outbox_cancel(uuid) from public, anon;
grant execute on function public.job_post_preview(uuid[], text), public.post_jobs(uuid[], text, text[], integer),
  public.outbox_retry(uuid), public.outbox_cancel(uuid) to authenticated;
