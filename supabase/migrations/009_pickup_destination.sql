-- Kvisa 009: when the washer is assigned or changed, the pickup leg's destination follows too
-- (needed so the pickup can be offered street-to-street).

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
        where order_id = new.order_id and task_type in ('pickup','dropoff') and status <> 'completed'
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
revoke execute on function public.track_assignment() from public, anon, authenticated;
