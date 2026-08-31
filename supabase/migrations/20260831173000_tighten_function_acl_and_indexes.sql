-- Make the browser RPC surface explicit and add missing foreign-key indexes.
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.peek_pair_invite(text) to anon,authenticated;
grant execute on function public.accept_pair_invite(text) to authenticated;
grant execute on function public.cancel_pair_invite() to authenticated;
grant execute on function public.count_new_candidates() to authenticated;
grant execute on function public.create_pair_invite() to authenticated;
grant execute on function public.expire_stale_registrations() to authenticated;
grant execute on function public.finalize_match(uuid) to authenticated;
grant execute on function public.get_candidate_profile(uuid) to authenticated;
grant execute on function public.get_feed_profile(uuid) to authenticated;
grant execute on function public.get_match_partners(uuid) to authenticated;
grant execute on function public.get_my_first_match_for_affiliate() to authenticated;
grant execute on function public.get_my_last_payment_result() to authenticated;
grant execute on function public.get_past_partner_ids() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_current_user_blacklisted() to authenticated;
grant execute on function public.is_my_match(uuid) to authenticated;
grant execute on function public.my_pair_status() to authenticated;
grant execute on all functions in schema public to service_role;

alter function public.touch_project_status() set search_path=public;
alter function public.try_match(text,text,text) set search_path=public;
alter function public.update_user_stats_on_review() set search_path=public;

drop index if exists public.match_members_uniq;
drop index if exists public.uniq_profiles_line_user_id;

create index if not exists blocks_blocked_id_idx on public.blocks(blocked_id);
create index if not exists credix_notify_logs_matched_payment_id_idx on public.credix_notify_logs(matched_payment_id);
create index if not exists inquiries_user_id_idx on public.inquiries(user_id);
create index if not exists matches_area_id_idx on public.matches(area_id);
create index if not exists messages_match_id_idx on public.messages(match_id);
create index if not exists messages_user_id_idx on public.messages(user_id);
create index if not exists penalties_affected_user_id_idx on public.penalties(affected_user_id);
create index if not exists penalties_charged_user_id_idx on public.penalties(charged_user_id);
create index if not exists penalties_payment_id_idx on public.penalties(payment_id);
create index if not exists refunds_user_id_idx on public.refunds(user_id);
create index if not exists registrations_area_id_idx on public.registrations(area_id);
create index if not exists registrations_match_id_idx on public.registrations(match_id);
create index if not exists registrations_partner_user_id_idx on public.registrations(partner_user_id);
create index if not exists reports_match_id_idx on public.reports(match_id);
create index if not exists reports_reported_id_idx on public.reports(reported_id);
create index if not exists reports_reporter_id_idx on public.reports(reporter_id);
create index if not exists reviews_reviewee_id_idx on public.reviews(reviewee_id);
create index if not exists reviews_reviewer_id_idx on public.reviews(reviewer_id);
create index if not exists ticket_ledger_payment_id_idx on public.ticket_ledger(payment_id);
