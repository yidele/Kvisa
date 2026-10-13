-- Kvisa 004a: recurring schedules

create or replace function public._generate_for_schedule(rs recurring_schedules)
returns integer language plpgsql security definer set search_path = public as $$
declare
  s organization_settings%rowtype := public._settings();
  v_from date := greatest(rs.start_date, public._today());
  v_to date := public._today() + s.planning_window_days;
  d date; n int := 0;
begin
  if rs.status <> 'active' then return 0; end if;
  if rs.end_date is not null and rs.end_date < v_to then v_to := rs.end_date; end if;
  d := v_from;
  while d <= v_to loop
    if extract(dow from d)::smallint = any(rs.weekdays)
       and not exists (select 1 from orders where recurring_schedule_id = rs.id and occurrence_date = d) then
      begin
        perform public._wf('recurring.generated', null);
        perform public._create_order(jsonb_build_object(
          'client_id', rs.client_id,
          'expected_bags', rs.expected_bags,
          'pickup_at', public._local_ts(d, rs.pickup_time),
          'pickup_address', rs.pickup_address,
          'return_recipient', rs.return_recipient,
          'return_phone', rs.return_phone,
          'return_address', rs.return_address,
          'delivery_instructions', rs.delivery_instructions,
          'notes', rs.notes,
          'pickup_driver_id', rs.default_pickup_driver_id,
          'washer_id', rs.default_washer_id,
          'delivery_driver_id', rs.default_delivery_driver_id,
          'recurring_schedule_id', rs.id,
          'occurrence_date', d));
        n := n + 1;
      exception when unique_violation then
        null; -- another session generated it at the same moment; never duplicate
      end;
    end if;
    d := d + 1;
  end loop;
  update recurring_schedules set generated_through = greatest(coalesce(generated_through, v_to), v_to) where id = rs.id;
  return n;
end $$;

create or replace function public.generate_recurring_orders(p_schedule_id uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare r recurring_schedules%rowtype; n int := 0;
begin
  perform public._require_staff();
  for r in select * from recurring_schedules where status = 'active' and (p_schedule_id is null or id = p_schedule_id)
           for update skip locked loop
    n := n + public._generate_for_schedule(r);
  end loop;
  return n;
end $$;

-- Future, untouched occurrences of a series (safe to change with the series)
create or replace function public._future_occurrences(p_schedule uuid)
returns setof uuid language sql stable security definer set search_path = public as $$
  select o.id from orders o
  where o.recurring_schedule_id = p_schedule and not o.detached_from_series
    and o.occurrence_date >= public._today()
    and o.status in ('requested','scheduled')
    and not exists (select 1 from order_tasks t where t.order_id = o.id and t.status in ('in_progress','completed'))
$$;

create or replace function public.update_recurring_series(p_schedule_id uuid, p jsonb, p_apply_to_future boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rs recurring_schedules%rowtype; c clients%rowtype; v_id uuid; v_date date;
  v_cancelled int := 0; v_updated int := 0; v_generated int;
begin
  perform public._require_staff();
  perform public._wf('recurring.updated', p->>'reason');
  update recurring_schedules set
    weekdays = coalesce((select array_agg(x::smallint) from jsonb_array_elements_text(p->'weekdays') x), weekdays),
    pickup_time = coalesce(nullif(p->>'pickup_time','')::time, pickup_time),
    start_date = coalesce(nullif(p->>'start_date','')::date, start_date),
    end_date = case when p ? 'end_date' then nullif(p->>'end_date','')::date else end_date end,
    expected_bags = coalesce(nullif(p->>'expected_bags','')::int, expected_bags),
    pickup_address = case when p ? 'pickup_address' then nullif(p->>'pickup_address','') else pickup_address end,
    return_recipient = case when p ? 'return_recipient' then nullif(p->>'return_recipient','') else return_recipient end,
    return_phone = case when p ? 'return_phone' then nullif(p->>'return_phone','') else return_phone end,
    return_address = case when p ? 'return_address' then nullif(p->>'return_address','') else return_address end,
    delivery_instructions = case when p ? 'delivery_instructions' then nullif(p->>'delivery_instructions','') else delivery_instructions end,
    default_pickup_driver_id = case when p ? 'default_pickup_driver_id' then nullif(p->>'default_pickup_driver_id','')::uuid else default_pickup_driver_id end,
    default_washer_id = case when p ? 'default_washer_id' then nullif(p->>'default_washer_id','')::uuid else default_washer_id end,
    default_delivery_driver_id = case when p ? 'default_delivery_driver_id' then nullif(p->>'default_delivery_driver_id','')::uuid else default_delivery_driver_id end,
    notes = case when p ? 'notes' then nullif(p->>'notes','') else notes end
  where id = p_schedule_id returning * into rs;
  if not found then raise exception 'KVISA_NOT_FOUND: recurring schedule not found'; end if;

  if p_apply_to_future then
    -- Only future occurrences nobody has touched individually and that have not started.
    for v_id, v_date in select o.id, o.occurrence_date from orders o where o.id in (select * from public._future_occurrences(rs.id)) loop
      if not (extract(dow from v_date)::smallint = any(rs.weekdays))
         or v_date < rs.start_date or (rs.end_date is not null and v_date > rs.end_date) then
        perform public.cancel_order(v_id, 'No longer part of the recurring series');
        v_cancelled := v_cancelled + 1;
      else
        select * into c from clients where id = rs.client_id;
        perform public._wf('recurring.series_applied', p->>'reason');
        update orders set expected_bags = rs.expected_bags,
          pickup_address = coalesce(rs.pickup_address, c.pickup_address),
          return_recipient = coalesce(rs.return_recipient, c.default_return_recipient, return_recipient),
          return_phone = coalesce(rs.return_phone, c.default_return_phone, return_phone),
          return_address = coalesce(rs.return_address, c.default_return_address, return_address),
          delivery_instructions = coalesce(rs.delivery_instructions, c.access_instructions, delivery_instructions),
          notes = rs.notes
        where id = v_id;
        update order_tasks set scheduled_at = public._local_ts(v_date, rs.pickup_time),
          from_address = coalesce(rs.pickup_address, c.pickup_address), expected_bags = rs.expected_bags,
          assignee_id = coalesce(rs.default_pickup_driver_id, assignee_id)
          where order_id = v_id and task_type = 'pickup';
        update order_tasks set scheduled_at = public._local_ts(v_date, rs.pickup_time) + interval '1 hour',
          from_address = coalesce(rs.pickup_address, c.pickup_address), expected_bags = rs.expected_bags,
          assignee_id = coalesce(rs.default_pickup_driver_id, assignee_id)
          where order_id = v_id and task_type = 'dropoff';
        update order_tasks set expected_bags = rs.expected_bags, assignee_id = coalesce(rs.default_washer_id, assignee_id)
          where order_id = v_id and task_type = 'washing';
        update order_tasks set to_address = coalesce(rs.return_address, c.default_return_address, to_address)
          where order_id = v_id and task_type in ('return_collection','delivery');
        update order_tasks set assignee_id = coalesce(rs.default_delivery_driver_id, assignee_id)
          where order_id = v_id and task_type = 'delivery';
        perform public.recompute_order_status(v_id);
        v_updated := v_updated + 1;
      end if;
    end loop;
  end if;
  v_generated := public._generate_for_schedule(rs);
  return jsonb_build_object('updated', v_updated, 'cancelled', v_cancelled, 'generated', v_generated);
end $$;

create or replace function public.set_series_status(p_schedule_id uuid, p_status text, p_cancel_future boolean default true, p_reason text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare v_id uuid; n int := 0;
begin
  perform public._require_staff();
  if p_status not in ('active','paused','cancelled') then raise exception 'KVISA_VALIDATION: unknown status'; end if;
  perform public._wf('recurring.status_changed', p_reason);
  update recurring_schedules set status = p_status where id = p_schedule_id;
  if not found then raise exception 'KVISA_NOT_FOUND: recurring schedule not found'; end if;
  if p_status <> 'active' and p_cancel_future then
    for v_id in select * from public._future_occurrences(p_schedule_id) loop
      perform public.cancel_order(v_id, coalesce(nullif(trim(p_reason),''), 'Series ' || p_status));
      n := n + 1;
    end loop;
  elsif p_status = 'active' then
    perform public.generate_recurring_orders(p_schedule_id);
  end if;
  return n;
end $$;

create or replace function public.skip_occurrence(p_order_id uuid, p_reason text default 'Skipped occurrence')
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_staff();
  if not exists (select 1 from orders where id = p_order_id and recurring_schedule_id is not null) then
    raise exception 'KVISA_VALIDATION: this order is not part of a recurring schedule';
  end if;
  -- The cancelled order keeps its occurrence slot, so the date is never regenerated.
  perform public.cancel_order(p_order_id, coalesce(nullif(trim(p_reason),''), 'Skipped occurrence'));
end $$;

