-- 「今すぐ」は募集開始から60分間のまま維持する。
-- 時間指定は開始時刻の30分前で受付を終了し、締切後の登録もDB側で拒否する。
create or replace function public.set_registration_expiry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  jst_now timestamptz := now();
  slot_hour int;
  slot_time timestamptz;
begin
  if new.slot is null or new.slot = '今すぐ' then
    new.expires_at := jst_now + interval '60 minutes';
  else
    slot_hour := nullif(regexp_replace(new.slot, '[^0-9].*$', ''), '')::int;
    if slot_hour is null then
      new.expires_at := jst_now + interval '60 minutes';
    else
      slot_time := ((jst_now at time zone 'Asia/Tokyo')::date
                    + make_interval(hours => slot_hour)) at time zone 'Asia/Tokyo';

      if slot_time - interval '30 minutes' <= jst_now then
        raise exception '選択した時間の募集受付は終了しています'
          using errcode = '22023';
      end if;

      new.expires_at := slot_time - interval '30 minutes';
    end if;
  end if;
  return new;
end;
$$;
