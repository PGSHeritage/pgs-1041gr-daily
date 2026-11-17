-- App 1.3.5 (17 Nov 2026): record report deletions in the change history.
alter table report_change drop constraint report_change_action_check;
alter table report_change add constraint report_change_action_check
  check (action in ('created','edited','submitted','replaced','locked','unlocked','photo_added','photo_removed','deleted'));

create or replace function private.log_delete() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  insert into report_change(report_id, project_id, team_id, report_date, user_id, action, before, after, note)
  values (old.id, old.project_id, old.team_id, old.report_date, auth.uid(), 'deleted', report_snapshot(old.id), null,
          case when old.status = 'submitted' then 'Submitted report deleted' else 'Draft deleted' end);
  return old;
end $$;
revoke execute on function private.log_delete() from public, anon, authenticated;
create trigger log_delete before delete on daily_report for each row execute function private.log_delete();
