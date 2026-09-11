-- Add atomic, predefined meeting messages without changing ordinary chat behavior.
-- The dedupe key matches the existing unread-message key, preventing a second
-- one-hour unread notification for the same quick message.

alter table public.match_followup_jobs
  drop constraint if exists match_followup_jobs_kind_check;
alter table public.match_followup_jobs
  add constraint match_followup_jobs_kind_check
  check (kind in (
    'match_created','initial_contact','unread_message','finish_prompt',
    'meeting_change_requested','meeting_change_accepted','meeting_change_declined',
    'meeting_quick_message'
  ));

create or replace function public.send_match_quick_message(p_match_id uuid, p_action text)
returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_content text;
  v_message public.messages;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode='42501'; end if;
  if not exists (
    select 1
    from public.match_members mm
    join public.matches m on m.id=mm.match_id
    where mm.match_id=p_match_id and mm.user_id=v_uid and m.status='confirmed'
  ) then raise exception 'not_active_match_member' using errcode='42501'; end if;

  v_content:=case p_action
    when 'arrived' then '到着しました。待ち合わせ場所にいます。'
    when 'late_5' then '5分ほど遅れます。申し訳ありません。'
    when 'late_10' then '10分ほど遅れます。申し訳ありません。'
    when 'cannot_find' then '待ち合わせ場所が分かりません。現在地や目印を教えてください。'
    when 'cancel_consult' then '予定の都合が悪くなったため、キャンセルについて相談させてください。'
    else null
  end;
  if v_content is null then raise exception 'invalid_quick_action' using errcode='22023'; end if;

  -- A double tap within 15 seconds returns the first message instead of duplicating it.
  select * into v_message
  from public.messages x
  where x.match_id=p_match_id and x.user_id=v_uid and x.content=v_content
    and x.created_at>now()-interval '15 seconds'
  order by x.created_at desc limit 1;

  if v_message.id is null then
    insert into public.messages(match_id,user_id,content)
    values(p_match_id,v_uid,v_content)
    returning * into v_message;
  end if;

  insert into public.match_followup_jobs(match_id,user_id,kind,source_message_id,dedupe_key)
  select p_match_id,mm.user_id,'meeting_quick_message',v_message.id,
         p_match_id::text||':'||mm.user_id::text||':unread:'||v_message.id::text
  from public.match_members mm
  join public.profiles p on p.user_id=mm.user_id
  where mm.match_id=p_match_id and mm.user_id<>v_uid
    and p.account_status='active' and p.line_user_id is not null
  on conflict(dedupe_key) do nothing;

  return v_message;
end
$$;

revoke all on function public.send_match_quick_message(uuid,text) from public, anon, authenticated;
grant execute on function public.send_match_quick_message(uuid,text) to authenticated;

