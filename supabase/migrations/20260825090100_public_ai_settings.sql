-- Extends get_public_order_settings() (20260823100150_public_order_settings.sql)
-- with the two AI-related toggles that have existed on restaurant_settings
-- since Batch 2 (allow_ai_recommendations, allow_upselling) but were never
-- consulted by anything until now. Same narrow-function pattern as before
-- — still not a broad SELECT policy on restaurant_settings, still only
-- the fields the public/customer flow actually needs. Additive: existing
-- callers destructuring accepting_orders/allow_customer_notes are
-- unaffected. `CREATE OR REPLACE` can't change a function's return columns
-- — Postgres requires a DROP first for that, hence the explicit drop below
-- (safe: grants are re-applied immediately after, so there's no window
-- where a real request could observe the function missing — one
-- migration, one transaction).
drop function if exists public.get_public_order_settings(uuid);

create function public.get_public_order_settings(target_restaurant_id uuid)
returns table (
  accepting_orders boolean,
  allow_customer_notes boolean,
  allow_ai_recommendations boolean,
  allow_upselling boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select accepting_orders, allow_customer_notes, allow_ai_recommendations, allow_upselling
  from public.restaurant_settings
  where restaurant_id = target_restaurant_id
$$;

comment on function public.get_public_order_settings(uuid) is
  'The only public read path onto restaurant_settings — returns the fields the customer-facing cart page and AI waiter need, never the full row. See docs/security.md#public-restaurant-menu-access.';

-- DROP removes prior grants along with the old function — re-applied here.
grant execute on function public.get_public_order_settings(uuid) to anon, authenticated;
