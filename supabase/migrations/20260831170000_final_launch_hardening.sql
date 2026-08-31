-- Final launch hardening. Applied to production on 2026-08-31.

insert into public.app_settings(key, bool_value, note)
values ('ticket_sales_open', false, 'CREDIX production activation switch')
on conflict (key) do update
set bool_value = excluded.bool_value,
    note = excluded.note,
    updated_at = now();

alter table public.blacklist add column if not exists real_name text;
alter table public.blacklist add column if not exists birthdate date;
alter table public.blacklist add column if not exists line_user_id text;

do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.blacklist'::regclass
      and contype = 'f'
      and conkey = array[(select attnum from pg_attribute
                         where attrelid='public.blacklist'::regclass and attname='user_id')]
  loop
    execute format('alter table public.blacklist drop constraint %I', r.conname);
  end loop;
end $$;

create index if not exists blacklist_real_name_birthdate_idx
  on public.blacklist(lower(btrim(real_name)), birthdate)
  where real_name is not null and birthdate is not null;
create index if not exists blacklist_line_user_id_idx
  on public.blacklist(line_user_id) where line_user_id is not null;

create or replace function public.populate_blacklist_identity()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if exists (select 1 from public.profiles p where p.user_id = new.user_id) then
    select coalesce(new.real_name,p.real_name),
           coalesce(new.birthdate,p.birthdate),
           coalesce(new.line_user_id,p.line_user_id)
      into new.real_name,new.birthdate,new.line_user_id
      from public.profiles p where p.user_id=new.user_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_populate_blacklist_identity on public.blacklist;
create trigger trg_populate_blacklist_identity
before insert or update on public.blacklist
for each row execute function public.populate_blacklist_identity();

update public.blacklist b
set real_name=coalesce(b.real_name,p.real_name),
    birthdate=coalesce(b.birthdate,p.birthdate),
    line_user_id=coalesce(b.line_user_id,p.line_user_id)
from public.profiles p where p.user_id=b.user_id;

create or replace function public.reject_blacklisted_profile()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if exists (
    select 1 from public.blacklist b
    where (b.expires_at is null or b.expires_at > now())
      and (b.user_id=new.user_id or (
        b.real_name is not null and b.birthdate is not null
        and lower(btrim(b.real_name))=lower(btrim(new.real_name))
        and b.birthdate=new.birthdate
      ))
  ) then
    raise exception 'blacklisted_identity: このアカウントの利用を制限しています'
      using errcode='42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_b_reject_blacklisted_profile on public.profiles;
create trigger trg_b_reject_blacklisted_profile
before insert on public.profiles
for each row execute function public.reject_blacklisted_profile();

create or replace function public.is_current_user_blacklisted()
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from public.blacklist b
    left join public.profiles p on p.user_id=auth.uid()
    where auth.uid() is not null
      and (b.expires_at is null or b.expires_at > now())
      and (b.user_id=auth.uid() or
           (p.line_user_id is not null and b.line_user_id=p.line_user_id))
  );
$$;

create unique index if not exists profiles_line_link_code_unique
  on public.profiles(line_link_code) where line_link_code is not null;

create or replace function public.guard_user_stats_insert()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.user_id:=auth.uid(); new.rating_avg:=0; new.rating_count:=0;
    new.match_count:=0; new.cancel_count:=0; new.cancel_rate:=0;
    new.is_good_user:=false; new.updated_at:=now();
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_user_stats_insert on public.user_stats;
create trigger trg_guard_user_stats_insert before insert on public.user_stats
for each row execute function public.guard_user_stats_insert();

create or replace function public.get_feed_profile(p_user_id uuid)
returns table(job text,tags jsonb)
language sql stable security definer set search_path=public as $$
  select p.job,p.tags from public.profiles p
  where p.user_id=p_user_id and auth.uid() is not null
    and exists (
      select 1 from public.registrations target
      join public.profiles me on me.user_id=auth.uid()
      where target.user_id=p_user_id and target.status='waiting'
        and (target.expires_at is null or target.expires_at>now())
        and target.gender<>me.gender
    );
$$;

create or replace function public.get_candidate_profile(p_user_id uuid)
returns table(user_id uuid,nickname text,age integer,gender text,photo_url text,
              job text,smoke text,alcohol integer,tags jsonb,verified_level integer,
              id_verify_status text)
language sql stable security definer set search_path=public as $$
  select p.user_id,p.nickname,p.age,p.gender,p.photo_url,p.job,p.smoke,p.alcohol,
         p.tags,p.verified_level,p.id_verify_status
  from public.profiles p where p.user_id=p_user_id and auth.uid() is not null
    and exists (
      select 1 from public.registrations mine
      join public.registrations target on target.user_id=p_user_id
       and target.area_id=mine.area_id
       and coalesce(target.mode,'1v1')=coalesce(mine.mode,'1v1')
       and target.gender<>mine.gender
       and target.status in ('waiting','processing')
       and (target.expires_at is null or target.expires_at>now())
      where mine.user_id=auth.uid()
        and mine.status in ('waiting','processing')
        and (mine.expires_at is null or mine.expires_at>now())
    );
$$;

create or replace function public.get_match_partners(p_match_id uuid)
returns table(user_id uuid,nickname text,age integer,gender text,photo_url text,
              job text,smoke text,alcohol integer,tags jsonb,verified_level integer,
              id_verify_status text)
language sql stable security definer set search_path=public as $$
  select p.user_id,p.nickname,p.age,p.gender,p.photo_url,p.job,p.smoke,p.alcohol,
         p.tags,p.verified_level,p.id_verify_status
  from public.registrations r join public.profiles p on p.user_id=r.user_id
  where r.match_id=p_match_id and auth.uid() is not null
    and exists (select 1 from public.registrations me
                where me.match_id=p_match_id and me.user_id=auth.uid());
$$;

create or replace function public.log_age_verification()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if tg_op='UPDATE' and new.id_verify_status is not distinct from old.id_verify_status then
    return new;
  end if;
  if tg_op='UPDATE' and auth.uid() is null
     and new.id_verify_status in ('approved','rejected') then
    return new;
  end if;
  begin
    insert into public.age_verification_logs(
      user_id,event,old_status,new_status,birthdate,age_at_check,
      id_photo_url,face_photo_url,actor_id,actor_is_admin
    ) values (
      new.user_id,
      case when tg_op='INSERT' then 'registered'
           when new.id_verify_status='approved' then 'approved'
           when new.id_verify_status='rejected' then 'rejected'
           when new.id_verify_status='pending' then 'submitted'
           else coalesce(new.id_verify_status,'unknown') end,
      case when tg_op='UPDATE' then old.id_verify_status else null end,
      new.id_verify_status,new.birthdate,
      case when new.birthdate is not null
           then date_part('year',age(current_date,new.birthdate))::int end,
      new.id_photo_url,new.face_photo_url,auth.uid(),coalesce(public.is_admin(),false)
    );
  exception when others then null;
  end;
  return new;
end $$;

drop policy if exists matches_insert_authed on public.matches;
revoke insert on public.matches from anon,authenticated;
revoke all on public.blacklist,public.age_verification_logs,public.app_settings,
  public.email_verified_users,public.project_status from anon,authenticated;

