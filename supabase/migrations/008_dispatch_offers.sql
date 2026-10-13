-- Kvisa 008: driver job offers ("Dispatch Call") with address privacy.
-- Drivers never get table access. Before accepting they only receive street names
-- (my_offers); exact addresses come only from my_tasks, which returns tasks currently
-- assigned to them. Reassignment therefore revokes access immediately.

alter table public.organization_settings
  add column auto_dispatch_return boolean not null default false,
  add column default_offer_minutes integer check (default_offer_minutes is null or default_offer_minutes between 5 and 10080);
update public.organization_settings
  set notify_kinds = array_append(notify_kinds, 'offer') where not ('offer' = any(notify_kinds));
alter table public.organization_settings alter column notify_kinds set default array[
  'assigned','reassigned','schedule_changed','upcoming','overdue',
  'washing_completed','return_ready','delivered','exception','offer'];

-- ---------------------------------------------------------------
-- Street-only form of an address: no house number, apartment, unit or city.
-- ---------------------------------------------------------------
create or replace function public.street_only(p_addr text)
returns text language plpgsql immutable set search_path = public as $$
declare s text := coalesce(p_addr, '');
begin
  s := split_part(s, ',', 1);                                                     -- drop city / state / zip
  s := regexp_replace(s, '\s*#.*$', '');                                          -- "#4B"
  s := regexp_replace(s, '\s+(apt|apartment|unit|suite|ste|fl|floor|rm|room|bldg)\M\.?.*$', '', 'i');
  s := regexp_replace(s, '^\s*(no\.?\s*)?[0-9]+[a-z]?([-/][0-9]+[a-z]?)?\s+', '', 'i'); -- house number
  s := regexp_replace(s, '^\s*[0-9]+[a-z]?\s*$', '', 'i');                         -- number only
  s := btrim(s);
  return case when s = '' then 'Address on file' else s end;
end $$;

-- ---------------------------------------------------------------
-- Offers
-- ---------------------------------------------------------------
create table public.task_offers (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  task_id uuid not null references public.order_tasks(id) on delete restrict,
  status text not null default 'available' check (status in ('available','accepted','declined','expired','cancelled')),
  open_to_all boolean not null default true,
  note text,
  expires_at timestamptz,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  accepted_person_id uuid references public.people(id),
  accepted_at timestamptz,
  closed_at timestamptz,
  close_reason text
);
-- At most one open offer per stage: this is what makes acceptance first-come-first-served.
create unique index task_offers_one_open on public.task_offers (task_id) where status = 'available';
create index task_offers_task_idx on public.task_offers (task_id, created_at desc);

create table public.offer_recipients (
  offer_id uuid not null references public.task_offers(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  person_id uuid not null references public.people(id) on delete restrict,
  response text not null default 'pending' check (response in ('pending','accepted','declined','withdrawn','expired')),
  responded_at timestamptz,
  primary key (offer_id, person_id)
);
create index offer_recipients_person_idx on public.offer_recipients (person_id, response);

alter table public.task_offers enable row level security;
alter table public.offer_recipients enable row level security;
revoke all on public.task_offers, public.offer_recipients from anon;
revoke insert, update, delete on public.task_offers, public.offer_recipients from authenticated;
create policy offers_staff_read on public.task_offers for select to authenticated using (public.is_staff());
create policy recipients_staff_read on public.offer_recipients for select to authenticated using (public.is_staff());

create trigger t_audit after insert or update on public.task_offers for each row execute function public.audit_row();
create trigger t_audit after insert or update on public.offer_recipients for each row execute function public.audit_row();

-- Close offers whose time ran out (called lazily by the offer functions).
create or replace function public._expire_offers()
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from task_offers where status = 'available' and expires_at is not null and expires_at < now() for update skip locked loop
    perform public._wf('offer.expired', null);
    update task_offers set status = 'expired', closed_at = now(), close_reason = 'Time ran out' where id = r.id;
    update offer_recipients set response = 'expired', responded_at = now() where offer_id = r.id and response = 'pending';
  end loop;
end $$;

-- Is this stage ready to be offered to drivers?
create or replace function public._dispatch_block_reason(p_task uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare t order_tasks%rowtype; o orders%rowtype; v_washer uuid; v_washed boolean;
begin
  select * into t from order_tasks where id = p_task;
  if not found then return 'Stage not found'; end if;
  select * into o from orders where id = t.order_id;
  if o.status = 'cancelled' then return 'The order is cancelled'; end if;
  if t.task_type = 'washing' then return 'Washing is not a driver job'; end if;
  if t.status <> 'pending' then return 'This stage has already started'; end if;
  select assignee_id into v_washer from order_tasks where order_id = t.order_id and task_type = 'washing';
  select status = 'completed' into v_washed from order_tasks where order_id = t.order_id and task_type = 'washing';
  if t.task_type in ('pickup','dropoff') and v_washer is null then return 'Assign a washing volunteer first'; end if;
  if t.task_type in ('pickup','dropoff') and (coalesce(trim(t.from_address),'') = '' or coalesce(trim(t.to_address),'') = '') then
    return 'Pickup and drop-off addresses are needed first';
  end if;
  if t.task_type in ('return_collection','delivery') and not v_washed then return 'Washing is not completed yet'; end if;
  if t.task_type in ('return_collection','delivery') and coalesce(trim(t.to_address),'') = '' then return 'The return address is missing'; end if;
  return null;
end $$;

-- Staff: what drivers will see, before sending
create or replace function public.dispatch_preview(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t order_tasks%rowtype;
begin
  perform public._require_staff();
  select * into t from order_tasks where id = p_task_id;
  return jsonb_build_object('from_street', public.street_only(t.from_address), 'to_street', public.street_only(t.to_address),
    'blocked', public._dispatch_block_reason(p_task_id), 'assignee_id', t.assignee_id);
end $$;

-- ---------------------------------------------------------------
-- Dispatch a stage as a job offer
-- ---------------------------------------------------------------
create or replace function public.dispatch_task(p_task_id uuid, p_person_ids uuid[] default null,
  p_expires_minutes integer default null, p_note text default null, p_replace_assignee boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t order_tasks%rowtype; o orders%rowtype; v_block text; v_id uuid; v_n int; p record;
  v_mins int := coalesce(p_expires_minutes, (select default_offer_minutes from organization_settings where id = 1));
  v_label text; v_route text;
begin
  perform public._require_staff();
  perform public._expire_offers();
  select * into t from order_tasks where id = p_task_id for update;
  if not found then raise exception 'KVISA_NOT_FOUND: stage not found'; end if;
  v_block := public._dispatch_block_reason(p_task_id);
  if v_block is not null then raise exception 'KVISA_VALIDATION: %', v_block; end if;
  if v_mins is not null and (v_mins < 5 or v_mins > 10080) then raise exception 'KVISA_VALIDATION: the offer time must be between 5 minutes and 7 days'; end if;
  select * into o from orders where id = t.order_id;

  if t.assignee_id is not null then
    if not p_replace_assignee then
      raise exception 'KVISA_VALIDATION: % is already assigned to this stage. Choose "replace" to offer it to other drivers.',
        (select full_name from people where id = t.assignee_id);
    end if;
    perform public._wf('task.reassigned', 'Released for dispatch');
    update order_tasks set assignee_id = null where id = t.id;
  end if;

  -- Resend: close any open offer for this stage first
  perform public._wf('offer.cancelled', 'Replaced by a new dispatch');
  update offer_recipients set response = 'withdrawn', responded_at = now()
    where response = 'pending' and offer_id in (select id from task_offers where task_id = t.id and status = 'available');
  update task_offers set status = 'cancelled', closed_at = now(), close_reason = 'Replaced by a new dispatch'
    where task_id = t.id and status = 'available';

  perform public._wf('offer.dispatched', p_note);
  insert into task_offers (order_id, task_id, open_to_all, note, expires_at)
    values (t.order_id, t.id, p_person_ids is null, nullif(trim(p_note), ''),
            case when v_mins is null then null else now() + make_interval(mins => v_mins) end)
    returning id into v_id;

  insert into offer_recipients (offer_id, order_id, person_id)
  select v_id, t.order_id, pp.id from people pp join person_roles r on r.person_id = pp.id and r.role = 'driver' and r.active
  where pp.active
    and (p_person_ids is null or pp.id = any(p_person_ids))
    and not (pp.unavailable_from is not null and (now() at time zone (select time_zone from organization_settings where id=1))::date
             between pp.unavailable_from and coalesce(pp.unavailable_until, pp.unavailable_from));
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'KVISA_VALIDATION: no active, available drivers to offer this to'; end if;

  v_label := public.task_type_label(t.task_type);
  v_route := public.street_only(t.from_address) || ' → ' || public.street_only(t.to_address);
  for p in select person_id from offer_recipients where offer_id = v_id loop
    perform public._notify_person(p.person_id, 'offer', format('Job available: %s (K-%s)', v_label, o.order_no),
      v_route || coalesce(' · ' || to_char(t.scheduled_at at time zone (select time_zone from organization_settings where id=1), 'Dy Mon DD, HH12:MI AM'), ''),
      null, null, 'offer:' || v_id);
  end loop;
  return v_id;
end $$;

create or replace function public.cancel_offer(p_offer_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_found boolean;
begin
  perform public._require_staff();
  perform public._wf('offer.cancelled', p_reason);
  update task_offers set status = 'cancelled', closed_at = now(), close_reason = coalesce(nullif(trim(p_reason),''), 'Cancelled by dispatcher')
    where id = p_offer_id and status = 'available' returning true into v_found;
  if not coalesce(v_found, false) then raise exception 'KVISA_VALIDATION: this offer is no longer open'; end if;
  update offer_recipients set response = 'withdrawn', responded_at = now() where offer_id = p_offer_id and response = 'pending';
end $$;

-- ---------------------------------------------------------------
-- Driver side
-- ---------------------------------------------------------------
-- Open offers for me. Street names only — never house numbers, apartments, contacts or instructions.
create or replace function public.my_offers()
returns table (offer_id uuid, order_no bigint, task_type text, from_street text, to_street text,
  expected_bags integer, scheduled_at timestamptz, note text, expires_at timestamptz, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_me uuid := public.my_person_id();
begin
  if v_me is null then return; end if;
  perform public._expire_offers();
  return query
  select f.id, o.order_no, t.task_type, public.street_only(t.from_address), public.street_only(t.to_address),
    public._current_bags(o.id), t.scheduled_at, f.note, f.expires_at, f.created_at
  from offer_recipients r
  join task_offers f on f.id = r.offer_id and f.status = 'available'
  join order_tasks t on t.id = f.task_id
  join orders o on o.id = f.order_id
  where r.person_id = v_me and r.response = 'pending' and o.status <> 'cancelled'
  order by t.scheduled_at nulls last;
end $$;

-- Accept or decline. The row lock + status check + unique open-offer index make
-- acceptance atomic: only the first driver to commit gets the job.
create or replace function public.respond_offer(p_offer_id uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_me uuid := public.my_person_id(); f task_offers%rowtype; v_no bigint; v_name text; v_task text; v_left int;
begin
  if v_me is null then raise exception 'KVISA_FORBIDDEN: only drivers can respond to job offers' using errcode = '42501'; end if;
  perform public._expire_offers();
  select * into f from task_offers where id = p_offer_id for update;
  if not found or not exists (select 1 from offer_recipients where offer_id = p_offer_id and person_id = v_me) then
    raise exception 'KVISA_FORBIDDEN: this job was not offered to you' using errcode = '42501';
  end if;
  if f.status <> 'available' then
    raise exception 'KVISA_TAKEN: this job is no longer available%',
      case f.status when 'accepted' then ' — another driver accepted it' when 'expired' then ' — the offer expired' else '' end;
  end if;
  if (select response from offer_recipients where offer_id = p_offer_id and person_id = v_me) <> 'pending' then
    raise exception 'KVISA_VALIDATION: you already responded to this offer';
  end if;
  select order_no into v_no from orders where id = f.order_id;
  select full_name into v_name from people where id = v_me;
  select public.task_type_label(task_type) into v_task from order_tasks where id = f.task_id;

  if not p_accept then
    perform public._wf('offer.declined', null);
    update offer_recipients set response = 'declined', responded_at = now() where offer_id = p_offer_id and person_id = v_me;
    select count(*) into v_left from offer_recipients where offer_id = p_offer_id and response = 'pending';
    if v_left = 0 then
      update task_offers set status = 'declined', closed_at = now(), close_reason = 'Every driver declined' where id = p_offer_id;
      perform public._notify_staff('exception', format('Nobody took %s — K-%s', v_task, v_no), 'Every offered driver declined. Dispatch again or assign someone.', f.order_id, f.task_id);
    end if;
    return jsonb_build_object('accepted', false);
  end if;

  if public._dispatch_block_reason(f.task_id) is not null then
    raise exception 'KVISA_TAKEN: this job is no longer available';
  end if;
  perform public._wf('offer.accepted', null);
  update task_offers set status = 'accepted', accepted_person_id = v_me, accepted_at = now(), closed_at = now() where id = p_offer_id;
  update offer_recipients set response = 'accepted', responded_at = now() where offer_id = p_offer_id and person_id = v_me;
  update offer_recipients set response = 'withdrawn', responded_at = now() where offer_id = p_offer_id and response = 'pending';
  perform public._wf('task.assigned', 'Accepted dispatch offer');
  update order_tasks set assignee_id = v_me where id = f.task_id;
  perform public._notify_staff('assigned', format('%s accepted %s — K-%s', v_name, v_task, v_no), null, f.order_id, f.task_id);
  return jsonb_build_object('accepted', true, 'task_id', f.task_id);
end $$;

-- Taking a stage away from a driver (reassign / unassign) closes their accepted offer record,
-- so the history shows the access was revoked. Address access itself already ends because
-- my_tasks only returns stages currently assigned to the caller.
create or replace function public.close_offer_on_reassign() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.assignee_id is not null and new.assignee_id is distinct from old.assignee_id then
    insert into audit_logs (actor_id, actor_email, action, entity, entity_id, order_id, old_value, new_value, reason)
    select auth.uid(), (select email from profiles where id = auth.uid()), 'offer.access_revoked', 'order_tasks', new.id::text, new.order_id,
      jsonb_build_object('person_id', old.assignee_id), jsonb_build_object('person_id', new.assignee_id), 'Stage reassigned'
    where exists (select 1 from task_offers where task_id = new.id and status = 'accepted' and accepted_person_id = old.assignee_id);
  end if;
  return new;
end $$;
create trigger t_offer_reassign after update of assignee_id on public.order_tasks
  for each row execute function public.close_offer_on_reassign();

-- Optional rule: dispatch the return pickup automatically when washing is completed.
create or replace function public.auto_dispatch_return() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_task uuid;
begin
  if new.event_type = 'wash_completed' and (select auto_dispatch_return from organization_settings where id = 1) then
    select id into v_task from order_tasks where order_id = new.order_id and task_type = 'return_collection'
      and assignee_id is null and status = 'pending';
    if v_task is not null and not exists (select 1 from task_offers where task_id = v_task and status = 'available')
       and public._dispatch_block_reason(v_task) is null then
      begin
        perform public._wf('offer.dispatched', 'Automatic return dispatch');
        insert into task_offers (order_id, task_id, open_to_all, note, expires_at, created_by)
          values (new.order_id, v_task, true, 'Automatic return dispatch',
            case when (select default_offer_minutes from organization_settings where id=1) is null then null
                 else now() + make_interval(mins => (select default_offer_minutes from organization_settings where id=1)) end, null);
        insert into offer_recipients (offer_id, order_id, person_id)
          select (select id from task_offers where task_id = v_task and status = 'available'), new.order_id, pp.id
          from people pp join person_roles r on r.person_id = pp.id and r.role = 'driver' and r.active where pp.active;
      exception when others then null;  -- never block the washer's handoff
      end;
    end if;
  end if;
  return new;
end $$;
create trigger t_auto_dispatch_return after insert on public.handoff_events
  for each row execute function public.auto_dispatch_return();

-- ---------------------------------------------------------------
-- Staff view of each driver stage's dispatch state
-- ---------------------------------------------------------------
create or replace view public.task_dispatch with (security_invoker = true) as
select t.id as task_id, t.order_id, t.task_type, t.seq, t.status as task_status, t.assignee_id,
  lo.id as offer_id, lo.status as offer_status, lo.created_at as offered_at, lo.expires_at, lo.accepted_at, lo.accepted_person_id,
  (select count(*)::int from public.offer_recipients r where r.offer_id = lo.id) as offered_count,
  (select count(*)::int from public.offer_recipients r where r.offer_id = lo.id and r.response = 'declined') as declined_count,
  case
    when t.status = 'completed' then 'completed'
    when t.status = 'in_progress' then 'in_progress'
    when t.status = 'cancelled' then 'cancelled'
    when lo.status = 'available' and lo.expires_at is not null and lo.expires_at < now() then 'expired'
    when lo.status = 'available' then 'available'
    when lo.status = 'accepted' and t.assignee_id = lo.accepted_person_id then 'accepted'
    when t.assignee_id is not null then 'assigned'
    when lo.status in ('declined','expired','cancelled') then lo.status
    else 'not_dispatched'
  end as dispatch_status,
  public._dispatch_block_reason(t.id) as blocked_reason
from public.order_tasks t
left join lateral (select f.* from public.task_offers f where f.task_id = t.id order by f.created_at desc limit 1) lo on true
where t.task_type <> 'washing';
grant select on public.task_dispatch to authenticated;
revoke all on public.task_dispatch from anon;

-- Function permissions
revoke execute on function public._expire_offers() from public, anon, authenticated;
revoke execute on function public._dispatch_block_reason(uuid) from public, anon;
grant execute on function public._dispatch_block_reason(uuid) to authenticated;  -- used by the staff-only view
revoke execute on function public.close_offer_on_reassign() from public, anon, authenticated;
revoke execute on function public.auto_dispatch_return() from public, anon, authenticated;
revoke execute on function public.dispatch_preview(uuid), public.dispatch_task(uuid, uuid[], integer, text, boolean),
  public.cancel_offer(uuid, text), public.my_offers(), public.respond_offer(uuid, boolean), public.street_only(text) from public, anon;
grant execute on function public.dispatch_preview(uuid), public.dispatch_task(uuid, uuid[], integer, text, boolean),
  public.cancel_offer(uuid, text), public.my_offers(), public.respond_offer(uuid, boolean) to authenticated;
