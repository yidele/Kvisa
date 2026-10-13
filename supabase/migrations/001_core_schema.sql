-- Kvisa 001: core schema
-- Tables, constraints and indexes. Security (RLS) is in 002, workflow functions in 003+.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- Organization settings (single row)
-- ---------------------------------------------------------------
create table public.organization_settings (
  id integer primary key default 1 check (id = 1),
  org_name text not null default 'Kvisa',
  org_phone text,
  org_email text,
  org_address text,
  time_zone text not null default 'America/New_York',
  planning_window_days integer not null default 28 check (planning_window_days between 1 and 180),
  default_pickup_time time not null default '10:00',
  default_wash_days integer not null default 2 check (default_wash_days between 0 and 30),
  default_return_days integer not null default 3 check (default_return_days between 0 and 60),
  min_minutes_between_tasks integer not null default 30 check (min_minutes_between_tasks between 0 and 600),
  flag_collection_vs_expected boolean not null default true,
  require_discrepancy_resolution boolean not null default true,
  overdue_grace_minutes integer not null default 60 check (overdue_grace_minutes between 0 and 1440),
  upcoming_notice_hours integer not null default 12 check (upcoming_notice_hours between 0 and 168),
  notify_kinds text[] not null default array[
    'assigned','reassigned','schedule_changed','upcoming','overdue',
    'washing_completed','return_ready','delivered','exception'],
  cancellation_reasons text[] not null default array[
    'Client cancelled','No bags ready','Duplicate order','Skipped occurrence','Other'],
  correction_reasons text[] not null default array[
    'Entered by mistake','Wrong bag count','Wrong person recorded','Other'],
  status_labels jsonb not null default '{}'::jsonb,
  task_type_labels jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.organization_settings (id) values (1);

-- ---------------------------------------------------------------
-- Client categories (configurable)
-- ---------------------------------------------------------------
create table public.client_categories (
  id text primary key check (id ~ '^[a-z0-9_]{1,40}$'),
  label text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  default_pickup_address text,
  default_pickup_note text
);
insert into public.client_categories (id, label, sort_order) values
  ('meshilach','Meshilach',1), ('family','Family',2), ('other','Other',3);

-- ---------------------------------------------------------------
-- People: one record per human. A person may be a driver, a washer, or both.
-- ---------------------------------------------------------------
create table public.people (
  id uuid primary key default gen_random_uuid(),
  person_no bigint generated always as identity unique,
  full_name text not null check (length(trim(full_name)) > 0),
  phone text,
  email text,
  address text,                -- home / washing address
  address_note text,
  availability text,           -- free text, e.g. "Evenings after 6"
  preferred_days smallint[] not null default '{}' ,   -- 0=Sun .. 6=Sat
  max_bags_per_day integer check (max_bags_per_day is null or max_bags_per_day >= 0),
  unavailable_from date,
  unavailable_until date,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (unavailable_until is null or unavailable_from is null or unavailable_until >= unavailable_from)
);

create table public.person_roles (
  person_id uuid not null references public.people(id) on delete restrict,
  role text not null check (role in ('driver','washer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (person_id, role)
);

-- ---------------------------------------------------------------
-- App users
-- ---------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  person_id uuid unique references public.people(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('admin','dispatcher','driver','volunteer')),
  granted_by uuid references public.profiles(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.invites (
  email text primary key check (email = lower(email)),
  roles text[] not null check (roles <@ array['admin','dispatcher','driver','volunteer']::text[] and cardinality(roles) > 0),
  person_id uuid references public.people(id),
  full_name text,
  invited_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  used_at timestamptz
);

-- ---------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  client_no bigint generated always as identity unique,
  name text not null check (length(trim(name)) > 0),
  category_id text not null references public.client_categories(id),
  primary_contact text,
  phone text,
  email text,
  pickup_address text,
  default_return_recipient text,
  default_return_phone text,
  default_return_address text,
  access_instructions text,
  preferred_days smallint[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index clients_name_idx on public.clients (lower(name));
create index clients_phone_idx on public.clients (regexp_replace(coalesce(phone,''), '\D', '', 'g'));

-- Restricted notes live in their own table so drivers/washers can never read them.
create table public.client_internal_notes (
  client_id uuid primary key references public.clients(id) on delete cascade,
  notes text,
  updated_at timestamptz not null default now()
);

create table public.client_addresses (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  label text not null default 'Other',
  address text not null,
  instructions text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index client_addresses_client_idx on public.client_addresses (client_id);

-- ---------------------------------------------------------------
-- Recurring schedules
-- ---------------------------------------------------------------
create table public.recurring_schedules (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  weekdays smallint[] not null check (cardinality(weekdays) > 0 and weekdays <@ array[0,1,2,3,4,5,6]::smallint[]),
  pickup_time time not null default '10:00',
  start_date date not null,
  end_date date,
  expected_bags integer not null default 1 check (expected_bags >= 0),
  pickup_address text,
  return_recipient text,
  return_phone text,
  return_address text,
  delivery_instructions text,
  default_pickup_driver_id uuid references public.people(id),
  default_washer_id uuid references public.people(id),
  default_delivery_driver_id uuid references public.people(id),
  notes text,
  status text not null default 'active' check (status in ('active','paused','cancelled')),
  generated_through date,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);
create index recurring_client_idx on public.recurring_schedules (client_id);

-- ---------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_no bigint generated always as identity (start with 1001) unique,
  client_id uuid not null references public.clients(id) on delete restrict,
  category_id text not null references public.client_categories(id),
  status text not null default 'requested' check (status in (
    'requested','scheduled','pickup_in_progress','awaiting_dropoff','awaiting_washing',
    'washing_in_progress','ready_for_return','return_collection_in_progress',
    'out_for_delivery','completed','exception','cancelled')),
  pickup_contact text,
  pickup_phone text,
  pickup_address text,
  return_recipient text,
  return_phone text,
  return_address text,
  delivery_instructions text,
  expected_bags integer not null default 0 check (expected_bags >= 0),
  bag_notes text,
  expected_return_date date,
  notes text,
  recurring_schedule_id uuid references public.recurring_schedules(id) on delete restrict,
  occurrence_date date,
  detached_from_series boolean not null default false,
  cancel_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  completed_at timestamptz,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) default auth.uid(),
  check ((recurring_schedule_id is null) = (occurrence_date is null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
-- Prevents duplicate generation of the same recurring occurrence.
create unique index orders_recurring_occurrence_uq on public.orders (recurring_schedule_id, occurrence_date)
  where recurring_schedule_id is not null;
create index orders_client_idx on public.orders (client_id);
create index orders_status_idx on public.orders (status);
create index orders_updated_idx on public.orders (updated_at desc);

-- ---------------------------------------------------------------
-- Order tasks: one row per stage
-- ---------------------------------------------------------------
create table public.order_tasks (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  task_type text not null check (task_type in ('pickup','dropoff','washing','return_collection','delivery')),
  seq smallint not null check (seq between 1 and 5),
  status text not null default 'pending' check (status in ('pending','in_progress','completed','cancelled')),
  assignee_id uuid references public.people(id),
  scheduled_at timestamptz,
  original_scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  from_address text,
  to_address text,
  expected_bags integer check (expected_bags is null or expected_bags >= 0),
  actual_bags integer check (actual_bags is null or actual_bags >= 0),
  instructions text,
  notes text,
  updated_at timestamptz not null default now(),
  unique (order_id, task_type),
  check ((status = 'completed') = (completed_at is not null))
);
create index order_tasks_assignee_idx on public.order_tasks (assignee_id, scheduled_at);
create index order_tasks_scheduled_idx on public.order_tasks (scheduled_at);

-- History of every assignment, never overwritten.
create table public.task_assignments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.order_tasks(id) on delete restrict,
  person_id uuid references public.people(id),
  assigned_by uuid references public.profiles(id),
  assigned_at timestamptz not null default now(),
  ended_at timestamptz,
  reason text
);
create index task_assignments_task_idx on public.task_assignments (task_id, assigned_at);

-- ---------------------------------------------------------------
-- Handoff events (append-only bag accountability)
-- ---------------------------------------------------------------
create table public.handoff_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  task_id uuid references public.order_tasks(id) on delete restrict,
  event_type text not null check (event_type in (
    'task_started','collected_from_client','delivered_to_washer','received_by_washer',
    'wash_started','wash_completed','collected_from_washer','delivered_to_recipient',
    'count_correction','event_reverted')),
  expected_bags integer check (expected_bags is null or expected_bags >= 0),
  actual_bags integer check (actual_bags is null or actual_bags >= 0),
  from_person_id uuid references public.people(id),
  to_person_id uuid references public.people(id),
  from_party text,
  to_party text,
  location text,
  occurred_at timestamptz not null default now(),
  recorded_by uuid references public.profiles(id) default auth.uid(),
  recorded_at timestamptz not null default now(),
  corrects_event_id uuid references public.handoff_events(id),
  notes text
);
create index handoff_order_idx on public.handoff_events (order_id, occurred_at);
create index handoff_occurred_idx on public.handoff_events (occurred_at);

-- ---------------------------------------------------------------
-- Exceptions (discrepancies, failed pickups, delays...)
-- ---------------------------------------------------------------
create table public.order_exceptions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  task_id uuid references public.order_tasks(id),
  handoff_event_id uuid references public.handoff_events(id),
  kind text not null check (kind in ('bag_discrepancy','failed_pickup','missing_bags','delay','other')),
  description text not null,
  expected_bags integer,
  actual_bags integer,
  status text not null default 'open' check (status in ('open','resolved')),
  reported_by uuid references public.profiles(id) default auth.uid(),
  reported_at timestamptz not null default now(),
  resolution text,
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  check ((status = 'resolved') = (resolved_at is not null and resolution is not null and length(trim(resolution)) > 0))
);
create index exceptions_order_idx on public.order_exceptions (order_id) ;
create index exceptions_open_idx on public.order_exceptions (status) where status = 'open';

-- ---------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  action text not null,
  entity text not null,
  entity_id text,
  order_id uuid,
  client_id uuid,
  old_value jsonb,
  new_value jsonb,
  reason text
);
create index audit_at_idx on public.audit_logs (at desc);
create index audit_order_idx on public.audit_logs (order_id, at desc);
create index audit_client_idx on public.audit_logs (client_id, at desc);
create index audit_actor_idx on public.audit_logs (actor_id, at desc);

-- ---------------------------------------------------------------
-- In-app notifications
-- ---------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  order_id uuid references public.orders(id),
  task_id uuid references public.order_tasks(id),
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, dedupe_key)
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- Outbox for future email/SMS delivery. Nothing reads this yet; a server-side
-- worker can be added later. Rows here are NOT "sent" messages.
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid references public.notifications(id) on delete cascade,
  channel text not null check (channel in ('email','sms')),
  status text not null default 'pending' check (status in ('pending','sent','failed','disabled')),
  provider_message_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
