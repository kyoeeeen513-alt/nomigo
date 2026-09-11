-- Keep meeting arrangements separate from core matching rows so this feature cannot
-- change matching, charging, or match completion behavior.

create table if not exists public.match_meeting_plans (
  match_id uuid primary key references public.matches(id) on delete cascade,
  meeting_time timestamptz not null,
  meeting_place text not null,
  pending_id uuid,
  pending_time timestamptz,
  pending_place text,
  pending_by uuid,
  pending_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint match_meeting_place_length check (char_length(meeting_place) between 1 and 100),
  constraint match_meeting_pending_complete check (
    (pending_id is null and pending_time is null and pending_place is null and pending_by is null and pending_at is null)
    or
    (pending_id is not null and pending_time is not null and pending_place is not null and pending_by is not null and pending_at is not null)
  ),
  constraint match_meeting_pending_place_length check (pending_place is null or char_length(pending_place) between 1 and 100)
);

alter table public.match_meeting_plans enable row level security;
revoke all on table public.match_meeting_plans from public, anon;
revoke all on table public.match_meeting_plans from authenticated;
grant select on table public.match_meeting_plans to authenticated;

drop policy if exists match_members_read_meeting_plan on public.match_meeting_plans;
create policy match_members_read_meeting_plan
on public.match_meeting_plans for select to authenticated
using ((select public.is_my_match(match_id)));

create or replace function public.default_match_meeting_time(p_slot text, p_created_at timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case
    when p_slot = '今すぐ' then p_created_at + interval '30 minutes'
    when p_slot ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      (((p_created_at at time zone 'Asia/Tokyo')::date + p_slot::time) at time zone 'Asia/Tokyo')
    else p_created_at + interval '30 minutes'
  end
$$;

create or replace function public.default_match_meeting_place(p_area_id text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_area_id
    when 'shinjuku' then 'JR新宿駅 東口交番前'
    when 'susukino' then '地下鉄すすきの駅 3番出口付近'
    else '対象エリア内（変更相談ができます）'
  end
$$;

create or replace function public.initialize_match_meeting_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.match_meeting_plans(match_id, meeting_time, meeting_place)
  values (
    new.id,
    public.default_match_meeting_time(new.slot, coalesce(new.created_at, now())),
    public.default_match_meeting_place(new.area_id)
  )
  on conflict (match_id) do nothing;
  return new;
end
$$;

revoke all on function public.initialize_match_meeting_plan() from public, anon, authenticated;
grant execute on function public.initialize_match_meeting_plan() to service_role;

drop trigger if exists trg_initialize_match_meeting_plan on public.matches;
create trigger trg_initialize_match_meeting_plan
after insert on public.matches
for each row execute function public.initialize_match_meeting_plan();

-- Existing active matches get a display plan, but no LINE notification is queued.
insert into public.match_meeting_plans(match_id, meeting_time, meeting_place)
select m.id,
       public.default_match_meeting_time(m.slot, coalesce(m.created_at, now())),
       public.default_match_meeting_place(m.area_id)
from public.matches m
on conflict (match_id) do nothing;

alter table public.match_followup_jobs
  drop constraint if exists match_followup_jobs_kind_check;
alter table public.match_followup_jobs
  add constraint match_followup_jobs_kind_check
  check (kind in (
    'match_created','initial_contact','unread_message','finish_prompt',
    'meeting_change_requested','meeting_change_accepted','meeting_change_declined'
  ));

create or replace function public.propose_match_meeting_change(
  p_match_id uuid,
  p_meeting_time timestamptz,
  p_meeting_place text
)
returns public.match_meeting_plans
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_plan public.match_meeting_plans;
  v_pending_id uuid := gen_random_uuid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode='42501'; end if;
  if not exists (
    select 1 from public.match_members mm
    join public.matches m on m.id=mm.match_id
    where mm.match_id=p_match_id and mm.user_id=v_uid and m.status='confirmed'
  ) then raise exception 'not_active_match_member' using errcode='42501'; end if;
  if p_meeting_time is null or p_meeting_time < now() - interval '5 minutes'
     or p_meeting_time > now() + interval '2 days' then
    raise exception 'invalid_meeting_time' using errcode='22023';
  end if;
  if nullif(btrim(p_meeting_place),'') is null or char_length(btrim(p_meeting_place)) > 100 then
    raise exception 'invalid_meeting_place' using errcode='22023';
  end if;

  select * into v_plan from public.match_meeting_plans where match_id=p_match_id for update;
  if v_plan.match_id is null then raise exception 'meeting_plan_not_found'; end if;
  if v_plan.pending_id is not null then raise exception 'proposal_already_pending'; end if;

  update public.match_meeting_plans
  set pending_id=v_pending_id,
      pending_time=p_meeting_time,
      pending_place=btrim(p_meeting_place),
      pending_by=v_uid,
      pending_at=now(),
      updated_at=now()
  where match_id=p_match_id
  returning * into v_plan;
  insert into public.match_followup_jobs(match_id,user_id,kind,dedupe_key)
  select p_match_id,mm.user_id,'meeting_change_requested',
         p_match_id::text||':'||mm.user_id::text||':meeting_change_requested:'||v_pending_id::text
  from public.match_members mm
  join public.profiles p on p.user_id=mm.user_id
  where mm.match_id=p_match_id and mm.user_id<>v_uid
    and p.account_status='active' and p.line_user_id is not null
  on conflict(dedupe_key) do nothing;
  return v_plan;
end
$$;

create or replace function public.respond_match_meeting_change(p_match_id uuid, p_accept boolean)
returns public.match_meeting_plans
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_plan public.match_meeting_plans;
  v_pending_id uuid;
  v_kind text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode='42501'; end if;
  if p_accept is null then raise exception 'invalid_response' using errcode='22023'; end if;

  select * into v_plan from public.match_meeting_plans where match_id=p_match_id for update;
  if v_plan.match_id is null or v_plan.pending_id is null then raise exception 'proposal_not_found'; end if;
  if v_plan.pending_by=v_uid then raise exception 'proposer_cannot_respond' using errcode='42501'; end if;
  if not exists (
    select 1 from public.match_members mm join public.matches m on m.id=mm.match_id
    where mm.match_id=p_match_id and mm.user_id=v_uid and m.status='confirmed'
  ) then raise exception 'not_active_match_member' using errcode='42501'; end if;

  v_pending_id:=v_plan.pending_id;
  v_kind:=case when p_accept then 'meeting_change_accepted' else 'meeting_change_declined' end;

  update public.match_meeting_plans
  set meeting_time=case when p_accept then pending_time else meeting_time end,
      meeting_place=case when p_accept then pending_place else meeting_place end,
      pending_id=null,pending_time=null,pending_place=null,pending_by=null,pending_at=null,
      updated_at=now()
  where match_id=p_match_id
  returning * into v_plan;

  insert into public.match_followup_jobs(match_id,user_id,kind,dedupe_key)
  select p_match_id,mm.user_id,v_kind,
         p_match_id::text||':'||mm.user_id::text||':'||v_kind||':'||v_pending_id::text
  from public.match_members mm
  join public.profiles p on p.user_id=mm.user_id
  where mm.match_id=p_match_id and mm.user_id<>v_uid
    and p.account_status='active' and p.line_user_id is not null
  on conflict(dedupe_key) do nothing;
  return v_plan;
end
$$;

revoke all on function public.propose_match_meeting_change(uuid,timestamptz,text) from public, anon, authenticated;
revoke all on function public.respond_match_meeting_change(uuid,boolean) from public, anon, authenticated;
grant execute on function public.propose_match_meeting_change(uuid,timestamptz,text) to authenticated;
grant execute on function public.respond_match_meeting_change(uuid,boolean) to authenticated;
