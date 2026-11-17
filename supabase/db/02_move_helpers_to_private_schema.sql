-- Helper functions out of the public API (security advisor), keeping policies intact
create schema if not exists private;
grant usage on schema private to authenticated;
alter function public.my_role() set schema private;
alter function public.my_team() set schema private;
alter function public.is_office() set schema private;
alter function public.can_see_report(uuid) set schema private;
alter function public.can_edit_report(uuid) set schema private;
alter function private.my_role() set search_path = public, private;
alter function private.my_team() set search_path = public, private;
alter function private.is_office() set search_path = public, private;
alter function private.can_see_report(uuid) set search_path = public, private;
alter function private.can_edit_report(uuid) set search_path = public, private;
alter function public.save_report(jsonb, boolean) set search_path = public, private;
