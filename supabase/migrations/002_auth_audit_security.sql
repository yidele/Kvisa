-- Kvisa 002: roles, sign-up gate, audit trail, guards and row-level security

-- ---------------------------------------------------------------
-- Role helpers (security definer so policies can call them without recursion)
-- ---------------------------------------------------------------
create or replace function public.has_role(p_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_roles ur join profiles p on p.id = ur.user_id
    where ur.user_id = auth.uid() and ur.role = p_role and p.active
  );
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$ select public.has_role('admin') $$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('admin') or public.has_role('dispatcher')
$$;

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active)
$$;

create or replace function public.my_person_id() returns uuid
language sql stable security definer set search_path = public as $$
  select person_id from profiles where id = auth.uid() and active
$$;

-- ---------------------------------------------------------------
-- Sign-up gate: first user becomes admin; everyone else must be invited.
-- ---------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(new.email);
  v_inv invites%rowtype;
  v_role text;
begin
  if not exists (select 1 from profiles) then
    insert into profiles (id, email, full_name)
      values (new.id, v_email, coalesce(new.raw_user_meta_data->>'full_name', v_email));
    insert into user_roles (user_id, role) values (new.id, 'admin');
    return new;
  end if;

  select * into v_inv from invites where email = v_email and used_at is null;
  if not found then
    raise exception 'KVISA_NOT_INVITED: % has not been invited to Kvisa', v_email
      using errcode = 'P0001';
  end if;

  insert into profiles (id, email, full_name, person_id)
    values (new.id, v_email,
            coalesce(v_inv.full_name, new.raw_user_meta_data->>'full_name', v_email),
            v_inv.person_id);
  foreach v_role in array v_inv.roles loop
    insert into user_roles (user_id, role, granted_by) values (new.id, v_role, v_inv.invited_by);
  end loop;
  update invites set used_at = now() where email = v_email;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger t_upd before update on public.clients for each row execute function public.set_updated_at();
create trigger t_upd before update on public.people for each row execute function public.set_updated_at();
create trigger t_upd before update on public.recurring_schedules for each row execute function public.set_updated_at();
create trigger t_upd before update on public.order_tasks for each row execute function public.set_updated_at();
create trigger t_upd before update on public.organization_settings for each row execute function public.set_updated_at();
create trigger t_upd before update on public.client_internal_notes for each row execute function public.set_updated_at();

create or replace function public.orders_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;
create trigger t_upd before update on public.orders for each row execute function public.orders_touch();

-- ---------------------------------------------------------------
-- Audit trail
-- Functions can set kvisa.action / kvisa.reason (transaction-local) to label entries.
-- ---------------------------------------------------------------
create or replace function public.audit_row()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_old_d jsonb := '{}'; v_new_d jsonb := '{}';
  k text;
  v_action text := nullif(current_setting('kvisa.action', true), '');
  v_reason text := nullif(current_setting('kvisa.reason', true), '');
  v_order uuid; v_client uuid;
  v_ignore text[] := array['updated_at','updated_by'];
begin
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      if not (k = any(v_ignore)) and (v_old->k) is distinct from (v_new->k) then
        v_old_d := v_old_d || jsonb_build_object(k, v_old->k);
        v_new_d := v_new_d || jsonb_build_object(k, v_new->k);
      end if;
    end loop;
    if v_new_d = '{}'::jsonb then return new; end if;
  else
    v_old_d := v_old; v_new_d := v_new;
  end if;

  if tg_table_name = 'orders' then v_order := (v_row->>'id')::uuid; v_client := (v_row->>'client_id')::uuid;
  elsif v_row ? 'order_id' then v_order := (v_row->>'order_id')::uuid;
  end if;
  if tg_table_name = 'clients' then v_client := (v_row->>'id')::uuid;
  elsif v_row ? 'client_id' then v_client := (v_row->>'client_id')::uuid;
  end if;
  if v_order is null and tg_table_name = 'task_assignments' then
    select order_id into v_order from order_tasks where id = (v_row->>'task_id')::uuid;
  end if;
  if v_client is null and v_order is not null then
    select client_id into v_client from orders where id = v_order;
  end if;

  if v_action is null then
    v_action := case
      when tg_table_name = 'orders' and tg_op = 'INSERT' then 'order.created'
      when tg_table_name = 'orders' and v_new_d ? 'cancelled_at' and v_row->>'status' = 'cancelled' then 'order.cancelled'
      when tg_table_name = 'orders' and v_new_d ? 'status' then 'order.status_changed'
      when tg_table_name = 'orders' and v_new_d ? 'expected_bags' then 'order.bag_count_changed'
      when tg_table_name = 'orders' and (v_new_d ?| array['pickup_address','return_address']) then 'order.address_changed'
      when tg_table_name = 'orders' then 'order.edited'
      when tg_table_name = 'order_tasks' and tg_op = 'INSERT' then 'task.created'
      when tg_table_name = 'order_tasks' and v_new_d ? 'assignee_id' then
        case when v_old->>'assignee_id' is null then 'task.assigned' else 'task.reassigned' end
      when tg_table_name = 'order_tasks' and v_new_d ? 'scheduled_at' then 'task.rescheduled'
      when tg_table_name = 'order_tasks' and v_new_d ? 'status' then 'task.status_changed'
      when tg_table_name = 'order_tasks' and (v_new_d ?| array['from_address','to_address']) then 'task.address_changed'
      when tg_table_name = 'order_tasks' and (v_new_d ?| array['expected_bags','actual_bags']) then 'task.bag_count_changed'
      when tg_table_name = 'order_tasks' then 'task.edited'
      when tg_table_name = 'handoff_events' then 'handoff.' || (v_row->>'event_type')
      when tg_table_name = 'order_exceptions' and tg_op = 'INSERT' then 'exception.reported'
      when tg_table_name = 'order_exceptions' and v_row->>'status' = 'resolved' then 'exception.resolved'
      when tg_table_name = 'recurring_schedules' then 'recurring.' || lower(tg_op)
      else replace(tg_table_name, '_', '.') || '.' || lower(tg_op)
    end;
  end if;

  -- Restricted notes: record that they changed, not their content.
  if tg_table_name = 'client_internal_notes' then
    v_old_d := null; v_new_d := jsonb_build_object('notes', 'changed');
  end if;

  insert into audit_logs (actor_id, actor_email, action, entity, entity_id, order_id, client_id, old_value, new_value, reason)
  values (auth.uid(), (select email from profiles where id = auth.uid()), v_action, tg_table_name,
          v_row->>coalesce(case when v_row ? 'id' then 'id' end, case when v_row ? 'user_id' then 'user_id' end, case when v_row ? 'email' then 'email' end, 'client_id'),
          v_order, v_client,
          case when tg_op = 'INSERT' then null else v_old_d end,
          case when tg_op = 'DELETE' then null else v_new_d end,
          v_reason);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['clients','client_addresses','client_internal_notes','people','person_roles',
    'recurring_schedules','orders','order_tasks','handoff_events','order_exceptions',
    'user_roles','invites','organization_settings','client_categories','profiles']
  loop
    execute format('create trigger t_audit after insert or update or delete on public.%I
                    for each row execute function public.audit_row()', t);
  end loop;
end $$;

-- Append-only enforcement (applies to everyone, including service accounts).
create or replace function public.forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'KVISA_APPEND_ONLY: % records cannot be changed or deleted', tg_table_name;
end $$;
create trigger t_append_only before update or delete on public.audit_logs
  for each row execute function public.forbid_change();
create trigger t_append_only before update or delete on public.handoff_events
  for each row execute function public.forbid_change();
create trigger t_append_only before update or delete on public.task_assignments
  for each row when (old.ended_at is not null) execute function public.forbid_change();

-- No hard deletes of operational records (deactivate/cancel instead).
create trigger t_no_delete before delete on public.orders for each row execute function public.forbid_change();
create trigger t_no_delete before delete on public.order_tasks for each row execute function public.forbid_change();
create trigger t_no_delete before delete on public.order_exceptions for each row execute function public.forbid_change();

-- ---------------------------------------------------------------
-- Guards: workflow fields may only change through the workflow functions.
-- ---------------------------------------------------------------
create or replace function public.in_workflow() returns boolean language sql stable as $$
  select coalesce(current_setting('kvisa.rpc', true), '') = 'on'
$$;

create or replace function public.guard_task_update() returns trigger language plpgsql as $$
begin
  if new.order_id <> old.order_id or new.task_type <> old.task_type or new.seq <> old.seq then
    raise exception 'KVISA_FORBIDDEN: a task cannot be moved to another order or stage';
  end if;
  if old.scheduled_at is null and new.scheduled_at is not null and new.original_scheduled_at is null then
    new.original_scheduled_at := new.scheduled_at;
  end if;
  if public.in_workflow() then return new; end if;

  if new.status is distinct from old.status or new.started_at is distinct from old.started_at
     or new.completed_at is distinct from old.completed_at or new.actual_bags is distinct from old.actual_bags then
    raise exception 'KVISA_USE_WORKFLOW: record a handoff or correction to change task progress or actual bag counts';
  end if;
  if old.status = 'completed' and (
       new.assignee_id is distinct from old.assignee_id or new.scheduled_at is distinct from old.scheduled_at
       or new.from_address is distinct from old.from_address or new.to_address is distinct from old.to_address
       or new.expected_bags is distinct from old.expected_bags) then
    raise exception 'KVISA_COMPLETED_STAGE: this stage is already completed. Reopen it with a correction first';
  end if;
  return new;
end $$;
create trigger t_guard before update on public.order_tasks for each row execute function public.guard_task_update();

create or replace function public.guard_order_update() returns trigger language plpgsql as $$
begin
  if public.in_workflow() then return new; end if;
  if new.status is distinct from old.status or new.completed_at is distinct from old.completed_at
     or new.cancelled_at is distinct from old.cancelled_at or new.cancel_reason is distinct from old.cancel_reason
     or new.recurring_schedule_id is distinct from old.recurring_schedule_id
     or new.occurrence_date is distinct from old.occurrence_date then
    raise exception 'KVISA_USE_WORKFLOW: status, cancellation and series links change only through workflow actions';
  end if;
  return new;
end $$;
create trigger t_guard before update on public.orders for each row execute function public.guard_order_update();

-- ---------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['organization_settings','client_categories','people','person_roles','profiles',
    'user_roles','invites','clients','client_internal_notes','client_addresses','recurring_schedules',
    'orders','order_tasks','task_assignments','handoff_events','order_exceptions','audit_logs',
    'notifications','notification_outbox']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- settings & categories: everyone signed in can read; only admins change
create policy settings_read on public.organization_settings for select to authenticated using (public.is_active_user());
create policy settings_admin on public.organization_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy cat_read on public.client_categories for select to authenticated using (public.is_active_user());
create policy cat_admin_ins on public.client_categories for insert to authenticated with check (public.is_admin());
create policy cat_admin_upd on public.client_categories for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- people
create policy people_staff_read on public.people for select to authenticated using (public.is_staff() or id = public.my_person_id());
create policy people_staff_ins on public.people for insert to authenticated with check (public.is_staff());
create policy people_staff_upd on public.people for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy proles_read on public.person_roles for select to authenticated using (public.is_staff() or person_id = public.my_person_id());
create policy proles_ins on public.person_roles for insert to authenticated with check (public.is_staff());
create policy proles_upd on public.person_roles for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- users
create policy profiles_read on public.profiles for select to authenticated using (id = auth.uid() or public.is_staff());
create policy profiles_admin_upd on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy uroles_read on public.user_roles for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy invites_admin on public.invites for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- clients (staff only; field users never read client records directly)
create policy clients_read on public.clients for select to authenticated using (public.is_staff());
create policy clients_ins on public.clients for insert to authenticated with check (public.is_staff());
create policy clients_upd on public.clients for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy cnotes_all on public.client_internal_notes for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy caddr_read on public.client_addresses for select to authenticated using (public.is_staff());
create policy caddr_ins on public.client_addresses for insert to authenticated with check (public.is_staff());
create policy caddr_upd on public.client_addresses for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- scheduling & orders (staff). Inserts of orders/tasks go through create_order().
create policy rs_read on public.recurring_schedules for select to authenticated using (public.is_staff());
create policy rs_ins on public.recurring_schedules for insert to authenticated with check (public.is_staff());
create policy rs_upd on public.recurring_schedules for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy orders_read on public.orders for select to authenticated using (public.is_staff());
create policy orders_upd on public.orders for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy tasks_read on public.order_tasks for select to authenticated using (public.is_staff());
create policy tasks_upd on public.order_tasks for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy ta_read on public.task_assignments for select to authenticated using (public.is_staff());
create policy he_read on public.handoff_events for select to authenticated using (public.is_staff());
create policy ex_read on public.order_exceptions for select to authenticated using (public.is_staff());
create policy audit_read on public.audit_logs for select to authenticated using (public.is_staff());

-- notifications: own only; may only mark as read
create policy notif_read on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notif_mark on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;
create policy outbox_admin on public.notification_outbox for select to authenticated using (public.is_admin());

-- Column-level hardening for staff edits: workflow-only columns are also guarded by triggers.
revoke insert, delete on public.orders, public.order_tasks, public.handoff_events,
  public.order_exceptions, public.audit_logs, public.task_assignments from authenticated;
revoke update on public.handoff_events, public.audit_logs, public.task_assignments, public.order_exceptions from authenticated;
revoke delete on public.clients, public.client_addresses, public.people, public.person_roles,
  public.recurring_schedules, public.client_categories, public.organization_settings, public.profiles,
  public.user_roles from authenticated;
revoke insert, update on public.user_roles, public.profiles from authenticated;
grant update (full_name, active, person_id) on public.profiles to authenticated;
