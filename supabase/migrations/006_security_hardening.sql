-- Kvisa 006: security advisor follow-ups
-- * Fixed search_path on every helper/trigger function.
-- * Trigger functions are not callable through the API.
-- * signup_allowed is no longer callable anonymously (avoids invite-list probing);
--   the sign-up form explains the "not invited" error instead.

alter function public.set_updated_at() set search_path = public;
alter function public.orders_touch() set search_path = public;
alter function public.forbid_change() set search_path = public;
alter function public.in_workflow() set search_path = public;
alter function public.guard_task_update() set search_path = public;
alter function public.guard_order_update() set search_path = public;
alter function public.task_type_label(text) set search_path = public;
alter function public.orders_mark_detached() set search_path = public;
alter function public._require_staff() set search_path = public;
alter function public._wf(text, text) set search_path = public;

revoke execute on function public.track_assignment() from public, anon, authenticated;
revoke execute on function public.validate_task_assignee() from public, anon, authenticated;
revoke execute on function public.signup_allowed(text) from public, anon, authenticated;
