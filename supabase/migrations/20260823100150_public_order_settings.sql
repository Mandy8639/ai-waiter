-- restaurant_settings has no public SELECT policy (it's member-only, see
-- 20260821130500_restaurant_settings.sql) — most of it is genuinely
-- internal (allow_ai_recommendations, allow_upselling, max_order_items).
-- The customer-facing cart page still needs to know two booleans before
-- showing a "Place order" button: is the restaurant currently taking new
-- orders, and does it want customer notes. Rather than adding a broad
-- public SELECT policy that exposes the whole settings row, this follows
-- get_table_by_token()'s established pattern (20260822090000_table_public_tokens.sql):
-- a narrow SECURITY DEFINER function returning only what the public flow
-- actually needs.
create or replace function public.get_public_order_settings(target_restaurant_id uuid)
returns table (
  accepting_orders boolean,
  allow_customer_notes boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select accepting_orders, allow_customer_notes
  from public.restaurant_settings
  where restaurant_id = target_restaurant_id
$$;

comment on function public.get_public_order_settings(uuid) is
  'The only public read path onto restaurant_settings — returns just the two fields the customer-facing cart page needs, never the full row. See docs/security.md#public-restaurant-menu-access.';

grant execute on function public.get_public_order_settings(uuid) to anon, authenticated;
