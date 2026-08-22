-- Composite unique target so cart_item_modifiers (added later this batch)
-- can enforce a tenant-scoped FK back to a modifier group — the same
-- pattern every other tenant-scoped FK in this schema uses (see
-- docs/database.md). Not needed when menu_item_modifiers was first created
-- (nothing referenced it via composite FK yet), so it's added here instead
-- of amending that already-applied migration.
alter table public.menu_item_modifiers
  add constraint menu_item_modifiers_restaurant_id_id_key unique (restaurant_id, id);
