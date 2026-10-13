-- Kvisa 007: honour the "require discrepancy resolution" setting when deciding completion.
-- Failed pickups and missing bags always block completion; other open exceptions block it
-- unless they are bag-count discrepancies and the administrator turned that rule off.

create or replace function public.recompute_order_status(p_order uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype;
  t record;
  v_status text;
  v_open int; v_blocking int;
  v_delivered boolean;
  v_require boolean;
  v_prev_rpc text; v_prev_action text;
begin
  select * into o from orders where id = p_order for update;
  if o.status = 'cancelled' then return 'cancelled'; end if;
  select require_discrepancy_resolution into v_require from organization_settings where id = 1;

  select count(*) filter (where v_require or kind <> 'bag_discrepancy'),
         count(*) filter (where kind in ('failed_pickup','missing_bags'))
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
revoke execute on function public.recompute_order_status(uuid) from public, anon, authenticated;
