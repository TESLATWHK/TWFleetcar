-- Fleet tracker. Safe to run again if a previous attempt stopped partway.
--
-- Then, in the dashboard:
-- 1. Authentication → Providers → Email → turn off "Allow new users to sign up".
-- 2. Authentication → Users → Invite each teammate.
--    Optional user metadata: {"display_name": "Mei"}
--    They can also set their name on the Fleet page.
-- 3. Project Settings → API → copy the project URL and the anon key
--    into static/fleet-config.js. Never put the service_role key in that file
--    or in the page.

create extension if not exists pgcrypto;

create table if not exists public.showrooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort int not null default 0,
  constraint showrooms_name_len check (char_length(name) between 1 and 80)
);

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  email text,
  constraint profiles_name_len check (char_length(display_name) between 1 and 80)
);

create table if not exists public.cars (
  id uuid primary key default gen_random_uuid(),
  nickname text not null,
  model text not null default '',
  plate text not null default '',
  kind text not null,
  home_showroom_id uuid not null references public.showrooms (id),
  active boolean not null default true,
  notes text not null default '',
  status text not null default 'in',
  current_showroom_id uuid references public.showrooms (id),
  current_place text not null default '',
  current_purpose text,
  current_holder_id uuid references public.profiles (id),
  current_since timestamptz,
  created_at timestamptz not null default now(),
  constraint cars_kind check (kind in ('demo', 'display')),
  constraint cars_status check (status in ('in', 'out')),
  constraint cars_purpose check (
    current_purpose is null or current_purpose in (
      'test_drive', 'customer_viewing', 'display', 'transfer',
      'service', 'media', 'internal', 'other'
    )
  ),
  constraint cars_nickname_len check (char_length(nickname) between 1 and 80),
  constraint cars_model_len check (char_length(model) <= 80),
  constraint cars_plate_len check (char_length(plate) <= 20),
  constraint cars_notes_len check (char_length(notes) <= 500),
  constraint cars_place_len check (char_length(current_place) <= 120)
);

alter table public.cars add column if not exists exterior text not null default '';
alter table public.cars add column if not exists interior text not null default '';
alter table public.cars add column if not exists vin text not null default '';
create unique index if not exists cars_vin_unique on public.cars (vin) where vin <> '';

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  car_id uuid not null references public.cars (id) on delete cascade,
  action text not null,
  purpose text not null,
  showroom_id uuid references public.showrooms (id),
  place text not null default '',
  note text not null default '',
  actor_id uuid not null references public.profiles (id),
  happened_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint events_action check (action in ('checkout', 'checkin', 'move')),
  constraint events_purpose check (purpose in (
    'test_drive', 'customer_viewing', 'display', 'transfer',
    'service', 'media', 'internal', 'other'
  )),
  constraint events_place_len check (char_length(place) <= 120),
  constraint events_note_len check (char_length(note) <= 500)
);

create table if not exists public.car_shows (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  venue text not null default '',
  starts_on date,
  ends_on date,
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint car_shows_name_len check (char_length(name) <= 80),
  constraint car_shows_venue_len check (char_length(venue) <= 120),
  constraint car_shows_note_len check (char_length(note) <= 500)
);

alter table public.events
  add column if not exists car_show_id uuid references public.car_shows (id) on delete set null;

create index if not exists events_car_time on public.events (car_id, happened_at desc, created_at desc);
create index if not exists events_happened on public.events (happened_at desc);
create index if not exists events_car_show on public.events (car_show_id);

create or replace function public.car_shows_guard()
returns trigger
language plpgsql
as $$
begin
  new.name := trim(new.name);
  new.venue := trim(coalesce(new.venue, ''));
  new.note := trim(coalesce(new.note, ''));
  if new.name = '' then
    raise exception 'Name the car show.';
  end if;
  if char_length(new.name) > 80 then
    raise exception 'Name is too long.';
  end if;
  if char_length(new.venue) > 120 then
    raise exception 'Venue is too long.';
  end if;
  if char_length(new.note) > 500 then
    raise exception 'Note is too long.';
  end if;
  if new.starts_on is not null and new.ends_on is not null and new.ends_on < new.starts_on then
    raise exception 'End date is before the start date.';
  end if;
  return new;
end;
$$;

drop trigger if exists car_shows_guard on public.car_shows;
create trigger car_shows_guard
  before insert or update on public.car_shows
  for each row execute function public.car_shows_guard();

drop view if exists public.car_latest;
create view public.car_latest
with (security_invoker = true) as
select distinct on (car_id)
  id, car_id, actor_id, action, happened_at
from public.events
order by car_id, happened_at desc, created_at desc;

insert into public.showrooms (name, sort)
select seed.name, seed.sort
from (values ('Showroom 1', 1), ('Showroom 2', 2)) as seed(name, sort)
where (select count(*) from public.showrooms) = 0;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Teammate'
    ),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.showrooms_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.name := trim(coalesce(new.name, ''));
  if char_length(new.name) < 1 or char_length(new.name) > 80 then
    raise exception 'Showroom name must be 1 to 80 characters.';
  end if;
  return new;
end;
$$;

drop trigger if exists showrooms_guard on public.showrooms;
create trigger showrooms_guard
  before update on public.showrooms
  for each row execute function public.showrooms_guard();

create or replace function public.profiles_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.display_name := trim(coalesce(new.display_name, ''));
  if char_length(new.display_name) < 1 or char_length(new.display_name) > 80 then
    raise exception 'Name must be 1 to 80 characters.';
  end if;
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.email := old.email;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_guard();

-- Location columns change only from the event trigger (fleet.writing_location = on).
create or replace function public.cars_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  writing text := current_setting('fleet.writing_location', true);
begin
  new.nickname := trim(coalesce(new.nickname, ''));
  new.model := trim(coalesce(new.model, ''));
  new.plate := trim(coalesce(new.plate, ''));
  new.notes := trim(coalesce(new.notes, ''));
  new.exterior := trim(coalesce(new.exterior, ''));
  new.interior := trim(coalesce(new.interior, ''));
  new.vin := upper(trim(coalesce(new.vin, '')));
  if new.nickname = '' then
    raise exception 'Give the car a name.';
  end if;
  if char_length(new.nickname) > 80
     or char_length(new.model) > 80
     or char_length(new.plate) > 20
     or char_length(new.notes) > 500
     or char_length(new.exterior) > 40
     or char_length(new.interior) > 40
     or char_length(new.vin) > 17 then
    raise exception 'One of the car fields is too long.';
  end if;
  if new.home_showroom_id is null then
    raise exception 'Choose a home showroom.';
  end if;
  if tg_op = 'UPDATE' and new.active = false and old.status = 'out' and old.active = true then
    raise exception 'Check the car in before retiring it.';
  end if;

  if tg_op = 'INSERT' then
    new.status := 'in';
    new.current_showroom_id := new.home_showroom_id;
    new.current_place := '';
    new.current_purpose := null;
    new.current_holder_id := null;
    new.current_since := now();
    return new;
  end if;

  if writing is distinct from 'on' then
    new.status := old.status;
    new.current_place := old.current_place;
    new.current_purpose := old.current_purpose;
    new.current_holder_id := old.current_holder_id;
    new.current_since := old.current_since;
    new.current_showroom_id := old.current_showroom_id;
    if old.status = 'in'
       and old.current_holder_id is null
       and old.current_showroom_id is not distinct from old.home_showroom_id
       and new.home_showroom_id is distinct from old.home_showroom_id
       and not exists (select 1 from public.events e where e.car_id = old.id) then
      new.current_showroom_id := new.home_showroom_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists cars_guard on public.cars;
create trigger cars_guard
  before insert or update on public.cars
  for each row execute function public.cars_guard();

create or replace function public.refresh_car_location(p_car_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ev public.events%rowtype;
  home uuid;
begin
  select * into ev
  from public.events
  where car_id = p_car_id
    and happened_at <= now()
  order by happened_at desc, created_at desc
  limit 1;

  select home_showroom_id into home from public.cars where id = p_car_id;
  perform set_config('fleet.writing_location', 'on', true);

  if ev.id is null then
    update public.cars set
      status = 'in',
      current_showroom_id = home,
      current_place = '',
      current_purpose = null,
      current_holder_id = null,
      current_since = created_at
    where id = p_car_id;
  elsif ev.action = 'checkout' then
    update public.cars set
      status = 'out',
      current_showroom_id = ev.showroom_id,
      current_place = ev.place,
      current_purpose = ev.purpose,
      current_holder_id = ev.actor_id,
      current_since = ev.happened_at
    where id = p_car_id;
  else
    update public.cars set
      status = 'in',
      current_showroom_id = ev.showroom_id,
      current_place = case when ev.action = 'move' then ev.place else '' end,
      current_purpose = ev.purpose,
      current_holder_id = null,
      current_since = ev.happened_at
    where id = p_car_id;
  end if;
end;
$$;

create or replace function public.events_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  car_active boolean;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if new.actor_id is null then
    new.actor_id := auth.uid();
  end if;
  if not exists (select 1 from public.profiles where id = new.actor_id) then
    raise exception 'Choose a teammate.';
  end if;

  select active into car_active from public.cars where id = new.car_id;
  if car_active is null then
    raise exception 'Unknown car.';
  end if;
  if not car_active then
    raise exception 'This car is retired.';
  end if;

  new.place := trim(coalesce(new.place, ''));
  new.note := trim(coalesce(new.note, ''));
  if new.happened_at is null then
    new.happened_at := now();
  end if;
  if new.car_show_id is not null then
    if not exists (select 1 from public.car_shows where id = new.car_show_id) then
      raise exception 'Unknown car show.';
    end if;
    if new.action = 'checkin' then
      new.car_show_id := null;
    else
      new.showroom_id := null;
      if new.place = '' then
        select name into new.place from public.car_shows where id = new.car_show_id;
      end if;
    end if;
  end if;

  if new.action = 'checkin' then
    if new.showroom_id is null then
      raise exception 'Check in to a showroom.';
    end if;
    new.place := '';
    new.car_show_id := null;
  elsif new.action = 'move' then
    if new.showroom_id is null and new.place = '' then
      raise exception 'Move the car to a showroom, or name the car show.';
    end if;
    if new.showroom_id is not null then
      new.place := '';
      new.car_show_id := null;
    end if;
  elsif new.action = 'checkout' then
    if new.showroom_id is null and new.place = '' then
      raise exception 'Say where the car is going.';
    end if;
  else
    raise exception 'Unknown action.';
  end if;

  if char_length(new.place) > 120 then
    raise exception 'Place is too long.';
  end if;
  if char_length(new.note) > 500 then
    raise exception 'Note is too long.';
  end if;
  return new;
end;
$$;

drop trigger if exists events_before_insert on public.events;
create trigger events_before_insert
  before insert on public.events
  for each row execute function public.events_before_insert();

create or replace function public.events_before_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('fleet.deleting_car', true) = 'on' then
    return old;
  end if;
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  return old;
end;
$$;

drop trigger if exists events_before_delete on public.events;
create trigger events_before_delete
  before delete on public.events
  for each row execute function public.events_before_delete();

create or replace function public.events_before_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if not exists (select 1 from public.cars where id = new.car_id) then
    raise exception 'Unknown car.';
  end if;

  new.id := old.id;
  new.created_at := old.created_at;
  if new.actor_id is null then
    new.actor_id := old.actor_id;
  end if;
  if not exists (select 1 from public.profiles where id = new.actor_id) then
    raise exception 'Choose a teammate.';
  end if;
  new.place := trim(coalesce(new.place, ''));
  new.note := trim(coalesce(new.note, ''));
  if new.happened_at is null then
    new.happened_at := old.happened_at;
  end if;
  if new.car_show_id is not null then
    if not exists (select 1 from public.car_shows where id = new.car_show_id) then
      raise exception 'Unknown car show.';
    end if;
    if new.action = 'checkin' then
      new.car_show_id := null;
    else
      new.showroom_id := null;
      if new.place = '' then
        select name into new.place from public.car_shows where id = new.car_show_id;
      end if;
    end if;
  end if;

  if new.action = 'checkin' then
    if new.showroom_id is null then
      raise exception 'Check in to a showroom.';
    end if;
    new.place := '';
    new.car_show_id := null;
  elsif new.action = 'move' then
    if new.showroom_id is null and new.place = '' then
      raise exception 'Move the car to a showroom, or name the car show.';
    end if;
    if new.showroom_id is not null then
      new.place := '';
      new.car_show_id := null;
    end if;
  elsif new.action = 'checkout' then
    if new.showroom_id is null and new.place = '' then
      raise exception 'Say where the car is going.';
    end if;
  else
    raise exception 'Unknown action.';
  end if;

  if char_length(new.place) > 120 then
    raise exception 'Place is too long.';
  end if;
  if char_length(new.note) > 500 then
    raise exception 'Note is too long.';
  end if;
  return new;
end;
$$;

drop trigger if exists events_before_update on public.events;
create trigger events_before_update
  before update on public.events
  for each row execute function public.events_before_update();

create or replace function public.events_refresh()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('fleet.deleting_car', true) = 'on' then
    return coalesce(new, old);
  end if;
  perform public.refresh_car_location(coalesce(new.car_id, old.car_id));
  if tg_op = 'UPDATE' and old.car_id is distinct from new.car_id then
    perform public.refresh_car_location(old.car_id);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists events_refresh_insert on public.events;
create trigger events_refresh_insert
  after insert on public.events
  for each row execute function public.events_refresh();

drop trigger if exists events_refresh_delete on public.events;
create trigger events_refresh_delete
  after delete on public.events
  for each row execute function public.events_refresh();

drop trigger if exists events_refresh_update on public.events;
create trigger events_refresh_update
  after update on public.events
  for each row execute function public.events_refresh();

alter table public.showrooms enable row level security;
alter table public.profiles enable row level security;
alter table public.cars enable row level security;
alter table public.events enable row level security;

drop policy if exists showrooms_select on public.showrooms;
create policy showrooms_select on public.showrooms
  for select to authenticated using (true);
drop policy if exists showrooms_update on public.showrooms;
create policy showrooms_update on public.showrooms
  for update to authenticated using (true) with check (true);

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated with check (id = auth.uid());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists cars_select on public.cars;
create policy cars_select on public.cars
  for select to authenticated using (true);
drop policy if exists cars_insert on public.cars;
create policy cars_insert on public.cars
  for insert to authenticated with check (true);
drop policy if exists cars_update on public.cars;
create policy cars_update on public.cars
  for update to authenticated using (true) with check (true);

drop policy if exists events_select on public.events;
create policy events_select on public.events
  for select to authenticated using (true);
drop policy if exists events_insert on public.events;
create policy events_insert on public.events
  for insert to authenticated with check (true);
drop policy if exists events_delete on public.events;
create policy events_delete on public.events
  for delete to authenticated using (true);
drop policy if exists events_update on public.events;
create policy events_update on public.events
  for update to authenticated using (true) with check (true);

alter table public.car_shows enable row level security;
drop policy if exists car_shows_select on public.car_shows;
create policy car_shows_select on public.car_shows
  for select to authenticated using (true);
drop policy if exists car_shows_insert on public.car_shows;
create policy car_shows_insert on public.car_shows
  for insert to authenticated with check (true);
drop policy if exists car_shows_update on public.car_shows;
create policy car_shows_update on public.car_shows
  for update to authenticated using (true) with check (true);
drop policy if exists car_shows_delete on public.car_shows;
create policy car_shows_delete on public.car_shows
  for delete to authenticated using (true);

revoke all on public.showrooms from public, anon;
revoke all on public.profiles from public, anon;
revoke all on public.cars from public, anon;
revoke all on public.events from public, anon;
revoke all on public.car_shows from public, anon;
revoke all on public.car_latest from public, anon;

grant usage on schema public to authenticated;
grant select, update on public.showrooms to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.cars to authenticated;
grant select, insert, update, delete on public.events to authenticated;
grant select, insert, update, delete on public.car_shows to authenticated;
grant select on public.car_latest to authenticated;

-- Trigger functions stay executable. PostgREST cannot call them as normal RPCs.
-- refresh_car_location only runs from the event trigger, as the table owner.
revoke all on function public.refresh_car_location(uuid) from public, anon, authenticated;
grant execute on function public.refresh_car_location(uuid) to postgres;

create or replace function public.apply_due_locations()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  car uuid;
begin
  for car in select id from public.cars loop
    perform public.refresh_car_location(car);
  end loop;
end;
$$;

revoke all on function public.apply_due_locations() from public, anon;
grant execute on function public.apply_due_locations() to authenticated;

create or replace function public.delete_car(p_car_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if not exists (select 1 from public.cars where id = p_car_id) then
    raise exception 'Unknown car.';
  end if;
  perform set_config('fleet.deleting_car', 'on', true);
  delete from public.cars where id = p_car_id;
end;
$$;

revoke all on function public.delete_car(uuid) from public, anon;
grant execute on function public.delete_car(uuid) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.showrooms;
exception when undefined_object or duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.cars;
exception when undefined_object or duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.events;
exception when undefined_object or duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.car_shows;
exception when undefined_object or duplicate_object then null;
end $$;

update public.showrooms set name = 'TW' where name = 'Showroom 1';
update public.showrooms set name = 'SLY' where name = 'Showroom 2';
insert into public.showrooms (name, sort)
select 'TW', 1 where not exists (select 1 from public.showrooms where name = 'TW');
insert into public.showrooms (name, sort)
select 'SLY', 2 where not exists (select 1 from public.showrooms where name = 'SLY');

insert into public.cars (nickname, model, exterior, interior, plate, vin, kind, home_showroom_id)
select seed.nickname, seed.model, seed.exterior, seed.interior, seed.plate, seed.vin, 'demo', rooms.id
from (values
  ('TW', 'Model 3 D50 White', 'Model 3 D50', 'White', 'BLK', 'T-plate', 'LRW3F7FS1TC035983'),
  ('TW', 'Model 3 Performance Silver', 'Model 3 Performance', 'Silver', 'WHITE', 'T-plate', 'LRW3F7EV5TC967194'),
  ('TW', 'Model 3 RWD Silver', 'Model 3 RWD', 'Silver', 'BLK', 'T-plate', 'LRW3F7FS9SC653406'),
  ('TW', 'Model Y L Red', 'Model Y L', 'Red', 'White', 'VF1641', 'LRWYHCEK7TC545023'),
  ('TW', 'Model Y RWD Glacier', 'Model Y RWD', 'Glacier', 'BLK', 'VB9566', 'LRWYHCFJ3TC506855'),
  ('SLY', 'Model Y L Glacier', 'Model Y L', 'Glacier', 'white', 'VF1544', 'LRWYHCEK5TC545022'),
  ('SLY', 'Model Y L Black', 'Model Y L', 'Black', 'BLK', 'VF893', 'LRWYHCEK4TC563933'),
  ('SLY', 'Model 3 LR Grey', 'Model 3 LR', 'Grey', 'BLK', 'T-plate', 'LRW3F7EK6TC813096'),
  ('SLY', 'Model Y RWD White', 'Model Y RWD', 'White', 'Blk', 'VA8233', 'LRWYHCFJ5TC506887')
) as seed(showroom, nickname, model, exterior, interior, plate, vin)
join public.showrooms as rooms on rooms.name = seed.showroom
where not exists (select 1 from public.cars as existing where existing.vin = seed.vin);

notify pgrst, 'reload schema';
