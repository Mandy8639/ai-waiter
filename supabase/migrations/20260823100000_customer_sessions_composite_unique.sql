-- Batch 4 didn't need this (nothing referenced customer_sessions via a
-- tenant-scoped composite FK yet) — Batch 5's `orders` table does, the same
-- way `carts`/`cart_items` reference `customer_sessions`/`tables`. Same
-- pattern as 20260822090150_menu_item_modifiers_composite_unique.sql.
alter table public.customer_sessions
  add constraint customer_sessions_restaurant_id_id_key unique (restaurant_id, id);
