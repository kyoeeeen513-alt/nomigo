-- Restores the one helper needed by the profiles.pay_member_id default.
-- The final function ACL lockdown revoked it from authenticated users, which
-- caused every new profile insert to fail before RLS could be evaluated.
grant execute on function public.gen_pay_member_id() to authenticated;
