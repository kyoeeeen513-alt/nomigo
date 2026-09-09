create table if not exists public.recruitment_user_notifications (
  registration_id uuid primary key references public.registrations(id) on delete cascade,
  status text not null default 'processing'
    check (status in ('processing','sent','partial','failed')),
  target_count integer not null default 0 check (target_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists public.recruitment_user_notification_recipients (
  registration_id uuid not null references public.registrations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('sent','failed')),
  attempted_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (registration_id,user_id)
);

create index if not exists recruitment_user_notification_recipients_daily_idx
  on public.recruitment_user_notification_recipients (user_id,sent_at)
  where status='sent';

alter table public.recruitment_user_notifications enable row level security;
alter table public.recruitment_user_notification_recipients enable row level security;

revoke all on table public.recruitment_user_notifications from anon, authenticated;
revoke all on table public.recruitment_user_notification_recipients from anon, authenticated;

comment on table public.recruitment_user_notifications is
  'Admin-triggered LINE recruitment notification summary. Never sent automatically.';
comment on table public.recruitment_user_notification_recipients is
  'Per-recipient delivery result used for duplicate and once-per-JST-day prevention.';
