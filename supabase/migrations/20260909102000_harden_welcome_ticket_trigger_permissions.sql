-- Trigger functions are invoked internally by PostgreSQL.
-- Removing API-facing EXECUTE does not disable the profile approval trigger.
revoke execute on function public.grant_welcome_ticket_on_approve() from public;
revoke execute on function public.grant_welcome_ticket_on_approve() from anon;
revoke execute on function public.grant_welcome_ticket_on_approve() from authenticated;
