-- マッチ成立LINEを既存の再送可能な通知キューに追加する。
-- 過去のマッチは送らず、このトリガー作成後の参加者追加だけを対象にする。

alter table public.match_followup_jobs
  drop constraint if exists match_followup_jobs_kind_check;

alter table public.match_followup_jobs
  add constraint match_followup_jobs_kind_check
  check (kind in ('match_created','initial_contact','unread_message','finish_prompt'));

create or replace function public.enqueue_match_created_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.match_followup_jobs(match_id,user_id,kind,dedupe_key)
  select new.match_id,new.user_id,'match_created',
         new.match_id::text||':'||new.user_id::text||':match_created'
  from public.profiles p
  where p.user_id=new.user_id
    and p.account_status='active'
    and p.line_user_id is not null
  on conflict(dedupe_key) do nothing;

  return new;
end
$$;

revoke all on function public.enqueue_match_created_notification() from public;
revoke all on function public.enqueue_match_created_notification() from anon;
revoke all on function public.enqueue_match_created_notification() from authenticated;
grant execute on function public.enqueue_match_created_notification() to service_role;

drop trigger if exists trg_enqueue_match_created_notification on public.match_members;
create trigger trg_enqueue_match_created_notification
after insert on public.match_members
for each row execute function public.enqueue_match_created_notification();
