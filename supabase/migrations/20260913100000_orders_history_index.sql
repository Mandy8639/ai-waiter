-- Order history needs to read a date range of one restaurant's orders,
-- newest first. Today `orders` is indexed on restaurant_id, status,
-- table_id and customer_session_id — but not on created_at — so every
-- such query scans that restaurant's whole order set and sorts it.
--
-- The kitchen board got away with this because its 12-hour window keeps
-- the set small and it runs constantly on a warm cache. A history page
-- asking for "last 30 days" on a busy restaurant is a different shape of
-- question, and it is the query this feature exists to serve.
--
-- Composite and descending, matching menu_imports_restaurant_id_idx and
-- pos_outbox_by_restaurant, which answer the same "this tenant's rows,
-- newest first" question. The leading restaurant_id column means this
-- also serves plain per-restaurant lookups, so it does not duplicate
-- orders_restaurant_id_idx so much as supersede it for ordered reads.
create index orders_restaurant_created_at_idx
  on public.orders (restaurant_id, created_at desc);

comment on index public.orders_restaurant_created_at_idx is
  'Serves the order history page: one restaurant''s orders over a date range, newest first. See src/lib/orders/history.ts.';
