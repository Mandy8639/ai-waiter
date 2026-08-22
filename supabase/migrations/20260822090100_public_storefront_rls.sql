-- Public, read-only storefront access for anonymous customers. These are
-- ADDITIVE policies — nothing here changes or narrows the existing
-- owner/manager/staff policies from Batch 2/3 (see
-- 20260821130400_core_rls_policies.sql and friends). A row is visible here
-- only when it's genuinely meant to be public: the restaurant, its
-- category, and (for items) the item itself are all active/available.
-- Inactive/unavailable data stays invisible to customers even though staff
-- can still see and manage it — same tables, different policies, same RLS
-- rule of "narrowest applicable policy wins."

create or replace function public.is_restaurant_publicly_active(target_restaurant_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.restaurants
    where id = target_restaurant_id
      and is_active = true
  )
$$;

comment on function public.is_restaurant_publicly_active(uuid) is
  'True if the restaurant exists and is active — the base condition for anything to be visible in the public storefront.';

create or replace function public.is_menu_item_publicly_visible(target_menu_item_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.menu_items mi
    join public.categories c on c.id = mi.category_id
    join public.restaurants r on r.id = mi.restaurant_id
    where mi.id = target_menu_item_id
      and mi.is_available = true
      and c.is_active = true
      and r.is_active = true
  )
$$;

comment on function public.is_menu_item_publicly_visible(uuid) is
  'True if a menu item, its category, and its restaurant are all active/available — used to scope public visibility of anything hanging off a menu item (modifiers, ingredient/allergen links).';

-- restaurants ---------------------------------------------------------

-- Unconditional (not scoped to is_active) — deliberately. The public
-- landing page needs to show an explicit "this restaurant is currently
-- unavailable" state for an inactive restaurant (see docs/security.md),
-- which means it needs to read the row at all. This table has no
-- staff-only/operational secret in it (that boundary lives in
-- restaurant_users and the other tables, which stay properly scoped below)
-- — a restaurant's own name/description/contact info isn't sensitive
-- regardless of its active status, the same way a storefront in
-- maintenance mode still shows its own name.
create policy "restaurants_select_public"
  on public.restaurants
  for select
  to anon, authenticated
  using (true);

-- categories ------------------------------------------------------------

create policy "categories_select_public"
  on public.categories
  for select
  to anon, authenticated
  using (is_active = true and public.is_restaurant_publicly_active(restaurant_id));

-- menu_items --------------------------------------------------------------

create policy "menu_items_select_public"
  on public.menu_items
  for select
  to anon, authenticated
  using (
    is_available = true
    and public.is_restaurant_publicly_active(restaurant_id)
    and exists (
      select 1 from public.categories c
      where c.id = menu_items.category_id and c.is_active = true
    )
  );

-- menu_item_modifiers / modifier_options -----------------------------------

create policy "menu_item_modifiers_select_public"
  on public.menu_item_modifiers
  for select
  to anon, authenticated
  using (public.is_menu_item_publicly_visible(menu_item_id));

create policy "modifier_options_select_public"
  on public.modifier_options
  for select
  to anon, authenticated
  using (
    is_available = true
    and exists (
      select 1 from public.menu_item_modifiers mim
      where mim.id = modifier_options.modifier_id
        and public.is_menu_item_publicly_visible(mim.menu_item_id)
    )
  );

-- ingredients / allergens (catalog rows) -----------------------------------

create policy "ingredients_select_public"
  on public.ingredients
  for select
  to anon, authenticated
  using (public.is_restaurant_publicly_active(restaurant_id));

create policy "allergens_select_public"
  on public.allergens
  for select
  to anon, authenticated
  using (public.is_restaurant_publicly_active(restaurant_id));

-- menu_item_ingredients / menu_item_allergens (the links customers actually query) --

create policy "menu_item_ingredients_select_public"
  on public.menu_item_ingredients
  for select
  to anon, authenticated
  using (public.is_menu_item_publicly_visible(menu_item_id));

create policy "menu_item_allergens_select_public"
  on public.menu_item_allergens
  for select
  to anon, authenticated
  using (public.is_menu_item_publicly_visible(menu_item_id));
