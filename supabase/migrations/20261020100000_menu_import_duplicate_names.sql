-- Importing a menu whose dishes share a name failed outright (found
-- 2026-10-18 on a real 249-dish import): commit_menu_import() made each
-- dish's slug from its name alone, so "Chilli Paneer" as a $7 appetizer and
-- a $17 entree, or "Jeera Rice" under two rice sections, collided on
-- menu_items_unique_slug_per_restaurant. The whole import rolled back with
-- "Another menu import already uses that value". Re-importing onto a menu
-- that already has a dish of that name failed the same way, and a name
-- with no ASCII letters or digits made an empty slug.
--
-- Same function as 20260904120000_menu_imports.sql, except the slug: the
-- next free "-2", "-3" is used, and "item" stands in for an empty one.
-- Both dishes are kept: two sections listing a dish at two prices are two
-- things the restaurant sells, and the reviewer already saw both.
-- (CREATE OR REPLACE keeps the grants from 20261017090000.)

create or replace function public.commit_menu_import(p_import_id uuid)
returns table (categories_created integer, items_created integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_status text;
  v_unpriced integer;
  v_cats integer := 0;
  v_items integer := 0;
  v_row record;
  v_category_id uuid;
  v_next_order integer;
  v_base_slug text;
  v_slug text;
  v_suffix integer;
begin
  select restaurant_id, status into v_restaurant_id, v_status
  from public.menu_imports where id = p_import_id;

  if not found then
    raise exception 'MENU_IMPORT_NOT_FOUND';
  end if;

  -- SECURITY DEFINER bypasses RLS, so the caller's right to write this
  -- restaurant's price list is checked explicitly rather than assumed.
  if not public.is_restaurant_manager_or_owner(v_restaurant_id) then
    raise exception 'MENU_IMPORT_FORBIDDEN';
  end if;

  if v_status = 'committed' then
    -- Not an error worth alarming anyone with, but it must not run twice:
    -- a second run would duplicate every item.
    raise exception 'MENU_IMPORT_ALREADY_COMMITTED';
  end if;

  if v_status <> 'review' then
    raise exception 'MENU_IMPORT_NOT_READY';
  end if;

  -- The rule the nullable price column exists to enforce. A board that
  -- gave no price cannot be silently imported at 0.00 — someone has to
  -- supply the real one, or exclude the row.
  select count(*) into v_unpriced
  from public.menu_import_items
  where import_id = p_import_id and include = true and price is null;

  if v_unpriced > 0 then
    raise exception 'MENU_IMPORT_UNPRICED_ITEMS';
  end if;

  for v_row in
    select category_name, name, price, display_order
    from public.menu_import_items
    where import_id = p_import_id and include = true
    order by display_order, name
  loop
    select id into v_category_id
    from public.categories
    where restaurant_id = v_restaurant_id and name = v_row.category_name;

    if v_category_id is null then
      select coalesce(max(display_order), 0) + 1 into v_next_order
      from public.categories where restaurant_id = v_restaurant_id;

      insert into public.categories (restaurant_id, name, display_order)
      values (v_restaurant_id, v_row.category_name, v_next_order)
      returning id into v_category_id;

      v_cats := v_cats + 1;
    end if;

    -- Slug is derived here rather than trusted from the draft: it is
    -- structural, not something a reviewer should be able to mistype into
    -- a collision. A name already used (the same dish in two sections, or
    -- a dish already on the menu) gets the next free "-2", "-3"; a name
    -- with no letters or digits to work from becomes "item".
    v_base_slug := nullif(
      trim(both '-' from regexp_replace(lower(v_row.name), '[^a-z0-9]+', '-', 'g')),
      ''
    );
    v_base_slug := left(coalesce(v_base_slug, 'item'), 80);
    v_base_slug := trim(both '-' from v_base_slug);
    v_slug := v_base_slug;
    v_suffix := 1;
    while exists (
      select 1 from public.menu_items
      where restaurant_id = v_restaurant_id and slug = v_slug
    ) loop
      v_suffix := v_suffix + 1;
      v_slug := v_base_slug || '-' || v_suffix;
    end loop;

    insert into public.menu_items (
      restaurant_id, category_id, name, slug, price, display_order
    )
    values (
      v_restaurant_id,
      v_category_id,
      v_row.name,
      v_slug,
      v_row.price,
      v_row.display_order
    );

    v_items := v_items + 1;
  end loop;

  update public.menu_imports
  set status = 'committed', error = null
  where id = p_import_id;

  categories_created := v_cats;
  items_created := v_items;
  return next;
end;
$$;
