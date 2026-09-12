-- Preserve the original meeting terms and the proposal outcome for later
-- operational review. This records context only: it does not charge, suspend,
-- refund, or change ticket balances.

create table if not exists public.match_meeting_change_history (
  proposal_id uuid primary key,
  match_id uuid not null references public.matches(id) on delete cascade,
  proposed_by uuid not null,
  original_time timestamptz not null,
  original_place text not null,
  proposed_time timestamptz not null,
  proposed_place text not null,
  status text not null,
  responded_by uuid,
  proposed_at timestamptz not null,
  responded_at timestamptz,
  proposer_cancelled_after_decline_at timestamptz,
  constraint meeting_change_history_original_place_length
    check (char_length(original_place) between 1 and 100),
  constraint meeting_change_history_proposed_place_length
    check (char_length(proposed_place) between 1 and 100),
  constraint meeting_change_history_status
    check (status in ('pending','accepted','declined')),
  constraint meeting_change_history_response_complete check (
    (status='pending' and responded_by is null and responded_at is null)
    or
    (status in ('accepted','declined') and responded_by is not null and responded_at is not null)
  )
);

create index if not exists match_meeting_change_history_match_recent_idx
  on public.match_meeting_change_history(match_id, proposed_at desc);

alter table public.match_meeting_change_history enable row level security;
revoke all on table public.match_meeting_change_history from public, anon, authenticated;
grant select on table public.match_meeting_change_history to authenticated;

drop policy if exists match_members_read_meeting_change_history on public.match_meeting_change_history;
create policy match_members_read_meeting_change_history
on public.match_meeting_change_history for select to authenticated
using ((select auth.uid()) is not null and (select public.is_my_match(match_id)));

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

  insert into public.match_meeting_change_history(
    proposal_id,match_id,proposed_by,original_time,original_place,
    proposed_time,proposed_place,status,proposed_at
  ) values (
    v_pending_id,p_match_id,v_uid,v_plan.meeting_time,v_plan.meeting_place,
    p_meeting_time,btrim(p_meeting_place),'pending',now()
  );

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

  update public.match_meeting_change_history
  set status=case when p_accept then 'accepted' else 'declined' end,
      responded_by=v_uid,
      responded_at=now()
  where proposal_id=v_pending_id and status='pending';
  if not found then raise exception 'proposal_history_not_found'; end if;

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

create or replace function public.record_match_cancellation_context(p_match_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_proposal_id uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode='42501'; end if;
  if not exists (
    select 1 from public.match_members mm
    where mm.match_id=p_match_id and mm.user_id=v_uid
  ) then raise exception 'not_match_member' using errcode='42501'; end if;

  select h.proposal_id into v_proposal_id
  from public.match_meeting_change_history h
  where h.match_id=p_match_id
    and h.proposed_by=v_uid
    and h.status='declined'
  order by h.responded_at desc
  limit 1;

  if v_proposal_id is null then return false; end if;
  update public.match_meeting_change_history
  set proposer_cancelled_after_decline_at=coalesce(proposer_cancelled_after_decline_at,now())
  where proposal_id=v_proposal_id;
  return true;
end
$$;

revoke all on function public.propose_match_meeting_change(uuid,timestamptz,text) from public, anon, authenticated;
revoke all on function public.respond_match_meeting_change(uuid,boolean) from public, anon, authenticated;
revoke all on function public.record_match_cancellation_context(uuid) from public, anon, authenticated;
grant execute on function public.propose_match_meeting_change(uuid,timestamptz,text) to authenticated;
grant execute on function public.respond_match_meeting_change(uuid,boolean) to authenticated;
grant execute on function public.record_match_cancellation_context(uuid) to authenticated;
