-- Kvisa 004b: overview views, dashboard, reports

-- ---------------------------------------------------------------
-- Order overview (one row per order with derived location/next step)
-- ---------------------------------------------------------------
create or replace view public.order_overview with (security_invoker = true) as
select
  o.id, o.order_no, o.client_id, c.name as client_name, c.client_no, o.category_id, cat.label as category_label,
  o.status, o.expected_bags, o.expected_return_date, o.pickup_address, o.return_address, o.return_recipient,
  o.recurring_schedule_id, o.occurrence_date, o.cancel_reason, o.created_at, o.updated_at, o.completed_at,
  coalesce(lastcount.effective_bags, o.expected_bags) as current_bags,
  pk.scheduled_at as pickup_at, pk.assignee_id as pickup_driver_id, pkp.full_name as pickup_driver_name,
  w.assignee_id as washer_id, wp.full_name as washer_name,
  dl.assignee_id as delivery_driver_id, dlp.full_name as delivery_driver_name,
  nxt.id as next_task_id, nxt.task_type as next_task_type, nxt.scheduled_at as next_task_at,
  nxt.assignee_id as next_assignee_id, nxtp.full_name as next_assignee_name,
  case
    when o.status = 'cancelled' then 'Cancelled'
    when exists (select 1 from public.order_exceptions x where x.order_id = o.id and x.status = 'open' and x.kind = 'missing_bags') then 'Location needs verification'
    when lastev.event_type is null then 'At client pickup location'
    when lastev.event_type in ('collected_from_client') then 'With driver ' || coalesce((select full_name from public.people where id = lastev.to_person_id), '')
    when lastev.event_type = 'task_started' and lastev.task_type in ('pickup') then 'At client pickup location'
    when lastev.event_type = 'task_started' and lastev.task_type = 'dropoff' then 'With driver ' || coalesce((select full_name from public.people where id = lastev.from_person_id), '')
    when lastev.event_type in ('delivered_to_washer','received_by_washer') then 'At washer ' || coalesce(wp.full_name, '')
    when lastev.event_type = 'wash_started' then 'Washing in progress'
    when lastev.event_type = 'wash_completed' then 'Ready at washing location'
    when lastev.event_type = 'task_started' and lastev.task_type = 'return_collection' then 'Ready at washing location'
    when lastev.event_type in ('collected_from_washer') then 'With return driver ' || coalesce((select full_name from public.people where id = lastev.to_person_id), '')
    when lastev.event_type = 'task_started' and lastev.task_type = 'delivery' then 'With return driver ' || coalesce((select full_name from public.people where id = lastev.from_person_id), '')
    when lastev.event_type = 'delivered_to_recipient' then 'Delivered to recipient'
    else 'Location needs verification'
  end as current_location,
  (select count(*)::int from public.order_exceptions x where x.order_id = o.id and x.status = 'open') as open_exceptions,
  (o.status not in ('completed','cancelled') and exists (
     select 1 from public.order_tasks t where t.order_id = o.id and t.status in ('pending','in_progress')
       and t.scheduled_at < now() - make_interval(mins => (select overdue_grace_minutes from public.organization_settings where id = 1))
  )) as is_overdue,
  (o.status not in ('completed','cancelled') and exists (
     select 1 from public.order_tasks t where t.order_id = o.id and t.status in ('pending','in_progress') and t.assignee_id is null
  )) as has_unassigned
from public.orders o
join public.clients c on c.id = o.client_id
left join public.client_categories cat on cat.id = o.category_id
left join public.order_tasks pk on pk.order_id = o.id and pk.task_type = 'pickup'
left join public.people pkp on pkp.id = pk.assignee_id
left join public.order_tasks w on w.order_id = o.id and w.task_type = 'washing'
left join public.people wp on wp.id = w.assignee_id
left join public.order_tasks dl on dl.order_id = o.id and dl.task_type = 'delivery'
left join public.people dlp on dlp.id = dl.assignee_id
left join lateral (
  select t.* from public.order_tasks t where t.order_id = o.id and t.status in ('pending','in_progress') order by t.seq limit 1
) nxt on o.status not in ('cancelled')
left join public.people nxtp on nxtp.id = nxt.assignee_id
left join lateral (
  select h.event_type, h.from_person_id, h.to_person_id, t.task_type
  from public.handoff_effective h left join public.order_tasks t on t.id = h.task_id
  where h.order_id = o.id order by h.occurred_at desc, h.recorded_at desc limit 1
) lastev on true
left join lateral (
  select h.effective_bags from public.handoff_effective h
  where h.order_id = o.id and h.effective_bags is not null order by h.occurred_at desc, h.recorded_at desc limit 1
) lastcount on true;

-- Calendar feed: every stage of every order, with names
create or replace view public.task_calendar with (security_invoker = true) as
select t.id as task_id, t.order_id, o.order_no, t.task_type, t.seq, t.status as task_status, o.status as order_status,
  t.scheduled_at, t.original_scheduled_at, t.completed_at, t.assignee_id, p.full_name as assignee_name,
  t.from_address, t.to_address, t.expected_bags, t.actual_bags,
  o.client_id, c.name as client_name, o.category_id, o.recurring_schedule_id
from public.order_tasks t
join public.orders o on o.id = t.order_id
join public.clients c on c.id = o.client_id
left join public.people p on p.id = t.assignee_id;

-- ---------------------------------------------------------------
-- Dashboard
-- ---------------------------------------------------------------
create or replace function public.dashboard_summary(p_date date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s organization_settings%rowtype := public._settings();
  d date := coalesce(p_date, public._today());
  d0 timestamptz := public._local_ts(d, '00:00'); d1 timestamptz := public._local_ts(d + 1, '00:00');
  res jsonb;
begin
  perform public._require_staff();
  select jsonb_build_object(
    'date', d,
    'pickups_scheduled', (select count(*) from order_tasks t join orders o on o.id = t.order_id
        where t.task_type = 'pickup' and o.status <> 'cancelled' and t.scheduled_at >= d0 and t.scheduled_at < d1),
    'pickups_completed', (select count(*) from handoff_effective where event_type = 'collected_from_client' and occurred_at >= d0 and occurred_at < d1),
    'awaiting_washing', (select count(*) from orders where status in ('awaiting_dropoff','awaiting_washing')),
    'washing_in_progress', (select count(*) from orders where status = 'washing_in_progress'),
    'bags_ready_for_return', (select coalesce(sum(public._current_bags(id)),0) from orders where status = 'ready_for_return'),
    'orders_ready_for_return', (select count(*) from orders where status = 'ready_for_return'),
    'returns_scheduled', (select count(*) from order_tasks t join orders o on o.id = t.order_id
        where t.task_type = 'delivery' and o.status <> 'cancelled' and t.scheduled_at >= d0 and t.scheduled_at < d1),
    'overdue', (select count(*) from order_overview where is_overdue),
    'open_discrepancies', (select count(distinct order_id) from order_exceptions where status = 'open'),
    'washers_active', (select count(*) from people p join person_roles r on r.person_id = p.id and r.role = 'washer' and r.active where p.active),
    'washers_assigned', (select count(distinct t.assignee_id) from order_tasks t join orders o on o.id = t.order_id
        where t.task_type = 'washing' and t.status <> 'completed' and t.status <> 'cancelled' and o.status <> 'cancelled' and t.assignee_id is not null),
    'driver_tasks_outstanding', (select count(*) from order_tasks t join orders o on o.id = t.order_id
        where t.task_type <> 'washing' and t.status in ('pending','in_progress') and o.status <> 'cancelled'
          and t.scheduled_at < d1),
    'unassigned_tasks', (select count(*) from order_tasks t join orders o on o.id = t.order_id
        where t.status in ('pending','in_progress') and o.status <> 'cancelled' and t.assignee_id is null and t.scheduled_at < d1 + interval '7 days')
  ) into res;
  return res;
end $$;

-- ---------------------------------------------------------------
-- Reports (definitions documented in docs/REPORTS.md)
-- ---------------------------------------------------------------
create or replace function public.report_summary(p_from date, p_to date, p_category text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  t0 timestamptz := public._local_ts(p_from, '00:00');
  t1 timestamptz := public._local_ts(p_to + 1, '00:00');
  res jsonb;
begin
  perform public._require_staff();
  if p_from is null or p_to is null or p_to < p_from then raise exception 'KVISA_VALIDATION: choose a valid date range'; end if;

  with o as (select * from orders where p_category is null or category_id = p_category),
  ev as (select h.*, o.category_id from handoff_effective h join o on o.id = h.order_id
         where h.occurred_at >= t0 and h.occurred_at < t1),
  totals as (
    select
      (select count(*) from o where created_at >= t0 and created_at < t1) as orders_created,
      (select count(*) from o where completed_at >= t0 and completed_at < t1 and status = 'completed') as orders_completed,
      (select count(*) from o where cancelled_at >= t0 and cancelled_at < t1) as orders_cancelled,
      (select coalesce(sum(effective_bags),0) from ev where event_type = 'collected_from_client') as bags_collected,
      (select coalesce(sum(effective_bags),0) from ev where event_type = 'wash_completed') as bags_washed,
      (select coalesce(sum(effective_bags),0) from ev where event_type = 'delivered_to_recipient') as bags_delivered,
      (select count(*) from o where status not in ('completed','cancelled') and created_at < t1) as outstanding_orders,
      (select count(*) from order_overview v join o on o.id = v.id where v.is_overdue) as overdue_orders_now,
      (select round(avg(extract(epoch from (d.occurred_at - c.occurred_at)) / 3600.0)::numeric, 1)
         from ev d join handoff_effective c on c.order_id = d.order_id and c.event_type = 'collected_from_client'
         where d.event_type = 'delivered_to_recipient') as avg_turnaround_hours
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'category', p_category,
    'time_zone', (select time_zone from organization_settings where id = 1),
    'totals', (select to_jsonb(totals) from totals),
    'by_category', coalesce((select jsonb_agg(x order by x->>'category') from (
        select jsonb_build_object('category', cat.label,
          'orders_created', (select count(*) from o where o.category_id = cat.id and created_at >= t0 and created_at < t1),
          'orders_completed', (select count(*) from o where o.category_id = cat.id and status = 'completed' and completed_at >= t0 and completed_at < t1),
          'bags_collected', (select coalesce(sum(effective_bags),0) from ev where ev.category_id = cat.id and event_type = 'collected_from_client'),
          'bags_washed', (select coalesce(sum(effective_bags),0) from ev where ev.category_id = cat.id and event_type = 'wash_completed'),
          'bags_delivered', (select coalesce(sum(effective_bags),0) from ev where ev.category_id = cat.id and event_type = 'delivered_to_recipient')) x
        from client_categories cat where p_category is null or cat.id = p_category) q), '[]'::jsonb),
    'washers', coalesce((select jsonb_agg(x order by x->>'name') from (
        select jsonb_build_object('name', p.full_name,
          'washes_completed', count(ev.id),
          'bags_washed', coalesce(sum(ev.effective_bags),0),
          'assigned_open', (select count(*) from order_tasks t join o on o.id = t.order_id where t.assignee_id = p.id and t.task_type = 'washing' and t.status in ('pending','in_progress') and o.status <> 'cancelled')) x
        from people p join person_roles r on r.person_id = p.id and r.role = 'washer'
        left join ev on ev.from_person_id = p.id and ev.event_type = 'wash_completed'
        group by p.id, p.full_name) q), '[]'::jsonb),
    'drivers', coalesce((select jsonb_agg(x order by x->>'name') from (
        select jsonb_build_object('name', p.full_name,
          'pickups', count(*) filter (where ev.event_type = 'collected_from_client'),
          'dropoffs', count(*) filter (where ev.event_type = 'delivered_to_washer'),
          'return_collections', count(*) filter (where ev.event_type = 'collected_from_washer'),
          'deliveries', count(*) filter (where ev.event_type = 'delivered_to_recipient'),
          'bags_handled', coalesce(sum(ev.effective_bags) filter (where ev.event_type in ('collected_from_client','collected_from_washer')),0)) x
        from people p join person_roles r on r.person_id = p.id and r.role = 'driver'
        left join ev on (ev.event_type in ('collected_from_client','collected_from_washer') and ev.to_person_id = p.id)
                     or (ev.event_type in ('delivered_to_washer','delivered_to_recipient') and ev.from_person_id = p.id)
        group by p.id, p.full_name) q), '[]'::jsonb),
    'exceptions', coalesce((select jsonb_agg(x order by x->>'reported_at' desc) from (
        select jsonb_build_object('order_no', oo.order_no, 'kind', ex.kind, 'status', ex.status, 'description', ex.description,
          'expected', ex.expected_bags, 'actual', ex.actual_bags, 'reported_at', ex.reported_at, 'resolution', ex.resolution) x
        from order_exceptions ex join o oo on oo.id = ex.order_id
        where (ex.reported_at >= t0 and ex.reported_at < t1) or ex.status = 'open') q), '[]'::jsonb),
    'recurring', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('client', c.name, 'status', rs.status,
          'occurrences', count(oo.id), 'completed', count(oo.id) filter (where oo.status = 'completed'),
          'cancelled_or_skipped', count(oo.id) filter (where oo.status = 'cancelled'),
          'open', count(oo.id) filter (where oo.status not in ('completed','cancelled'))) x
        from recurring_schedules rs join clients c on c.id = rs.client_id
        left join o oo on oo.recurring_schedule_id = rs.id and oo.occurrence_date between p_from and p_to
        where p_category is null or c.category_id = p_category
        group by rs.id, c.name, rs.status) q), '[]'::jsonb)
  ) into res;
  return res;
end $$;

