-- Square, phase 1: connect a restaurant's Square account and import its
-- menu. Builds on the seam in 20260908100000_pos_integration_seam.sql.
--
-- Credentials. The seam kept tokens out of Postgres on purpose and said
-- they belong in the deployment's secret store. That works for one
-- deployment-wide key; it cannot work for OAuth, where every restaurant
-- that clicks "Connect Square" gets its own access and refresh token at
-- runtime. So tokens do live in a table, under three rules that keep the
-- seam's reasons intact:
--
--   1. Only ciphertext is stored. The app encrypts with AES-256-GCM under
--      POS_TOKEN_ENCRYPTION_KEY, which lives in the deployment's secret
--      store, never here. A dump or a restored backup holds nothing usable
--      on its own.
--   2. No RLS policy at all, and no table grants to anon or authenticated.
--      Only the service key can read or write a row; no signed-in owner,
--      let alone a kitchen login, can select a token.
--   3. One row per restaurant, deleted on disconnect.

create table public.pos_credentials (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  provider text not null,
  -- What the POS calls the business behind the token (Square's merchant id).
  merchant_id text not null,
  access_token_enc text not null,
  refresh_token_enc text,
  -- When the access token stops working. Square access tokens last 30
  -- days; the app refreshes well before this.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pos_credentials_provider_valid
    check (char_length(provider) between 1 and 60)
);

comment on table public.pos_credentials is
  'Encrypted OAuth tokens for a restaurant''s POS. Ciphertext only (AES-256-GCM, key outside the database). No RLS policies and no grants: service key only.';

create trigger trg_pos_credentials_set_updated_at
  before update on public.pos_credentials
  for each row
  execute function public.set_updated_at();

alter table public.pos_credentials enable row level security;
revoke all on table public.pos_credentials from anon, authenticated;

-- What the owner's settings page shows about the connection. Tokens never
-- appear here; this table is readable by owners and managers.
alter table public.restaurant_pos_integrations
  add column external_merchant_id text,
  add column connected_at timestamptz,
  add column menu_synced_at timestamptz,
  add column last_sync_summary jsonb;

comment on column public.restaurant_pos_integrations.last_sync_summary is
  'Counts from the last menu import (categories_created, items_created, items_updated, items_hidden), for the settings page.';

-- ── Applying a menu import ─────────────────────────────────────────────
--
-- One call, one transaction: either the whole Square menu lands or none
-- of it does, so a timeout halfway cannot leave half a menu on the page
-- diners are ordering from.
--
-- p_menu is the already-mapped menu (src/lib/pos/square/catalog-core.ts
-- turns Square's catalog into this shape):
--   { "categories": [{ "external_id", "name", "display_order" }],
--     "items": [{ "external_id", "category_external_id", "name",
--                 "description", "price", "is_available", "display_order",
--                 "groups": [{ "external_id", "name", "is_required",
--                              "min_selections", "max_selections",
--                              "display_order",
--                              "options": [{ "external_id", "name",
--                                            "price_adjustment",
--                                            "is_available",
--                                            "display_order" }] }] }] }
--
-- Rows are matched on external_id, so re-running the import updates in
-- place. Nothing is ever deleted: carts and past orders point at menu
-- rows, and a modifier option still in someone's cart cannot be removed
-- (cart_item_modifiers restricts it). Something gone from Square is
-- hidden instead. Rows the restaurant added by hand (no external_id) are
-- never touched.
create or replace function public.apply_pos_menu_sync(
  p_restaurant_id uuid,
  p_menu jsonb
)
returns table (
  categories_created integer,
  items_created integer,
  items_updated integer,
  items_hidden integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cats integer := 0;
  v_created integer := 0;
  v_updated integer := 0;
  v_hidden integer := 0;
  v_cat jsonb;
  v_item jsonb;
  v_group jsonb;
  v_option jsonb;
  v_category_id uuid;
  v_item_id uuid;
  v_group_id uuid;
  v_name text;
  v_next_order integer;
  v_base_slug text;
  v_slug text;
  v_suffix integer;
  v_seen_items text[] := '{}';
  v_seen_groups text[];
  v_seen_options text[];
begin
  -- SECURITY DEFINER bypasses RLS, so the right to rewrite this menu is
  -- checked here. current_restaurant_role() (behind this helper) also
  -- enforces two-step verification where the restaurant requires it.
  if not public.is_restaurant_manager_or_owner(p_restaurant_id) then
    raise exception 'POS_SYNC_FORBIDDEN';
  end if;
  if p_menu is null or jsonb_typeof(p_menu -> 'items') <> 'array' then
    raise exception 'POS_SYNC_BAD_MENU';
  end if;

  -- Categories: match on external_id, then adopt a same-named category the
  -- restaurant already had (so importing over a hand-made menu doesn't
  -- duplicate "Mains"), then create.
  for v_cat in select * from jsonb_array_elements(coalesce(p_menu -> 'categories', '[]'::jsonb))
  loop
    v_name := left(trim(v_cat ->> 'name'), 120);
    if v_name is null or v_name = '' then
      continue;
    end if;
    select id into v_category_id from public.categories
    where restaurant_id = p_restaurant_id and external_id = v_cat ->> 'external_id';
    if v_category_id is null then
      select id into v_category_id from public.categories
      where restaurant_id = p_restaurant_id and name = v_name and external_id is null;
      if v_category_id is not null then
        update public.categories set external_id = v_cat ->> 'external_id'
        where id = v_category_id;
      end if;
    end if;
    if v_category_id is null then
      select coalesce(max(display_order), 0) + 1 into v_next_order
      from public.categories where restaurant_id = p_restaurant_id;
      -- A different Square category can't take a name a hand-made one
      -- already uses (names are unique per restaurant).
      if exists (select 1 from public.categories where restaurant_id = p_restaurant_id and name = v_name) then
        v_name := left(v_name, 110) || ' (Square)';
      end if;
      insert into public.categories (restaurant_id, name, display_order, external_id)
      values (p_restaurant_id, v_name, v_next_order, v_cat ->> 'external_id');
      v_cats := v_cats + 1;
    else
      update public.categories set is_active = true
      where id = v_category_id and not is_active;
    end if;
    v_category_id := null;
  end loop;

  for v_item in select * from jsonb_array_elements(p_menu -> 'items')
  loop
    v_name := left(trim(v_item ->> 'name'), 200);
    if v_name is null or v_name = '' or (v_item ->> 'external_id') is null then
      continue;
    end if;
    v_seen_items := v_seen_items || (v_item ->> 'external_id');

    select id into v_category_id from public.categories
    where restaurant_id = p_restaurant_id and external_id = v_item ->> 'category_external_id';
    if v_category_id is null then
      raise exception 'POS_SYNC_UNKNOWN_CATEGORY';
    end if;

    select id into v_item_id from public.menu_items
    where restaurant_id = p_restaurant_id and external_id = v_item ->> 'external_id';

    if v_item_id is null then
      -- Same slug rule as commit_menu_import(): derived, never trusted.
      v_base_slug := nullif(
        trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g')),
        ''
      );
      v_base_slug := trim(both '-' from left(coalesce(v_base_slug, 'item'), 80));
      v_slug := v_base_slug;
      v_suffix := 1;
      while exists (
        select 1 from public.menu_items
        where restaurant_id = p_restaurant_id and slug = v_slug
      ) loop
        v_suffix := v_suffix + 1;
        v_slug := v_base_slug || '-' || v_suffix;
      end loop;
      insert into public.menu_items (
        restaurant_id, category_id, name, slug, description, price,
        is_available, display_order, external_id
      )
      values (
        p_restaurant_id, v_category_id, v_name, v_slug,
        nullif(v_item ->> 'description', ''),
        (v_item ->> 'price')::numeric,
        coalesce((v_item ->> 'is_available')::boolean, true),
        greatest(coalesce((v_item ->> 'display_order')::integer, 0), 0),
        v_item ->> 'external_id'
      )
      returning id into v_item_id;
      v_created := v_created + 1;
    else
      -- Square owns name, price, section and availability. Everything
      -- Tableside adds on top (photos, allergens, dietary flags, spice)
      -- is left alone.
      update public.menu_items set
        category_id = v_category_id,
        name = v_name,
        description = coalesce(nullif(v_item ->> 'description', ''), description),
        price = (v_item ->> 'price')::numeric,
        is_available = coalesce((v_item ->> 'is_available')::boolean, true),
        display_order = greatest(coalesce((v_item ->> 'display_order')::integer, 0), 0)
      where id = v_item_id;
      v_updated := v_updated + 1;
    end if;

    v_seen_groups := '{}';
    for v_group in select * from jsonb_array_elements(coalesce(v_item -> 'groups', '[]'::jsonb))
    loop
      v_seen_groups := v_seen_groups || (v_group ->> 'external_id');
      select id into v_group_id from public.menu_item_modifiers
      where restaurant_id = p_restaurant_id and external_id = v_group ->> 'external_id';
      if v_group_id is null then
        insert into public.menu_item_modifiers (
          restaurant_id, menu_item_id, name, is_required,
          min_selections, max_selections, display_order, external_id
        )
        values (
          p_restaurant_id, v_item_id, left(trim(v_group ->> 'name'), 120),
          coalesce((v_group ->> 'is_required')::boolean, false),
          greatest(coalesce((v_group ->> 'min_selections')::integer, 0), 0),
          greatest(coalesce((v_group ->> 'max_selections')::integer, 1), 1),
          greatest(coalesce((v_group ->> 'display_order')::integer, 0), 0),
          v_group ->> 'external_id'
        )
        returning id into v_group_id;
      else
        update public.menu_item_modifiers set
          name = left(trim(v_group ->> 'name'), 120),
          is_required = coalesce((v_group ->> 'is_required')::boolean, false),
          min_selections = greatest(coalesce((v_group ->> 'min_selections')::integer, 0), 0),
          max_selections = greatest(coalesce((v_group ->> 'max_selections')::integer, 1), 1),
          display_order = greatest(coalesce((v_group ->> 'display_order')::integer, 0), 0)
        where id = v_group_id;
      end if;

      v_seen_options := '{}';
      for v_option in select * from jsonb_array_elements(coalesce(v_group -> 'options', '[]'::jsonb))
      loop
        v_seen_options := v_seen_options || (v_option ->> 'external_id');
        update public.modifier_options set
          name = left(trim(v_option ->> 'name'), 120),
          price_adjustment = coalesce((v_option ->> 'price_adjustment')::numeric, 0),
          is_available = coalesce((v_option ->> 'is_available')::boolean, true),
          display_order = greatest(coalesce((v_option ->> 'display_order')::integer, 0), 0)
        where modifier_id = v_group_id and external_id = v_option ->> 'external_id';
        if not found then
          insert into public.modifier_options (
            modifier_id, name, price_adjustment, is_available, display_order, external_id
          )
          values (
            v_group_id, left(trim(v_option ->> 'name'), 120),
            coalesce((v_option ->> 'price_adjustment')::numeric, 0),
            coalesce((v_option ->> 'is_available')::boolean, true),
            greatest(coalesce((v_option ->> 'display_order')::integer, 0), 0),
            v_option ->> 'external_id'
          );
        end if;
      end loop;
      -- Options Square no longer lists in this group are hidden, not deleted.
      update public.modifier_options set is_available = false
      where modifier_id = v_group_id and external_id is not null
        and not (external_id = any (v_seen_options)) and is_available;
    end loop;

    -- A group Square removed from this item can't be deleted either; its
    -- options are hidden and it stops being required, so it can't block
    -- anyone from ordering the dish.
    update public.modifier_options o set is_available = false
    from public.menu_item_modifiers g
    where o.modifier_id = g.id and g.menu_item_id = v_item_id
      and g.external_id is not null and not (g.external_id = any (v_seen_groups))
      and o.is_available;
    update public.menu_item_modifiers set is_required = false, min_selections = 0
    where menu_item_id = v_item_id and external_id is not null
      and not (external_id = any (v_seen_groups));

    v_category_id := null;
    v_item_id := null;
    v_group_id := null;
  end loop;

  -- Dishes that came from Square earlier and are gone from it now.
  update public.menu_items set is_available = false
  where restaurant_id = p_restaurant_id and external_id is not null
    and not (external_id = any (v_seen_items)) and is_available;
  get diagnostics v_hidden = row_count;

  update public.restaurant_pos_integrations set
    menu_synced_at = now(),
    last_sync_summary = jsonb_build_object(
      'categories_created', v_cats,
      'items_created', v_created,
      'items_updated', v_updated,
      'items_hidden', v_hidden
    )
  where restaurant_id = p_restaurant_id;

  categories_created := v_cats;
  items_created := v_created;
  items_updated := v_updated;
  items_hidden := v_hidden;
  return next;
end;
$$;

comment on function public.apply_pos_menu_sync(uuid, jsonb) is
  'Applies an already-mapped POS menu in one transaction, matching rows on external_id. Hides what disappeared, never deletes. Owners and managers only.';

-- Default privileges hand anon EXECUTE on new functions; take it back.
revoke execute on function public.apply_pos_menu_sync(uuid, jsonb) from public, anon;
grant execute on function public.apply_pos_menu_sync(uuid, jsonb) to authenticated;
