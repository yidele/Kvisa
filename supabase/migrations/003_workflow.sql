-- Kvisa 003: workflow — order creation, assignments, handoffs, exceptions, corrections

-- ---------------------------------------------------------------
-- Small internal helpers
-- ---------------------------------------------------------------
create or replace function public._wf(p_action text, p_reason text default null)
returns void language plpgsql as $$
begin
  perform set_config('kvisa.rpc', 'on', true);
  perform set_config('kvisa.action', coalesce(p_action, ''), true);
  perform set_config('kvisa.reason', coalesce(p_reason, ''), true);
end $$;

create or replace function public._require_staff() returns void language plpgsql stable as $$
begin
  if not public.is_staff() then
    raise exception 'KVISA_FORBIDDEN: only administrators and dispatchers can do this' using errcode = '42501';
  end if;
end $$;

create or replace function public._settings() returns organization_settings
language sql stable security definer set search_path = public as $$
  select * from organization_settings where id = 1
$$;

create or replace function public._local_ts(p_date date, p_time time)
returns timestamptz language sql stable security definer set search_path = public as $$
  select case when p_date is null then null
              else (p_date + coalesce(p_time, (select default_pickup_time from organization_settings where id = 1)))
                   at time zone (select time_zone from organization_settings where id = 1) end
$$;

create or replace function public._today() returns date language sql stable security definer set search_path = public as $$
  select (now() at time zone (select time_zone from organization_settings where id = 1))::date
$$;

create or replace function public.task_type_label(p text) returns text language sql immutable as $$
  select case p when 'pickup' then 'Pickup from client' when 'dropoff' then 'Drop-off to washer'
    when 'washing' then 'Washing' when 'return_collection' then 'Return collection'
    when 'delivery' then 'Final delivery' else p end
$$;

-- ---------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------
create or replace function public._notify_user(p_user uuid, p_kind text, p_title text, p_body text,
  p_order uuid, p_task uuid, p_dedupe text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then return; end if;
  if not (p_kind = any((select notify_kinds from organization_settings where id = 1))) then return; end if;
  insert into notifications (user_id, kind, title, body, order_id, task_id, dedupe_key)
  values (p_user, p_kind, p_title, p_body, p_order, p_task, p_dedupe)
  on conflict (user_id, dedupe_key) do nothing;
end $$;

create or replace function public._notify_person(p_person uuid, p_kind text, p_title text, p_body text,
  p_order uuid, p_task uuid, p_dedupe text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  select id into v_user from profiles where person_id = p_person and active;
  perform public._notify_user(v_user, p_kind, p_title, p_body, p_order, p_task, p_dedupe);
end $$;

create or replace function public._notify_staff(p_kind text, p_title text, p_body text,
  p_order uuid, p_task uuid, p_dedupe text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select distinct p.id from profiles p join user_roles ur on ur.user_id = p.id
           where p.active and ur.role in ('admin','dispatcher') and p.id is distinct from auth.uid()
  loop
    perform public._notify_user(r.id, p_kind, p_title, p_body, p_order, p_task, p_dedupe);
  end loop;
end $$;

-- ---------------------------------------------------------------
-- Effective handoff events: excludes reverted events, applies count corrections.
-- ---------------------------------------------------------------
create or replace view public.handoff_effective with (security_invoker = true) as
select e.*,
  coalesce((select c.actual_bags from public.handoff_events c
            where c.corrects_event_id = e.id and c.event_type = 'count_correction'
            order by c.recorded_at desc limit 1), e.actual_bags) as effective_bags
from public.handoff_events e
where e.event_type not in ('count_correction','event_reverted')
  and not exists (select 1 from public.handoff_events r
                  where r.corrects_event_id = e.id and r.event_type = 'event_reverted');

create or replace function public._current_bags(p_order uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select effective_bags from handoff_effective
      where order_id = p_order and effective_bags is not null
      order by occurred_at desc, recorded_at desc limit 1),
    (select expected_bags from orders where id = p_order))
$$;

-- ---------------------------------------------------------------
-- Order status is derived from tasks + exceptions (never typed in by hand)
-- ---------------------------------------------------------------
create or replace function public.recompute_order_status(p_order uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype;
  t record;
  v_status text;
  v_open int; v_blocking int;
  v_delivered boolean;
  v_prev_rpc text; v_prev_action text;
begin
  select * into o from orders where id = p_order for update;
  if o.status = 'cancelled' then return 'cancelled'; end if;

  select count(*) filter (where true), count(*) filter (where kind in ('failed_pickup','missing_bags'))
    into v_open, v_blocking
    from order_exceptions where order_id = p_order and status = 'open';

  select exists (select 1 from order_tasks where order_id = p_order and task_type = 'delivery' and status = 'completed')
    into v_delivered;

  if v_delivered then
    v_status := case when v_open > 0 then 'exception' else 'completed' end;
  elsif v_blocking > 0 then
    v_status := 'exception';
  else
    select * into t from order_tasks where order_id = p_order and status <> 'completed' order by seq limit 1;
    v_status := case t.task_type
      when 'pickup' then
        case when t.status = 'in_progress' then 'pickup_in_progress'
             when t.assignee_id is not null and t.scheduled_at is not null then 'scheduled'
             else 'requested' end
      when 'dropoff' then 'awaiting_dropoff'
      when 'washing' then case when t.started_at is not null then 'washing_in_progress' else 'awaiting_washing' end
      when 'return_collection' then case when t.status = 'in_progress' then 'return_collection_in_progress' else 'ready_for_return' end
      when 'delivery' then 'out_for_delivery'
      else 'requested' end;
  end if;

  if v_status is distinct from o.status then
    v_prev_rpc := coalesce(current_setting('kvisa.rpc', true), '');
    v_prev_action := coalesce(current_setting('kvisa.action', true), '');
    perform set_config('kvisa.rpc', 'on', true);
    perform set_config('kvisa.action', 'order.status_changed', true);
    update orders set status = v_status,
      completed_at = case when v_status = 'completed' then coalesce(o.completed_at, now()) else null end
    where id = p_order;
    perform set_config('kvisa.rpc', v_prev_rpc, true);
    perform set_config('kvisa.action', v_prev_action, true);
  end if;
  return v_status;
end $$;

-- ---------------------------------------------------------------
-- Assignee validation + assignment history + notifications
-- ---------------------------------------------------------------
create or replace function public.validate_task_assignee() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_need text := case when new.task_type = 'washing' then 'washer' else 'driver' end;
begin
  if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    if not exists (select 1 from people p join person_roles r on r.person_id = p.id
                   where p.id = new.assignee_id and p.active and r.active and r.role = v_need) then
      raise exception 'KVISA_INVALID_ASSIGNEE: this person is not an active %', case v_need when 'washer' then 'washing volunteer' else 'driver' end;
    end if;
  end if;
  return new;
end $$;
create trigger t_validate_assignee before insert or update of assignee_id on public.order_tasks
  for each row execute function public.validate_task_assignee();

create or replace function public.track_assignment() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_no bigint; v_reason text := nullif(current_setting('kvisa.reason', true), '');
  v_label text := public.task_type_label(new.task_type);
  v_washer_old text; v_washer_new text;
begin
  select order_no into v_no from orders where id = new.order_id;

  if tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id then
    update task_assignments set ended_at = now() where task_id = new.id and ended_at is null;
    if new.assignee_id is not null then
      insert into task_assignments (task_id, person_id, assigned_by, reason)
        values (new.id, new.assignee_id, auth.uid(), v_reason);
      perform public._notify_person(new.assignee_id,
        case when tg_op = 'INSERT' or old.assignee_id is null then 'assigned' else 'reassigned' end,
        format('New task: %s — order K-%s', v_label, v_no),
        case when new.scheduled_at is not null then 'Scheduled ' || to_char(new.scheduled_at at time zone (select time_zone from organization_settings where id=1), 'Dy Mon DD, HH12:MI AM') end,
        new.order_id, new.id);
    end if;
    if tg_op = 'UPDATE' and old.assignee_id is not null then
      perform public._notify_person(old.assignee_id, 'reassigned',
        format('Removed from %s — order K-%s', v_label, v_no), 'This task was given to someone else.',
        new.order_id, new.id);
    end if;

    -- When the washer changes, point the not-yet-done drop-off and return-collection legs
    -- at the new washer's address (only if they still pointed at the old washer or were blank).
    if new.task_type = 'washing' and tg_op = 'UPDATE' then
      select address into v_washer_old from people where id = old.assignee_id;
      select address into v_washer_new from people where id = new.assignee_id;
      update order_tasks set to_address = v_washer_new
        where order_id = new.order_id and task_type = 'dropoff' and status <> 'completed'
          and (to_address is null or to_address = v_washer_old);
      update order_tasks set from_address = v_washer_new
        where order_id = new.order_id and task_type = 'return_collection' and status <> 'completed'
          and (from_address is null or from_address = v_washer_old);
      update order_tasks set from_address = coalesce(v_washer_new, from_address)
        where id = new.id and (from_address is null or from_address = v_washer_old);
    end if;
  elsif new.scheduled_at is distinct from old.scheduled_at and new.assignee_id is not null then
    perform public._notify_person(new.assignee_id, 'schedule_changed',
      format('Time changed: %s — order K-%s', v_label, v_no),
      case when new.scheduled_at is not null then 'Now ' || to_char(new.scheduled_at at time zone (select time_zone from organization_settings where id=1), 'Dy Mon DD, HH12:MI AM') end,
      new.order_id, new.id);
  end if;

  if tg_op = 'UPDATE' and not public.in_workflow() then
    -- Editing a single recurring occurrence detaches it from later series edits.
    update orders set detached_from_series = true
      where id = new.order_id and recurring_schedule_id is not null and not detached_from_series;
    perform public.recompute_order_status(new.order_id);
  end if;
  return new;
end $$;
create trigger t_track_assignment after insert or update of assignee_id, scheduled_at on public.order_tasks
  for each row execute function public.track_assignment();

create or replace function public.orders_mark_detached() returns trigger language plpgsql as $$
begin
  if not public.in_workflow() and new.recurring_schedule_id is not null then
    new.detached_from_series := true;
  end if;
  return new;
end $$;
create trigger t_detach before update on public.orders for each row execute function public.orders_mark_detached();

-- ---------------------------------------------------------------
-- create_order: order + its five stage tasks in one transaction
-- ---------------------------------------------------------------
create or replace function public._create_order(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c clients%rowtype;
  s organization_settings%rowtype := public._settings();
  v_id uuid;
  v_bags int := coalesce((p->>'expected_bags')::int, 1);
  v_pickup_at timestamptz;
  v_wash_date date; v_return_date date;
  v_washer uuid := nullif(p->>'washer_id','')::uuid;
  v_washer_addr text;
  v_pickup_addr text; v_return_addr text;
begin
  select * into c from clients where id = (p->>'client_id')::uuid;
  if not found then raise exception 'KVISA_VALIDATION: choose a client'; end if;
  if not c.active then raise exception 'KVISA_VALIDATION: this client is inactive'; end if;
  if v_bags < 0 or v_bags > 500 then raise exception 'KVISA_VALIDATION: bag count must be a whole number from 0 to 500'; end if;

  v_pickup_at := coalesce(nullif(p->>'pickup_at','')::timestamptz, public._local_ts(public._today(), s.default_pickup_time));
  v_wash_date := coalesce(nullif(p->>'expected_wash_date','')::date,
                          ((v_pickup_at at time zone s.time_zone)::date + s.default_wash_days));
  v_return_date := coalesce(nullif(p->>'expected_return_date','')::date,
                            ((v_pickup_at at time zone s.time_zone)::date + s.default_return_days));
  if v_return_date < (v_pickup_at at time zone s.time_zone)::date then
    raise exception 'KVISA_VALIDATION: the return date cannot be before the pickup date';
  end if;
  select address into v_washer_addr from people where id = v_washer;
  v_pickup_addr := coalesce(nullif(p->>'pickup_address',''), c.pickup_address);
  v_return_addr := coalesce(nullif(p->>'return_address',''), c.default_return_address, v_pickup_addr);

  insert into orders (client_id, category_id, pickup_contact, pickup_phone, pickup_address,
    return_recipient, return_phone, return_address, delivery_instructions, expected_bags, bag_notes,
    expected_return_date, notes, recurring_schedule_id, occurrence_date)
  values (c.id, c.category_id,
    coalesce(nullif(p->>'pickup_contact',''), c.primary_contact, c.name),
    coalesce(nullif(p->>'pickup_phone',''), c.phone),
    v_pickup_addr,
    coalesce(nullif(p->>'return_recipient',''), c.default_return_recipient, c.primary_contact, c.name),
    coalesce(nullif(p->>'return_phone',''), c.default_return_phone, c.phone),
    v_return_addr,
    coalesce(nullif(p->>'delivery_instructions',''), c.access_instructions),
    v_bags, nullif(p->>'bag_notes',''), v_return_date, nullif(p->>'notes',''),
    nullif(p->>'recurring_schedule_id','')::uuid, nullif(p->>'occurrence_date','')::date)
  returning id into v_id;

  insert into order_tasks (order_id, task_type, seq, assignee_id, scheduled_at, from_address, to_address, expected_bags, instructions, notes)
  values
    (v_id, 'pickup', 1, nullif(p->>'pickup_driver_id','')::uuid, v_pickup_at, v_pickup_addr, v_washer_addr, v_bags,
       coalesce(nullif(p->>'delivery_instructions',''), c.access_instructions), nullif(p->>'pickup_notes','')),
    (v_id, 'dropoff', 2, coalesce(nullif(p->>'dropoff_driver_id','')::uuid, nullif(p->>'pickup_driver_id','')::uuid),
       coalesce(nullif(p->>'dropoff_at','')::timestamptz, v_pickup_at + interval '1 hour'), v_pickup_addr, v_washer_addr, v_bags, null, null),
    (v_id, 'washing', 3, v_washer, public._local_ts(v_wash_date, s.default_pickup_time), v_washer_addr, v_washer_addr, v_bags,
       nullif(p->>'washing_instructions',''), null),
    (v_id, 'return_collection', 4, nullif(p->>'return_driver_id','')::uuid,
       coalesce(nullif(p->>'return_collection_at','')::timestamptz, public._local_ts(v_return_date, s.default_pickup_time)),
       v_washer_addr, v_return_addr, null, null, null),
    (v_id, 'delivery', 5, coalesce(nullif(p->>'delivery_driver_id','')::uuid, nullif(p->>'return_driver_id','')::uuid),
       coalesce(nullif(p->>'delivery_at','')::timestamptz, public._local_ts(v_return_date, s.default_pickup_time) + interval '1 hour'),
       v_washer_addr, v_return_addr, null, coalesce(nullif(p->>'delivery_instructions',''), c.access_instructions), null);

  perform public.recompute_order_status(v_id);
  return v_id;
end $$;

create or replace function public.create_order(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  perform public._require_staff();
  perform public._wf(null);
  return public._create_order(p);
end $$;

-- ---------------------------------------------------------------
-- Handoffs
-- ---------------------------------------------------------------
create or replace function public.record_handoff(p_task_id uuid, p_event text, p_actual_bags integer default null,
  p_notes text default null, p_occurred_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t order_tasks%rowtype;
  o orders%rowtype;
  s organization_settings%rowtype := public._settings();
  v_is_staff boolean := public.is_staff();
  v_counting boolean := p_event in ('collected_from_client','delivered_to_washer','received_by_washer',
                                    'wash_completed','collected_from_washer','delivered_to_recipient');
  v_completes boolean := p_event in ('collected_from_client','delivered_to_washer','wash_completed',
                                     'collected_from_washer','delivered_to_recipient');
  v_expected int; v_event uuid; v_ex uuid; v_at timestamptz := coalesce(p_occurred_at, now());
  v_from uuid; v_to uuid; v_from_party text; v_to_party text; v_loc text;
  v_washer uuid; v_status text; v_washing_received boolean;
  v_flag boolean;
begin
  select * into t from order_tasks where id = p_task_id for update;
  if not found then raise exception 'KVISA_NOT_FOUND: task not found'; end if;
  if not v_is_staff and (public.my_person_id() is null or public.my_person_id() is distinct from t.assignee_id) then
    raise exception 'KVISA_FORBIDDEN: this task is not assigned to you' using errcode = '42501';
  end if;
  select * into o from orders where id = t.order_id for update;
  if o.status = 'cancelled' then raise exception 'KVISA_VALIDATION: this order is cancelled'; end if;
  if t.status = 'completed' then raise exception 'KVISA_VALIDATION: this stage is already completed'; end if;
  if v_at > now() + interval '10 minutes' then raise exception 'KVISA_VALIDATION: the time cannot be in the future'; end if;

  if not ((t.task_type = 'pickup' and p_event in ('task_started','collected_from_client'))
       or (t.task_type = 'dropoff' and p_event in ('task_started','delivered_to_washer'))
       or (t.task_type = 'washing' and p_event in ('received_by_washer','wash_started','wash_completed'))
       or (t.task_type = 'return_collection' and p_event in ('task_started','collected_from_washer'))
       or (t.task_type = 'delivery' and p_event in ('task_started','delivered_to_recipient'))) then
    raise exception 'KVISA_VALIDATION: "%" is not a valid step for %', p_event, public.task_type_label(t.task_type);
  end if;

  if v_counting then
    if p_actual_bags is null then raise exception 'KVISA_VALIDATION: enter the number of bags'; end if;
    if p_actual_bags < 0 or p_actual_bags > 500 then raise exception 'KVISA_VALIDATION: bag count must be a whole number from 0 to 500'; end if;
  end if;

  if exists (select 1 from order_tasks where order_id = t.order_id and seq < t.seq and status <> 'completed') then
    raise exception 'KVISA_OUT_OF_ORDER: the earlier stage (%) has not been recorded yet',
      (select public.task_type_label(task_type) from order_tasks where order_id = t.order_id and seq < t.seq and status <> 'completed' order by seq limit 1);
  end if;

  select exists (select 1 from handoff_effective where task_id = t.id and event_type = 'received_by_washer') into v_washing_received;
  if t.task_type = 'washing' and p_event in ('wash_started','wash_completed') and not v_washing_received then
    raise exception 'KVISA_OUT_OF_ORDER: confirm receipt of the bags first';
  end if;
  if t.task_type = 'washing' and p_event = 'received_by_washer' and v_washing_received then
    raise exception 'KVISA_VALIDATION: receipt was already confirmed';
  end if;

  v_expected := public._current_bags(t.order_id);
  select assignee_id into v_washer from order_tasks where order_id = t.order_id and task_type = 'washing';

  case p_event
    when 'collected_from_client' then v_from_party := o.pickup_contact; v_to := t.assignee_id; v_loc := t.from_address; v_expected := o.expected_bags;
    when 'delivered_to_washer' then v_from := t.assignee_id; v_to := v_washer; v_loc := t.to_address;
    when 'received_by_washer' then v_from := (select assignee_id from order_tasks where order_id = t.order_id and task_type = 'dropoff'); v_to := t.assignee_id; v_loc := t.from_address;
    when 'wash_started' then v_from := t.assignee_id; v_loc := t.from_address;
    when 'wash_completed' then v_from := t.assignee_id; v_loc := t.from_address;
    when 'collected_from_washer' then v_from := v_washer; v_to := t.assignee_id; v_loc := t.from_address;
    when 'delivered_to_recipient' then v_from := t.assignee_id; v_to_party := o.return_recipient; v_loc := t.to_address;
    else v_from := t.assignee_id; v_loc := t.from_address;
  end case;

  perform public._wf('handoff.' || p_event, p_notes);
  insert into handoff_events (order_id, task_id, event_type, expected_bags, actual_bags,
    from_person_id, to_person_id, from_party, to_party, location, occurred_at, notes)
  values (t.order_id, t.id, p_event, case when v_counting then v_expected end,
    case when v_counting then p_actual_bags end, v_from, v_to, v_from_party, v_to_party, v_loc, v_at, nullif(p_notes,''))
  returning id into v_event;

  -- Discrepancy check
  v_flag := v_counting and p_actual_bags is distinct from v_expected
            and (p_event <> 'collected_from_client' or s.flag_collection_vs_expected);
  if v_flag then
    perform public._wf('exception.reported', null);
    insert into order_exceptions (order_id, task_id, handoff_event_id, kind, description, expected_bags, actual_bags)
    values (t.order_id, t.id, v_event, 'bag_discrepancy',
      format('%s: expected %s bag(s), recorded %s.', public.task_type_label(t.task_type), v_expected, p_actual_bags)
        || coalesce(' Note: ' || nullif(p_notes,''), ''),
      v_expected, p_actual_bags)
    returning id into v_ex;
    perform public._notify_staff('exception', format('Bag count mismatch — order K-%s', o.order_no),
      format('%s: expected %s, recorded %s', public.task_type_label(t.task_type), v_expected, p_actual_bags), o.id, t.id);
  end if;

  perform public._wf('task.status_changed', null);
  update order_tasks set
    status = case when v_completes then 'completed' else 'in_progress' end,
    started_at = case
      when t.task_type = 'washing' and p_event = 'received_by_washer' then started_at
      when t.task_type = 'washing' then coalesce(started_at, v_at)
      else coalesce(started_at, v_at) end,
    completed_at = case when v_completes then v_at else null end,
    actual_bags = case when v_counting then p_actual_bags else actual_bags end
  where id = t.id;

  -- Carry the latest count forward as the expectation for later stages
  if v_counting then
    update order_tasks set expected_bags = p_actual_bags
      where order_id = t.order_id and seq > t.seq and status <> 'completed';
  end if;

  if p_event = 'wash_completed' then
    perform public._notify_staff('washing_completed', format('Washing done — order K-%s', o.order_no),
      format('%s bag(s) ready for return collection', p_actual_bags), o.id, t.id);
    perform public._notify_person((select assignee_id from order_tasks where order_id = o.id and task_type = 'return_collection'),
      'return_ready', format('Ready to collect — order K-%s', o.order_no),
      format('%s bag(s) ready at the washer', p_actual_bags), o.id,
      (select id from order_tasks where order_id = o.id and task_type = 'return_collection'));
  elsif p_event = 'delivered_to_recipient' then
    perform public._notify_staff('delivered', format('Delivered — order K-%s', o.order_no),
      format('%s bag(s) delivered to %s', p_actual_bags, coalesce(o.return_recipient, 'recipient')), o.id, t.id);
  end if;

  v_status := public.recompute_order_status(t.order_id);
  return jsonb_build_object('event_id', v_event, 'exception_id', v_ex, 'order_status', v_status);
end $$;

-- ---------------------------------------------------------------
-- Problems / exceptions
-- ---------------------------------------------------------------
create or replace function public.report_problem(p_task_id uuid, p_kind text, p_description text, p_bags integer default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare t order_tasks%rowtype; v_id uuid; v_no bigint;
begin
  select * into t from order_tasks where id = p_task_id;
  if not found then raise exception 'KVISA_NOT_FOUND: task not found'; end if;
  if not public.is_staff() and (public.my_person_id() is null or public.my_person_id() is distinct from t.assignee_id) then
    raise exception 'KVISA_FORBIDDEN: this task is not assigned to you' using errcode = '42501';
  end if;
  if p_kind not in ('failed_pickup','missing_bags','delay','bag_discrepancy','other') then
    raise exception 'KVISA_VALIDATION: unknown problem type';
  end if;
  if coalesce(trim(p_description), '') = '' then raise exception 'KVISA_VALIDATION: describe the problem'; end if;
  if p_bags is not null and (p_bags < 0 or p_bags > 500) then raise exception 'KVISA_VALIDATION: bag count must be 0 to 500'; end if;

  perform public._wf('exception.reported', null);
  insert into order_exceptions (order_id, task_id, kind, description, actual_bags)
    values (t.order_id, t.id, p_kind, trim(p_description), p_bags) returning id into v_id;
  select order_no into v_no from orders where id = t.order_id;
  perform public._notify_staff('exception', format('Problem reported — order K-%s', v_no),
    public.task_type_label(t.task_type) || ': ' || trim(p_description), t.order_id, t.id);
  perform public.recompute_order_status(t.order_id);
  return v_id;
end $$;

create or replace function public.resolve_exception(p_exception_id uuid, p_resolution text)
returns void language plpgsql security definer set search_path = public as $$
declare v_order uuid;
begin
  perform public._require_staff();
  if coalesce(trim(p_resolution), '') = '' then raise exception 'KVISA_VALIDATION: explain how this was resolved'; end if;
  perform public._wf('exception.resolved', p_resolution);
  update order_exceptions set status = 'resolved', resolution = trim(p_resolution), resolved_by = auth.uid(), resolved_at = now()
    where id = p_exception_id and status = 'open' returning order_id into v_order;
  if v_order is null then raise exception 'KVISA_VALIDATION: this exception is already resolved or does not exist'; end if;
  perform public.recompute_order_status(v_order);
end $$;

-- ---------------------------------------------------------------
-- Corrections (originals are kept; corrections are new records)
-- ---------------------------------------------------------------
create or replace function public.correct_handoff_count(p_event_id uuid, p_new_count integer, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare e handoff_events%rowtype; v_id uuid; v_last boolean;
begin
  perform public._require_staff();
  if coalesce(trim(p_reason), '') = '' then raise exception 'KVISA_VALIDATION: a reason is required for corrections'; end if;
  if p_new_count is null or p_new_count < 0 or p_new_count > 500 then raise exception 'KVISA_VALIDATION: bag count must be 0 to 500'; end if;
  select * into e from handoff_events where id = p_event_id;
  if not found or e.actual_bags is null or e.event_type in ('count_correction','event_reverted') then
    raise exception 'KVISA_VALIDATION: this event has no bag count to correct';
  end if;
  perform public._wf('handoff.count_correction', p_reason);
  insert into handoff_events (order_id, task_id, event_type, expected_bags, actual_bags, location, corrects_event_id, notes, occurred_at)
    values (e.order_id, e.task_id, 'count_correction',
      (select effective_bags from handoff_effective where id = e.id), p_new_count, e.location, e.id, trim(p_reason), e.occurred_at)
    returning id into v_id;
  -- keep the task's recorded count in step if this was its completing event
  select not exists (select 1 from handoff_effective x where x.task_id = e.task_id and x.effective_bags is not null
                     and (x.occurred_at, x.recorded_at) > (e.occurred_at, e.recorded_at)) into v_last;
  if v_last then
    update order_tasks set actual_bags = p_new_count where id = e.task_id;
  end if;
  perform public.recompute_order_status(e.order_id);
  return v_id;
end $$;

create or replace function public.reopen_task(p_task_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare t order_tasks%rowtype; r record;
begin
  perform public._require_staff();
  if coalesce(trim(p_reason), '') = '' then raise exception 'KVISA_VALIDATION: a reason is required to reopen a stage'; end if;
  select * into t from order_tasks where id = p_task_id for update;
  if not found then raise exception 'KVISA_NOT_FOUND: task not found'; end if;
  if t.status not in ('completed','in_progress') then raise exception 'KVISA_VALIDATION: this stage has nothing recorded to undo'; end if;
  if exists (select 1 from order_tasks where order_id = t.order_id and seq > t.seq and status in ('completed','in_progress')) then
    raise exception 'KVISA_VALIDATION: undo the later stages first (most recent first)';
  end if;
  perform public._wf('handoff.event_reverted', p_reason);
  for r in select id, location, occurred_at from handoff_effective where task_id = t.id loop
    insert into handoff_events (order_id, task_id, event_type, corrects_event_id, location, notes, occurred_at)
      values (t.order_id, t.id, 'event_reverted', r.id, r.location, trim(p_reason), now());
  end loop;
  perform public._wf('task.reopened', p_reason);
  update order_tasks set status = 'pending', started_at = null, completed_at = null, actual_bags = null where id = t.id;
  perform public.recompute_order_status(t.order_id);
end $$;

-- ---------------------------------------------------------------
-- Cancel / reopen orders
-- ---------------------------------------------------------------
create or replace function public.cancel_order(p_order_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; r record;
begin
  perform public._require_staff();
  if coalesce(trim(p_reason), '') = '' then raise exception 'KVISA_VALIDATION: a cancellation reason is required'; end if;
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'KVISA_NOT_FOUND: order not found'; end if;
  if o.status = 'cancelled' then raise exception 'KVISA_VALIDATION: already cancelled'; end if;
  if o.status = 'completed' then raise exception 'KVISA_VALIDATION: a completed order cannot be cancelled'; end if;
  perform public._wf('order.cancelled', p_reason);
  update orders set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = trim(p_reason)
    where id = p_order_id;
  for r in select id, assignee_id, task_type from order_tasks where order_id = p_order_id and status in ('pending','in_progress') loop
    update order_tasks set status = 'cancelled' where id = r.id;
    perform public._notify_person(r.assignee_id, 'schedule_changed', format('Cancelled: order K-%s', o.order_no),
      public.task_type_label(r.task_type) || ' is no longer needed. Reason: ' || trim(p_reason), o.id, r.id);
  end loop;
end $$;

create or replace function public.reopen_order(p_order_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare o orders%rowtype;
begin
  perform public._require_staff();
  if coalesce(trim(p_reason), '') = '' then raise exception 'KVISA_VALIDATION: a reason is required'; end if;
  select * into o from orders where id = p_order_id for update;
  if o.status <> 'cancelled' then raise exception 'KVISA_VALIDATION: only cancelled orders can be reopened'; end if;
  perform public._wf('order.reopened', p_reason);
  update orders set status = 'requested', cancelled_at = null, cancelled_by = null, cancel_reason = null where id = p_order_id;
  update order_tasks set status = case when started_at is not null then 'in_progress' else 'pending' end
    where order_id = p_order_id and status = 'cancelled';
  perform public.recompute_order_status(p_order_id);
end $$;

-- ---------------------------------------------------------------
-- Field users (drivers / washing volunteers): only their own tasks,
-- only the details needed to do them. No internal notes, no client records.
-- ---------------------------------------------------------------
create or replace function public.my_tasks(p_from timestamptz default null, p_to timestamptz default null, p_include_done boolean default false)
returns table (
  task_id uuid, order_id uuid, order_no bigint, task_type text, task_status text, order_status text,
  scheduled_at timestamptz, started_at timestamptz, completed_at timestamptz,
  from_address text, to_address text, expected_bags integer, actual_bags integer,
  contact_name text, contact_phone text, other_party_name text, other_party_phone text,
  client_label text, instructions text, bag_notes text, washing_received boolean, can_act boolean, open_problems integer)
language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := public.my_person_id();
begin
  if v_me is null then return; end if;
  return query
  select t.id, o.id, o.order_no, t.task_type, t.status, o.status,
    t.scheduled_at, t.started_at, t.completed_at,
    t.from_address, t.to_address,
    public._current_bags(o.id), t.actual_bags,
    case t.task_type when 'pickup' then o.pickup_contact when 'delivery' then o.return_recipient
      else (select p.full_name from order_tasks w join people p on p.id = w.assignee_id where w.order_id = o.id and w.task_type = 'washing') end,
    case t.task_type when 'pickup' then o.pickup_phone when 'delivery' then o.return_phone
      else (select p.phone from order_tasks w join people p on p.id = w.assignee_id where w.order_id = o.id and w.task_type = 'washing') end,
    case t.task_type when 'washing' then (select p.full_name from order_tasks d join people p on p.id = d.assignee_id where d.order_id = o.id and d.task_type = 'dropoff')
      when 'return_collection' then o.return_recipient else null end,
    case t.task_type when 'washing' then (select p.phone from order_tasks d join people p on p.id = d.assignee_id where d.order_id = o.id and d.task_type = 'dropoff')
      else null end,
    split_part(c.name, ' ', 1) || ' (K-' || o.order_no || ')',
    t.instructions, o.bag_notes,
    exists (select 1 from handoff_effective h where h.task_id = t.id and h.event_type = 'received_by_washer'),
    (o.status <> 'cancelled' and t.status in ('pending','in_progress')
      and not exists (select 1 from order_tasks e where e.order_id = o.id and e.seq < t.seq and e.status <> 'completed')),
    (select count(*)::int from order_exceptions x where x.task_id = t.id and x.status = 'open')
  from order_tasks t join orders o on o.id = t.order_id join clients c on c.id = o.client_id
  where t.assignee_id = v_me
    and (p_include_done or (t.status in ('pending','in_progress') and o.status <> 'cancelled'))
    and (p_from is null or coalesce(t.completed_at, t.scheduled_at) >= p_from)
    and (p_to is null or coalesce(t.completed_at, t.scheduled_at) < p_to)
  order by t.scheduled_at nulls last, o.order_no, t.seq;
end $$;

-- ---------------------------------------------------------------
-- Conflict warnings for the dispatcher
-- ---------------------------------------------------------------
create or replace function public.assignment_conflicts(p_person uuid, p_at timestamptz, p_exclude_task uuid default null, p_bags integer default null)
returns table (kind text, message text, task_id uuid, order_no bigint, scheduled_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare s organization_settings%rowtype := public._settings(); p people%rowtype; v_day date; v_bags int;
begin
  perform public._require_staff();
  select * into p from people where id = p_person;
  if not found or p_at is null then return; end if;
  v_day := (p_at at time zone s.time_zone)::date;

  if not p.active then
    return query select 'inactive'::text, p.full_name || ' is marked inactive.', null::uuid, null::bigint, null::timestamptz;
  end if;
  if p.unavailable_from is not null and v_day between p.unavailable_from and coalesce(p.unavailable_until, p.unavailable_from) then
    return query select 'unavailable'::text, format('%s is unavailable from %s to %s.', p.full_name, p.unavailable_from, coalesce(p.unavailable_until, p.unavailable_from)), null::uuid, null::bigint, null::timestamptz;
  end if;

  return query
  select 'overlap'::text,
    format('Also has %s for K-%s at %s.', public.task_type_label(t.task_type), o.order_no,
           to_char(t.scheduled_at at time zone s.time_zone, 'HH12:MI AM')),
    t.id, o.order_no, t.scheduled_at
  from order_tasks t join orders o on o.id = t.order_id
  where t.assignee_id = p_person and t.task_type <> 'washing'
    and t.id is distinct from p_exclude_task and t.status in ('pending','in_progress') and o.status <> 'cancelled'
    and abs(extract(epoch from (t.scheduled_at - p_at))) < s.min_minutes_between_tasks * 60
    and o.id is distinct from (select order_id from order_tasks where id = p_exclude_task);

  if p.max_bags_per_day is not null then
    select coalesce(sum(public._current_bags(o.id)), 0) into v_bags
    from order_tasks t join orders o on o.id = t.order_id
    where t.assignee_id = p_person and t.task_type = 'washing' and t.status <> 'completed' and o.status <> 'cancelled'
      and t.id is distinct from p_exclude_task
      and (t.scheduled_at at time zone s.time_zone)::date = v_day;
    if v_bags + coalesce(p_bags, 0) > p.max_bags_per_day then
      return query select 'capacity'::text,
        format('%s would have %s bag(s) that day; their limit is %s.', p.full_name, v_bags + coalesce(p_bags,0), p.max_bags_per_day),
        null::uuid, null::bigint, null::timestamptz;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------
-- Upcoming / overdue reminders (idempotent; called by the app on load)
-- ---------------------------------------------------------------
create or replace function public.refresh_due_notifications()
returns integer language plpgsql security definer set search_path = public as $$
declare s organization_settings%rowtype := public._settings(); r record; n int := 0; v_me uuid := public.my_person_id();
begin
  if not public.is_active_user() then return 0; end if;
  for r in
    select t.id, t.order_id, t.task_type, t.scheduled_at, t.assignee_id, o.order_no
    from order_tasks t join orders o on o.id = t.order_id
    where t.status in ('pending','in_progress') and o.status <> 'cancelled' and t.scheduled_at is not null
      and (t.assignee_id = v_me or public.is_staff())
      and t.scheduled_at < now() + make_interval(hours => s.upcoming_notice_hours)
      and t.scheduled_at > now() - interval '14 days'
  loop
    if r.scheduled_at < now() - make_interval(mins => s.overdue_grace_minutes) then
      if r.assignee_id = v_me then
        perform public._notify_user(auth.uid(), 'overdue', format('Overdue: %s — K-%s', public.task_type_label(r.task_type), r.order_no),
          null, r.order_id, r.id, 'overdue:' || r.id || ':' || r.scheduled_at);
      end if;
      if public.is_staff() then
        perform public._notify_user(auth.uid(), 'overdue', format('Overdue: %s — K-%s', public.task_type_label(r.task_type), r.order_no),
          case when r.assignee_id is null then 'No one is assigned.' end, r.order_id, r.id, 'overdue:' || r.id || ':' || r.scheduled_at);
      end if;
    elsif r.assignee_id = v_me and r.scheduled_at > now() then
      perform public._notify_user(auth.uid(), 'upcoming', format('Coming up: %s — K-%s', public.task_type_label(r.task_type), r.order_no),
        to_char(r.scheduled_at at time zone s.time_zone, 'Dy Mon DD, HH12:MI AM'), r.order_id, r.id, 'upcoming:' || r.id || ':' || r.scheduled_at);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
