-- 1041GR Daily Reporting — schema (migration 1 of 3)
-- As applied, this migration also added foreign-key indexes, split each 'for all' policy into insert/update/delete
-- policies and revoked anon access to helper functions. The project's migration history in Supabase is authoritative.
-- Supabase project: pgs-1041gr-reporting (eu-central-1)
-- Operational reporting only: no family, next-of-kin or grave personal data is stored here.

create extension if not exists pgcrypto;

create type app_role as enum ('admin', 'supervisor', 'field');
create type activity_kind as enum ('completed', 'planned');
create type report_status as enum ('draft', 'submitted');

-- ---------- reference data ----------
create table project (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                 -- e.g. 1041GR (tracker holds it as 1041GRV2)
  name text not null,
  client text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table team (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references project(id) on delete cascade,
  name text not null,
  sort int not null default 0,
  active boolean not null default true,
  unique (project_id, name)
);

create table kpi (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references project(id) on delete cascade,
  label text not null,
  target_total numeric,                      -- optional overall project target
  sort int not null default 0,
  active boolean not null default true,
  unique (project_id, label)
);

-- ---------- people ----------
create table app_user (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null unique check (email = lower(email)),
  role app_role not null default 'field',
  team_id uuid references team(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table staff_invite (
  email text primary key check (email = lower(email)),
  full_name text not null,
  role app_role not null default 'field',
  team_id uuid references team(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------- reports ----------
create table daily_report (
  id uuid primary key,                       -- generated on the device so offline saves are idempotent
  project_id uuid not null references project(id),
  team_id uuid not null references team(id),
  report_date date not null,
  key_info text,
  emerging_issues text,
  quotes text,
  status report_status not null default 'draft',
  locked boolean not null default false,     -- set by supervisor/admin once reviewed
  created_by uuid not null references app_user(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  unique (project_id, team_id, report_date)
);
create index on daily_report (project_id, report_date desc);
create index on daily_report (team_id, report_date desc);

create table report_kpi (
  report_id uuid not null references daily_report(id) on delete cascade,
  kpi_id uuid not null references kpi(id),
  planned numeric,
  actual numeric,
  not_applicable boolean not null default false,
  rag smallint check (rag between 1 and 3),  -- 1 red, 2 amber, 3 green (as in the Excel template)
  primary key (report_id, kpi_id)
);
create index on report_kpi (kpi_id);

create table report_activity (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references daily_report(id) on delete cascade,
  kind activity_kind not null,
  activity text not null,
  rag smallint check (rag between 1 and 3),
  comment text,
  sort int not null default 0
);
create index on report_activity (report_id);

create table report_photo (
  id uuid primary key,                       -- generated on the device
  report_id uuid not null references daily_report(id) on delete cascade,
  storage_path text not null unique,
  caption text,
  taken_at timestamptz,
  created_by uuid references app_user(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index on report_photo (report_id);

-- ---------- helper functions ----------
create or replace function my_role() returns app_role
language sql stable security definer set search_path = public as
$$ select role from app_user where id = auth.uid() and active $$;

create or replace function my_team() returns uuid
language sql stable security definer set search_path = public as
$$ select team_id from app_user where id = auth.uid() and active $$;

create or replace function is_office() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce(my_role() in ('admin','supervisor'), false) $$;

create or replace function can_see_report(r uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from daily_report d where d.id = r and (is_office() or d.team_id = my_team())) $$;

create or replace function can_edit_report(r uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from daily_report d where d.id = r
     and ((my_role() = 'admin') or (my_role() = 'supervisor' and not d.locked) or (my_role() = 'field' and d.team_id = my_team() and not d.locked))) $$;

-- Invited users: link on first sign-in; anyone not invited cannot create an account.
create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv staff_invite;
begin
  select * into inv from staff_invite where email = lower(new.email);
  if not found then
    raise exception 'This email address has not been invited to 1041GR Daily Reporting';
  end if;
  insert into app_user(id, full_name, email, role, team_id)
  values (new.id, inv.full_name, inv.email, inv.role, inv.team_id)
  on conflict (id) do update set full_name = excluded.full_name, role = excluded.role, team_id = excluded.team_id, active = true;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_auth_user();

-- Changing an invite also updates an existing user's role/team.
create or replace function sync_invite_to_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update app_user set full_name = new.full_name, role = new.role, team_id = new.team_id
  where email = new.email;
  return new;
end $$;
create trigger staff_invite_sync after insert or update on staff_invite
  for each row execute function sync_invite_to_user();

-- ---------- save a whole report in one go (used by the offline outbox) ----------
-- payload: {id, project_id, team_id, report_date, key_info, emerging_issues, quotes, status,
--           base_updated_at, kpis:[{kpi_id,planned,actual,not_applicable,rag}],
--           activities:[{kind,activity,rag,comment}]}
-- Returns {ok:true, updated_at} or {ok:false, conflict:'duplicate'|'changed'|'locked', ...}
create or replace function save_report(p jsonb, p_force boolean default false) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  rid uuid := (p->>'id')::uuid;
  existing daily_report;
  other daily_report;
  who text;
  ts timestamptz := now();
begin
  if my_role() is null then raise exception 'Not an active user'; end if;
  if my_role() = 'field' and (p->>'team_id')::uuid is distinct from my_team() then
    raise exception 'You can only report for your own team';
  end if;

  select * into existing from daily_report where id = rid;

  -- another report already exists for this team and day
  select * into other from daily_report
   where project_id = (p->>'project_id')::uuid and team_id = (p->>'team_id')::uuid
     and report_date = (p->>'report_date')::date and id <> rid;
  if found then
    select full_name into who from app_user where id = other.created_by;
    if not p_force or other.locked then
      return jsonb_build_object('ok', false, 'conflict', 'duplicate', 'other_id', other.id,
                                'other_by', who, 'other_updated_at', other.updated_at, 'locked', other.locked);
    end if;
    if not can_edit_report(other.id) then raise exception 'Not allowed to replace that report'; end if;
    delete from daily_report where id = other.id;   -- forced replace
  end if;

  if existing.id is not null then
    if existing.locked and my_role() <> 'admin' then
      return jsonb_build_object('ok', false, 'conflict', 'locked');
    end if;
    if not p_force and p ? 'base_updated_at' and p->>'base_updated_at' is not null
       and existing.updated_at > (p->>'base_updated_at')::timestamptz + interval '1 second' then
      select full_name into who from app_user where id = existing.updated_by;
      return jsonb_build_object('ok', false, 'conflict', 'changed', 'other_by', who, 'other_updated_at', existing.updated_at);
    end if;
    update daily_report set
      team_id = (p->>'team_id')::uuid,
      report_date = (p->>'report_date')::date,
      key_info = p->>'key_info',
      emerging_issues = p->>'emerging_issues',
      quotes = p->>'quotes',
      status = coalesce((p->>'status')::report_status, status),
      submitted_at = case when (p->>'status') = 'submitted' and submitted_at is null then ts else submitted_at end,
      updated_by = auth.uid(),
      updated_at = ts
    where id = rid;
  else
    insert into daily_report(id, project_id, team_id, report_date, key_info, emerging_issues, quotes, status,
                             created_by, updated_by, updated_at, submitted_at)
    values (rid, (p->>'project_id')::uuid, (p->>'team_id')::uuid, (p->>'report_date')::date,
            p->>'key_info', p->>'emerging_issues', p->>'quotes', coalesce((p->>'status')::report_status, 'draft'),
            auth.uid(), auth.uid(), ts, case when (p->>'status') = 'submitted' then ts end);
  end if;

  delete from report_kpi where report_id = rid;
  insert into report_kpi(report_id, kpi_id, planned, actual, not_applicable, rag)
  select rid, (k->>'kpi_id')::uuid, nullif(k->>'planned','')::numeric, nullif(k->>'actual','')::numeric,
         coalesce((k->>'not_applicable')::boolean, false), nullif(k->>'rag','')::smallint
  from jsonb_array_elements(coalesce(p->'kpis','[]'::jsonb)) k;

  delete from report_activity where report_id = rid;
  insert into report_activity(report_id, kind, activity, rag, comment, sort)
  select rid, (a.v->>'kind')::activity_kind, a.v->>'activity', nullif(a.v->>'rag','')::smallint, a.v->>'comment', a.n
  from jsonb_array_elements(coalesce(p->'activities','[]'::jsonb)) with ordinality a(v, n)
  where coalesce(trim(a.v->>'activity'), '') <> '';

  return jsonb_build_object('ok', true, 'updated_at', ts);
end $$;

-- Cumulative actuals per team and KPI up to and including a date (all teams when p_team is null).
create or replace function kpi_totals(p_project uuid, p_team uuid, p_upto date)
returns table (kpi_id uuid, cumulative numeric)
language sql stable security invoker set search_path = public as $$
  select rk.kpi_id, sum(rk.actual)
  from report_kpi rk join daily_report d on d.id = rk.report_id
  where d.project_id = p_project and d.report_date <= p_upto
    and (p_team is null or d.team_id = p_team) and not rk.not_applicable
  group by rk.kpi_id
$$;

-- ---------- row level security ----------
alter table project enable row level security;
alter table team enable row level security;
alter table kpi enable row level security;
alter table app_user enable row level security;
alter table staff_invite enable row level security;
alter table daily_report enable row level security;
alter table report_kpi enable row level security;
alter table report_activity enable row level security;
alter table report_photo enable row level security;

create policy read_ref on project for select to authenticated using (my_role() is not null);
create policy admin_ref on project for all to authenticated using (my_role() = 'admin') with check (my_role() = 'admin');
create policy read_ref on team for select to authenticated using (my_role() is not null);
create policy admin_ref on team for all to authenticated using (my_role() = 'admin') with check (my_role() = 'admin');
create policy read_ref on kpi for select to authenticated using (my_role() is not null);
create policy admin_ref on kpi for all to authenticated using (my_role() = 'admin') with check (my_role() = 'admin');

create policy read_users on app_user for select to authenticated using (id = auth.uid() or is_office());
create policy admin_users on app_user for update to authenticated using (my_role() = 'admin') with check (my_role() = 'admin');
create policy admin_invites on staff_invite for all to authenticated using (my_role() = 'admin') with check (my_role() = 'admin');

create policy read_reports on daily_report for select to authenticated using (is_office() or team_id = my_team());
create policy insert_reports on daily_report for insert to authenticated
  with check (my_role() is not null and (is_office() or team_id = my_team()));
create policy update_reports on daily_report for update to authenticated
  using (can_edit_report(id)) with check (is_office() or team_id = my_team());
create policy delete_reports on daily_report for delete to authenticated using (can_edit_report(id));

create policy read_children on report_kpi for select to authenticated using (can_see_report(report_id));
create policy write_children on report_kpi for all to authenticated using (can_edit_report(report_id)) with check (can_edit_report(report_id));
create policy read_children on report_activity for select to authenticated using (can_see_report(report_id));
create policy write_children on report_activity for all to authenticated using (can_edit_report(report_id)) with check (can_edit_report(report_id));
create policy read_children on report_photo for select to authenticated using (can_see_report(report_id));
create policy write_children on report_photo for all to authenticated using (can_edit_report(report_id)) with check (can_edit_report(report_id));

revoke execute on function save_report(jsonb, boolean) from public, anon;
grant execute on function save_report(jsonb, boolean) to authenticated;
revoke execute on function kpi_totals(uuid, uuid, date) from public, anon;
grant execute on function kpi_totals(uuid, uuid, date) to authenticated;
revoke execute on function handle_new_auth_user() from public, anon, authenticated;
revoke execute on function sync_invite_to_user() from public, anon, authenticated;

-- ---------- photo storage (private bucket; path = <report_id>/<photo_id>.jpg) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-photos', 'report-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy photos_read on storage.objects for select to authenticated
  using (bucket_id = 'report-photos' and can_see_report(((storage.foldername(name))[1])::uuid));
-- photos are uploaded by the outbox only after the report itself has been saved
create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'report-photos' and can_edit_report(((storage.foldername(name))[1])::uuid));
create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'report-photos' and can_edit_report(((storage.foldername(name))[1])::uuid));

-- ---------- seed ----------
with p as (
  insert into project (code, name, client) values ('1041GR', 'Grave relocation, Kenya', 'Shanta Gold Kenya') returning id
), t as (
  insert into team (project_id, name, sort) select id, 'Grave Relocation Team', 1 from p
), k as (
  insert into kpi (project_id, label, sort)
  select p.id, x.label, x.sort from p, (values
    ('Households engaged', 1),
    ('Grave register data captured', 2),
    ('Household non-objection documentation signed', 3),
    ('Household notification of exhumation signed', 4),
    ('Sacred sites mitigated/relocated', 5),
    ('Graves mitigated/relocated', 6)
  ) as x(label, sort)
)
select 1;

insert into staff_invite (email, full_name, role) values ('henk@pgsheritage.com', 'Henk Steyn', 'admin');
