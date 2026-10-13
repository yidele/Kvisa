-- Kvisa 005: fix notification-kind check (array comparison)

create or replace function public._notify_user(p_user uuid, p_kind text, p_title text, p_body text,
  p_order uuid, p_task uuid, p_dedupe text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_kinds text[];
begin
  if p_user is null then return; end if;
  select notify_kinds into v_kinds from organization_settings where id = 1;
  if not (p_kind = any(coalesce(v_kinds, '{}'::text[]))) then return; end if;
  insert into notifications (user_id, kind, title, body, order_id, task_id, dedupe_key)
  values (p_user, p_kind, p_title, p_body, p_order, p_task, p_dedupe)
  on conflict (user_id, dedupe_key) do nothing;
end $$;
revoke execute on function public._notify_user(uuid, text, text, text, uuid, uuid, text) from public, anon, authenticated;
