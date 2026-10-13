-- Kvisa 010: offer fixes
-- * Offers get a precise creation time so "latest offer" is unambiguous.
-- * Automatic return dispatch runs when the washing stage is marked completed
--   (after the stage update, not when the event row is written).

alter table public.task_offers alter column created_at set default clock_timestamp();

-- The earlier event-row trigger fired too early; it is switched off (kept for history).
alter table public.handoff_events disable trigger t_auto_dispatch_return;

create or replace function public.auto_dispatch_return_on_wash() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_task uuid; v_offer uuid; v_mins int;
begin
  if new.task_type = 'washing' and new.status = 'completed' and old.status is distinct from 'completed'
     and (select auto_dispatch_return from organization_settings where id = 1) then
    select id into v_task from order_tasks where order_id = new.order_id and task_type = 'return_collection'
      and assignee_id is null and status = 'pending';
    if v_task is not null and not exists (select 1 from task_offers where task_id = v_task and status = 'available')
       and public._dispatch_block_reason(v_task) is null then
      begin
        select default_offer_minutes into v_mins from organization_settings where id = 1;
        insert into task_offers (order_id, task_id, open_to_all, note, expires_at, created_by)
          values (new.order_id, v_task, true, 'Automatic return dispatch',
            case when v_mins is null then null else now() + make_interval(mins => v_mins) end, null)
          returning id into v_offer;
        insert into offer_recipients (offer_id, order_id, person_id)
          select v_offer, new.order_id, pp.id
          from people pp join person_roles r on r.person_id = pp.id and r.role = 'driver' and r.active where pp.active;
      exception when others then null;  -- never block the washer's handoff
      end;
    end if;
  end if;
  return new;
end $$;
create trigger t_auto_dispatch_return_on_wash after update of status on public.order_tasks
  for each row execute function public.auto_dispatch_return_on_wash();
revoke execute on function public.auto_dispatch_return_on_wash() from public, anon, authenticated;
