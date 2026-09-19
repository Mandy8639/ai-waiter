-- Hotfix: take EXECUTE away from `anon` on functions no signed-out caller
-- should ever reach.
--
-- On Supabase, every function a migration creates in `public` is granted
-- EXECUTE to anon, authenticated and service_role by the platform's default
-- privileges — not only to PUBLIC. The migrations that created these
-- functions revoked from PUBLIC (and, for the webhook functions, from
-- authenticated) but never from anon, so all of them were callable through
-- the API by anyone holding the anon key, which ships in the website.
--
-- The serious ones are the four webhook-only functions. They carry no caller
-- check of their own — being unreachable was their protection — so, for
-- example, a diner who read their own Checkout Session id from the Stripe
-- URL could have marked their order paid without paying.
--
-- Found 2026-09-19 when the integration harness began mirroring Supabase's
-- default function privileges. The four webhook revokes were applied to
-- production by hand in the SQL editor the same day (anon_can_execute
-- verified false), and read-only checks found no sign of abuse: no card
-- payment marked succeeded without a Stripe payment intent, no subscription
-- rows. This migration makes the repository match production so a rebuild
-- cannot bring the hole back, and closes the same gap on three more
-- functions whose tests expect anon to be refused.
--
-- Every statement is idempotent: revoking a privilege that is not held is a
-- no-op, so running this after the manual fix is safe.
--
-- Callers checked before revoking — none runs as anon:
--   mark_order_payment_succeeded / _failed, mark_refund_settled
--       src/app/api/webhooks/stripe/route.ts (service_role client)
--   record_restaurant_subscription
--       src/app/api/webhooks/stripe/platform/route.ts (service_role client)
--   count_recent_orders_for_session
--       src/lib/orders/rate-limit-core.ts, behind requireActiveCustomerSession()
--       (a diner's anonymous-auth session is the `authenticated` role)
--   transition_order_status
--       src/lib/orders/transition.ts (signed-in staff)
--   get_restaurant_staff
--       src/app/dashboard/staff/page.tsx (signed-in members)

-- Webhook-only: callable by service_role and nobody else.
revoke execute on function public.mark_order_payment_succeeded(text, text) from public, anon, authenticated;
revoke execute on function public.mark_order_payment_failed(text, text) from public, anon, authenticated;
revoke execute on function public.mark_refund_settled(text, text) from public, anon, authenticated;
revoke execute on function public.record_restaurant_subscription(
  uuid, uuid, text, text, text, timestamptz, boolean
) from public, anon, authenticated;

-- Signed-in callers only; each still checks its caller inside.
revoke execute on function public.count_recent_orders_for_session(uuid, integer) from anon;
revoke execute on function public.transition_order_status(uuid, text) from anon;
revoke execute on function public.get_restaurant_staff(uuid) from anon;
