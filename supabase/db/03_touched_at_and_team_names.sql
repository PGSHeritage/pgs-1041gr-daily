-- touched_at lets phones pull only what changed (including photo changes)
alter table daily_report add column touched_at timestamptz not null default now();
create index on daily_report (project_id, touched_at);

create or replace function private.touch_report() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if tg_table_name = 'daily_report' then
    new.touched_at := clock_timestamp();
    return new;
  end if;
  update daily_report set touched_at = clock_timestamp()
   where id = coalesce(case when tg_op = 'DELETE' then old.report_id else new.report_id end, old.report_id);
  return null;
end $$;
revoke execute on function private.touch_report() from public, anon, authenticated;

create trigger touch_self before insert or update on daily_report for each row execute function private.touch_report();
create trigger touch_parent after insert or update or delete on report_photo for each row execute function private.touch_report();

-- teammates can see each other's names; office sees everyone
drop policy read_users on app_user;
create policy read_users on app_user for select to authenticated
  using (id = (select auth.uid()) or private.is_office() or (team_id is not null and team_id = private.my_team()));
