-- Main app (Nekius Dispatch, project icghbewmvapvrxmwxlyg): requests from the walk-up tablet.
-- Applied to the MAIN app's database, not Kvisa's. Kvisa's server calls these three functions over HTTPS
-- (kiosk_submit / kiosk_lookup / kiosk_cancel); they work only with the tablet secret, whose hash is kept in
-- tablet_bridge (the secret itself is in Kvisa's encrypted vault, never in this repository).
-- Nothing existing changes: one new column, one new table, new functions.

alter table public.requests add column if not exists tablet_key uuid unique;   -- set only on calls from the tablet

create table if not exists public.tablet_bridge (
  id int primary key default 1 check (id = 1),
  secret_hash text not null
);
alter table public.tablet_bridge enable row level security;   -- no policies: only the functions below read it
revoke all on public.tablet_bridge from anon, authenticated;

create or replace function public._tablet_ok(p_secret text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from tablet_bridge where secret_hash = crypt(coalesce(p_secret, ''), secret_hash))
$$;

-- Same phone matching as the app (normPhone): the last 10 digits.
create or replace function public._phone10(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(case when length(d) >= 10 then right(d, 10) else d end, '')
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

-- Israeli numbers are written both as 050-… and +972 50-…; for those, compare the last 9 digits.
create or replace function public._phone_il(p text) returns text
language sql immutable set search_path = public as $$
  select case when d like '972%' and length(d) >= 11 then right(d, 9)
              when d like '0%' and length(d) = 10 then right(d, 9) end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

-- True when two numbers are the same phone (same last 10 digits, or the same Israeli number).
create or replace function public._same_phone(a text, b text) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(_phone10(a) = _phone10(b) or _phone_il(a) = _phone_il(b), false)
$$;

-- A drop-off from the tablet becomes an Open request. The meshulach is found by either number against
-- either saved number (Mashilach clients first); otherwise he is added as a Mashilach client with the
-- saved meshulach address. Existing client details are never overwritten (only an empty "Other phone"
-- is filled); the numbers typed today go in the request's note. Sending the same key twice returns the
-- same request.
create or replace function public.tablet_request(p_secret text, p_key uuid, p_ref bigint, p_name text,
  p_phone text, p_phone2 text, p_bags integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s app_settings%rowtype;
  c clients%rowtype;
  v_req requests%rowtype;
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_p1 text := _phone10(p_phone);
  v_p2 text := _phone10(p_phone2);
  v_new boolean := false;
  v_notes text;
begin
  if not _tablet_ok(p_secret) then raise exception 'TABLET_FORBIDDEN' using errcode = '42501'; end if;
  if p_key is null or v_name = '' or v_p1 is null then raise exception 'TABLET_INVALID: key, name and phone are required'; end if;

  select * into v_req from requests where tablet_key = p_key;
  if found then return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'repeat', true); end if;

  select * into s from app_settings where id = 1;
  select cl.* into c from clients cl
   where _same_phone(cl.phone, p_phone) or _same_phone(cl.phone2, p_phone)
      or _same_phone(cl.phone, p_phone2) or _same_phone(cl.phone2, p_phone2)
   order by cl.is_mashilach desc, (cl.status = 'active') desc,
            (_same_phone(cl.phone, p_phone2) or _same_phone(cl.phone2, p_phone2)) desc, cl.created_at desc
   limit 1;
  if not found then
    v_new := true;
    insert into clients (name, phone, phone2, address, note, is_mashilach, status, created_by)
    values (v_name, trim(p_phone), case when v_p2 is not null and not _same_phone(p_phone, p_phone2) then trim(p_phone2) end,
            s.mashilach_address, s.mashilach_note, true, 'active', null)
    returning * into c;
  elsif c.phone2 is null and v_p2 is not null and not _same_phone(c.phone, p_phone2) then
    update clients set phone2 = trim(p_phone2) where id = c.id;
  end if;

  v_notes := concat_ws(' · ', 'Tablet drop-off · ID ' || p_ref,
    case when not v_new and not _same_phone(c.phone, p_phone) and not _same_phone(c.phone2, p_phone)
         then 'Phone now: ' || trim(p_phone) end,
    case when not v_new and v_p2 is not null and not _same_phone(p_phone, p_phone2)
              and not _same_phone(c.phone, p_phone2) and not _same_phone(c.phone2, p_phone2)
         then 'Israel: ' || trim(p_phone2) end);
  insert into requests (client_id, bags, requested_for, status, notes, created_by, tablet_key)
  values (c.id, least(greatest(coalesce(p_bags, 1), 1), 50), now(), 'open', v_notes, null, p_key)
  returning * into v_req;
  return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'new_client', v_new, 'repeat', false);
end $$;

create or replace function public.tablet_status(p_secret text, p_key uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_req requests%rowtype;
begin
  if not _tablet_ok(p_secret) then raise exception 'TABLET_FORBIDDEN' using errcode = '42501'; end if;
  select * into v_req from requests where tablet_key = p_key;
  if not found then return null; end if;
  return jsonb_build_object('request_id', v_req.id, 'status', v_req.status);
end $$;

-- Cancel from the tablet: only before the bags were picked up.
create or replace function public.tablet_cancel(p_secret text, p_key uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_req requests%rowtype;
begin
  if not _tablet_ok(p_secret) then raise exception 'TABLET_FORBIDDEN' using errcode = '42501'; end if;
  select * into v_req from requests where tablet_key = p_key for update;
  if not found then return null; end if;
  if v_req.status = 'cancelled' then return jsonb_build_object('request_id', v_req.id, 'status', 'cancelled'); end if;
  if v_req.status not in ('open', 'assigned', 'posted_pickup', 'not_covered') then
    raise exception 'TABLET_PICKED_UP: already picked up';
  end if;
  update requests set status = 'cancelled', notes = concat_ws(' · ', nullif(notes, ''), 'Cancelled by the client on the tablet')
   where id = v_req.id;
  return jsonb_build_object('request_id', v_req.id, 'status', 'cancelled');
end $$;

revoke execute on function public._tablet_ok(text), public._phone10(text), public._phone_il(text),
  public._same_phone(text, text) from public, anon, authenticated;
revoke execute on function public.tablet_request(text, uuid, bigint, text, text, text, integer),
  public.tablet_status(text, uuid), public.tablet_cancel(text, uuid) from public;
grant execute on function public.tablet_request(text, uuid, bigint, text, text, text, integer),
  public.tablet_status(text, uuid), public.tablet_cancel(text, uuid) to anon, authenticated;
