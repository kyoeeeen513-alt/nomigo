alter table public.registrations
  add column if not exists sns_share_ok boolean not null default false;

comment on column public.registrations.sns_share_ok is
  '募集者が、匿名化した募集プロフィールをNomi Go公式SNSへ掲載することを明示的に許可したか。';

create table if not exists public.recruitment_admin_notifications (
  registration_id uuid primary key references public.registrations(id) on delete cascade,
  status text not null default 'processing' check (status in ('processing','sent','failed')),
  sent_count integer not null default 0 check (sent_count >= 0),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table public.recruitment_admin_notifications enable row level security;
revoke all on table public.recruitment_admin_notifications from anon, authenticated;

comment on table public.recruitment_admin_notifications is
  '新規募集の運営LINE通知を一度だけ送るための内部台帳。service_roleのみ利用する。';

create table if not exists public.recruitment_social_posts (
  registration_id uuid primary key references public.registrations(id) on delete cascade,
  posted_at timestamptz not null default now(),
  posted_by uuid references auth.users(id),
  posted_by_label text,
  created_at timestamptz not null default now()
);

alter table public.recruitment_social_posts enable row level security;
revoke all on table public.recruitment_social_posts from anon, authenticated;

comment on table public.recruitment_social_posts is
  'SNS掲載許可のある募集について、運営がXへ投稿した記録。service_roleのみ利用する。';
