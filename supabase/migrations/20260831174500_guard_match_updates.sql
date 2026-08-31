-- Participants may submit their own outcome, but may not rewrite match metadata.
create or replace function public.guard_matches_update()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  if not public.is_my_match(old.id) then
    raise exception 'このマッチを更新する権限がありません' using errcode='42501';
  end if;

  new.id:=old.id; new.area_id:=old.area_id; new.slot:=old.slot;
  new.mode:=old.mode; new.created_at:=old.created_at; new.timing:=old.timing;
  new.ticket_consumed:=old.ticket_consumed;

  if new.status is distinct from old.status then
    if old.status<>'confirmed' or new.status not in ('cancelled','no_show','completed') then
      raise exception '許可されないマッチ状態の変更です' using errcode='42501';
    end if;
  end if;
  if new.status='completed' and old.status<>'completed' then new.completed_at:=now();
  elsif new.completed_at is distinct from old.completed_at then new.completed_at:=old.completed_at;
  end if;

  if new.result_a_user_id is distinct from old.result_a_user_id then
    if old.result_a_user_id is not null or new.result_a_user_id<>auth.uid()
       or new.result_a not in ('completed','cancelled','no_show') then
      raise exception '許可されない結果の更新です' using errcode='42501';
    end if;
  elsif new.result_a is distinct from old.result_a then new.result_a:=old.result_a;
  end if;

  if new.result_b_user_id is distinct from old.result_b_user_id then
    if old.result_b_user_id is not null or new.result_b_user_id<>auth.uid()
       or new.result_b not in ('completed','cancelled','no_show')
       or new.result_b_user_id=new.result_a_user_id then
      raise exception '許可されない結果の更新です' using errcode='42501';
    end if;
  elsif new.result_b is distinct from old.result_b then new.result_b:=old.result_b;
  end if;

  if new.result_a is not null and new.result_b is not null then
    new.verdict:=case
      when new.result_a='completed' and new.result_b='completed' then 'normal'
      when new.result_a='cancelled' and new.result_b='cancelled' then 'both_cancelled'
      else 'needs_review' end;
  else new.verdict:=old.verdict;
  end if;

  if new.reminder_sent is distinct from old.reminder_sent
     and not (old.reminder_sent=false and new.reminder_sent=true) then
    new.reminder_sent:=old.reminder_sent;
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_matches_update on public.matches;
create trigger trg_guard_matches_update before update on public.matches
for each row execute function public.guard_matches_update();

drop policy if exists matches_update_own on public.matches;
create policy matches_update_own on public.matches for update to authenticated
using ((select public.is_my_match(id)))
with check ((select public.is_my_match(id)));

revoke execute on function public.guard_matches_update() from public,anon,authenticated;
grant execute on function public.guard_matches_update() to service_role;
