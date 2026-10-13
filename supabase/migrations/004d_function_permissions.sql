-- Kvisa 004d: function permissions

-- ---------------------------------------------------------------
-- Function permissions: internal helpers are not callable from the API
-- ---------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
grant execute on function public.signup_allowed(text) to anon, authenticated;

do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like '\_%' escape '\'
  loop
    execute 'revoke execute on function ' || f || ' from authenticated';
  end loop;
end $$;
revoke execute on function public.recompute_order_status(uuid) from authenticated;
revoke execute on function public.handle_new_user() from authenticated;
revoke execute on function public.audit_row() from authenticated;

grant select on public.order_overview, public.task_calendar, public.handoff_effective to authenticated;
revoke all on public.order_overview, public.task_calendar, public.handoff_effective from anon;

-- Supabase's default privileges grant new functions to anon; keep future functions closed too.
alter default privileges in schema public revoke execute on functions from public, anon;
