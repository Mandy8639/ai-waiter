-- Take EXECUTE away from `anon` (signed-out API callers) on the 44
-- database functions that have been pending review since 2026-09-19 and
-- that no signed-out page needs.
--
-- None of these was an open door. Each either checks its caller inside
-- (current_restaurant_role(), order_belongs_to_caller(), auth.uid()) and so
-- already refuses anon, or is a small read-only helper. Diners are not
-- affected: scanning a table QR code signs the phone in anonymously, which
-- is the `authenticated` role, not `anon`. This is defence in depth: a
-- function that later loses its caller check by mistake still can't be
-- reached by anyone holding only the publishable key.
--
-- Reviewed 2026-10-17 against the app's call sites and the RLS policies.
-- These stay anon-callable on purpose (see ANON_BY_DESIGN in
-- tests/integration/db/function-grants.test.ts):
--   get_table_by_token, count_recent_sessions_for_table
--       the QR scan route runs them before the anonymous sign-in
--   get_public_order_settings
--       the public menu and dish pages, viewable before any scan
--   is_menu_item_publicly_visible, is_restaurant_publicly_active
--       used by the {anon, authenticated} SELECT policies on the menu tables
--
-- EXECUTE is granted to authenticated and service_role explicitly before
-- it is revoked from PUBLIC. A function recreated by hand in the SQL editor
-- holds EXECUTE only through PUBLIC (see 20260919090000), so revoking
-- PUBLIC alone would take it from signed-in users too. Granting what they
-- already hold widens nothing.
--
-- One explicit grant/revoke pair per function, written out rather than
-- looped, so scripts/check-function-grants.ts can replay this file when it
-- compares the repository with production. None of these is overloaded.
-- Revoking a privilege that isn't held is a no-op, so this is safe to run
-- twice.

grant execute on function public.add_restaurant_staff_by_email(uuid,text,text) to authenticated, service_role;
revoke execute on function public.add_restaurant_staff_by_email(uuid,text,text) from public, anon;

grant execute on function public.assert_can_view_reports(uuid) to authenticated, service_role;
revoke execute on function public.assert_can_view_reports(uuid) from public, anon;

grant execute on function public.attach_payment_checkout_session(uuid,text) to authenticated, service_role;
revoke execute on function public.attach_payment_checkout_session(uuid,text) from public, anon;

grant execute on function public.attach_refund_stripe_id(uuid,text,boolean) to authenticated, service_role;
revoke execute on function public.attach_refund_stripe_id(uuid,text,boolean) from public, anon;

grant execute on function public.cancel_pending_refund(uuid) to authenticated, service_role;
revoke execute on function public.cancel_pending_refund(uuid) from public, anon;

grant execute on function public.cart_belongs_to_caller(uuid) to authenticated, service_role;
revoke execute on function public.cart_belongs_to_caller(uuid) from public, anon;

grant execute on function public.commit_menu_import(uuid) to authenticated, service_role;
revoke execute on function public.commit_menu_import(uuid) from public, anon;

grant execute on function public.confirm_menu_item_allergens(uuid,text[]) to authenticated, service_role;
revoke execute on function public.confirm_menu_item_allergens(uuid,text[]) from public, anon;

grant execute on function public.confirm_reservation_request(uuid,uuid) to authenticated, service_role;
revoke execute on function public.confirm_reservation_request(uuid,uuid) from public, anon;

grant execute on function public.confirmed_allergen_ids(uuid) to authenticated, service_role;
revoke execute on function public.confirmed_allergen_ids(uuid) from public, anon;

grant execute on function public.count_recent_reservation_requests(uuid,integer) to authenticated, service_role;
revoke execute on function public.count_recent_reservation_requests(uuid,integer) from public, anon;

grant execute on function public.create_reservation(uuid,uuid,text,text,text,integer,timestamp with time zone,text) to authenticated, service_role;
revoke execute on function public.create_reservation(uuid,uuid,text,text,text,integer,timestamp with time zone,text) from public, anon;

grant execute on function public.create_restaurant(text,text,text,text,text) to authenticated, service_role;
revoke execute on function public.create_restaurant(text,text,text,text,text) from public, anon;

grant execute on function public.current_restaurant_role(uuid) to authenticated, service_role;
revoke execute on function public.current_restaurant_role(uuid) from public, anon;

grant execute on function public.get_best_selling_items(uuid,timestamp with time zone,timestamp with time zone,integer) to authenticated, service_role;
revoke execute on function public.get_best_selling_items(uuid,timestamp with time zone,timestamp with time zone,integer) from public, anon;

grant execute on function public.get_kitchen_queue_ahead(uuid,timestamp with time zone) to authenticated, service_role;
revoke execute on function public.get_kitchen_queue_ahead(uuid,timestamp with time zone) from public, anon;

grant execute on function public.get_payment_history(uuid,timestamp with time zone,timestamp with time zone,integer,integer) to authenticated, service_role;
revoke execute on function public.get_payment_history(uuid,timestamp with time zone,timestamp with time zone,integer,integer) from public, anon;

grant execute on function public.get_public_payment_settings(uuid) to authenticated, service_role;
revoke execute on function public.get_public_payment_settings(uuid) from public, anon;

grant execute on function public.get_takings_by_method(uuid,timestamp with time zone,timestamp with time zone) to authenticated, service_role;
revoke execute on function public.get_takings_by_method(uuid,timestamp with time zone,timestamp with time zone) from public, anon;

grant execute on function public.get_takings_summary(uuid,timestamp with time zone,timestamp with time zone) to authenticated, service_role;
revoke execute on function public.get_takings_summary(uuid,timestamp with time zone,timestamp with time zone) from public, anon;

grant execute on function public.is_restaurant_manager_or_owner(uuid) to authenticated, service_role;
revoke execute on function public.is_restaurant_manager_or_owner(uuid) from public, anon;

grant execute on function public.is_restaurant_member(uuid) to authenticated, service_role;
revoke execute on function public.is_restaurant_member(uuid) from public, anon;

grant execute on function public.is_valid_order_status_transition(text,text) to authenticated, service_role;
revoke execute on function public.is_valid_order_status_transition(text,text) from public, anon;

grant execute on function public.is_valid_reservation_status_transition(text,text) to authenticated, service_role;
revoke execute on function public.is_valid_reservation_status_transition(text,text) from public, anon;

grant execute on function public.link_restaurant_payment_account(uuid,text) to authenticated, service_role;
revoke execute on function public.link_restaurant_payment_account(uuid,text) from public, anon;

grant execute on function public.merge_orders_into_ticket(uuid[],text) to authenticated, service_role;
revoke execute on function public.merge_orders_into_ticket(uuid[],text) from public, anon;

grant execute on function public.order_belongs_to_caller(uuid) to authenticated, service_role;
revoke execute on function public.order_belongs_to_caller(uuid) from public, anon;

grant execute on function public.order_status_rank(text) to authenticated, service_role;
revoke execute on function public.order_status_rank(text) from public, anon;

grant execute on function public.payment_refunded_total(uuid) to authenticated, service_role;
revoke execute on function public.payment_refunded_total(uuid) from public, anon;

grant execute on function public.platform_fee_for_payment(uuid,integer) to authenticated, service_role;
revoke execute on function public.platform_fee_for_payment(uuid,integer) from public, anon;

grant execute on function public.platform_fee_minor_units(uuid,integer) to authenticated, service_role;
revoke execute on function public.platform_fee_minor_units(uuid,integer) from public, anon;

grant execute on function public.recompute_order_status_from_groups(uuid) to authenticated, service_role;
revoke execute on function public.recompute_order_status_from_groups(uuid) from public, anon;

grant execute on function public.record_cash_payment(uuid[],numeric) to authenticated, service_role;
revoke execute on function public.record_cash_payment(uuid[],numeric) from public, anon;

grant execute on function public.request_reservation(uuid,text,text,text,integer,timestamp with time zone,text) to authenticated, service_role;
revoke execute on function public.request_reservation(uuid,text,text,text,integer,timestamp with time zone,text) from public, anon;

grant execute on function public.reverse_cash_payment(uuid,text) to authenticated, service_role;
revoke execute on function public.reverse_cash_payment(uuid,text) from public, anon;

grant execute on function public.role_can_transition_order(text,text,text) to authenticated, service_role;
revoke execute on function public.role_can_transition_order(text,text,text) from public, anon;

grant execute on function public.split_order_into_tickets(uuid,jsonb) to authenticated, service_role;
revoke execute on function public.split_order_into_tickets(uuid,jsonb) from public, anon;

grant execute on function public.start_order_payment(uuid,numeric) to authenticated, service_role;
revoke execute on function public.start_order_payment(uuid,numeric) from public, anon;

grant execute on function public.start_refund(uuid,numeric,text) to authenticated, service_role;
revoke execute on function public.start_refund(uuid,numeric,text) from public, anon;

grant execute on function public.submit_order(text,text) to authenticated, service_role;
revoke execute on function public.submit_order(text,text) from public, anon;

grant execute on function public.sync_restaurant_payment_account_status(uuid,boolean,boolean,boolean) to authenticated, service_role;
revoke execute on function public.sync_restaurant_payment_account_status(uuid,boolean,boolean,boolean) from public, anon;

grant execute on function public.transition_reservation_status(uuid,text) to authenticated, service_role;
revoke execute on function public.transition_reservation_status(uuid,text) from public, anon;

grant execute on function public.transition_ticket_group_status(uuid,text) to authenticated, service_role;
revoke execute on function public.transition_ticket_group_status(uuid,text) from public, anon;

grant execute on function public.update_reservation_details(uuid,text,text,text,integer,text) to authenticated, service_role;
revoke execute on function public.update_reservation_details(uuid,text,text,text,integer,text) from public, anon;
