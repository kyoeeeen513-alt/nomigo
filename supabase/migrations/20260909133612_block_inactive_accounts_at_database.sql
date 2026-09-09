-- A withdrawn/banned browser can retain a short-lived access token even after
-- its refresh session is revoked. Reject every Data API request for such an
-- account before PostgREST runs a table query or RPC. Profiles without a row
-- are allowed so new registration continues to work.
create schema if not exists private;

create or replace function private.enforce_active_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
begin
  if v_user_id is null then
    return;
  end if;

  select p.account_status
    into v_status
    from public.profiles p
   where p.user_id = v_user_id;

  if found and coalesce(v_status, 'active') <> 'active' then
    raise insufficient_privilege
      using message = 'account_inactive:' || v_status;
  end if;
end;
$$;

revoke all on function private.enforce_active_account() from public;
revoke all on function private.enforce_active_account() from anon;
revoke all on function private.enforce_active_account() from authenticated;
-- PostgREST runs the hook after switching to the request role, so each API
-- role needs permission to execute it. The private schema is not exposed by
-- the Data API, therefore this does not create a callable RPC endpoint.
grant usage on schema private to authenticator, anon, authenticated, service_role;
grant execute on function private.enforce_active_account() to authenticator, anon, authenticated, service_role;

alter role authenticator
  set pgrst.db_pre_request = 'private.enforce_active_account';

notify pgrst, 'reload config';

-- Storage and Realtime do not use PostgREST's pre-request hook. Restrictive
-- policies add an account-state check on top of the existing ownership rules.
create policy active_accounts_only
on storage.objects
as restrictive
for all
to authenticated
using (
  exists (
    select 1 from public.profiles p
     where p.user_id = (select auth.uid())
       and coalesce(p.account_status, 'active') = 'active'
  )
)
with check (
  exists (
    select 1 from public.profiles p
     where p.user_id = (select auth.uid())
       and coalesce(p.account_status, 'active') = 'active'
  )
);

-- Keep the profile SELECT available only conceptually; PostgREST blocks the
-- request first, while this also protects direct database/API update paths.
create policy active_accounts_profile_update
on public.profiles
as restrictive
for update
to authenticated
using (coalesce(account_status, 'active') = 'active')
with check (coalesce(account_status, 'active') = 'active');

create policy active_accounts_profile_delete
on public.profiles
as restrictive
for delete
to authenticated
using (coalesce(account_status, 'active') = 'active');