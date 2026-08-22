-- Development seed data. Applied automatically by `supabase db reset` (and
-- `supabase db push --include-seed`), never against production.
--
-- This is ONLY demo/dev data. "Nashta" is used as a realistic example
-- restaurant so the schema has something real to query while building later
-- batches — it is NOT the actual menu, pricing, or business data of the
-- real Nashta — The Snack Store, and no application code may hardcode
-- anything about it (see docs/multi-tenancy.md and docs/database.md). Any
-- restaurant row works identically; this one just has content in it.
--
-- What this file does NOT do: create restaurant_users (owner/manager/
-- kitchen/staff logins). That requires real rows in auth.users, which
-- requires either a real password or the Supabase Admin API — and per
-- project policy, no password (fake or otherwise) belongs in
-- source-controlled SQL. See scripts/seed-dev-users.ts and its comment
-- block for the documented, credential-free way to create dev logins
-- locally. The automated RLS/role tests in tests/integration/db/ don't
-- depend on this file OR that script — they run against their own
-- in-memory Postgres with synthetic auth.uid() values.

do $$
declare
  v_restaurant_id uuid;
  v_cat_street_food uuid;
  v_cat_chaat uuid;
  v_cat_south_indian uuid;
  v_cat_drinks uuid;
  v_cat_desserts uuid;

  v_item_pani_puri uuid;
  v_item_samosa_chaat uuid;
  v_item_vada_pav uuid;
  v_item_fafda uuid;
  v_item_jalebi uuid;
  v_item_paneer_tikka uuid;
  v_item_masala_dosa uuid;
  v_item_mango_lassi uuid;
  v_item_chai uuid;

  -- Batch 8: expanded to 20+ items so the seed restaurant is realistic
  -- enough for full-system simulation (spec section 33), not just enough
  -- to exercise each feature once.
  v_item_bhel_puri uuid;
  v_item_dabeli uuid;
  v_item_aloo_tikki uuid;
  v_item_papdi_chaat uuid;
  v_item_idli_sambar uuid;
  v_item_medu_vada uuid;
  v_item_rava_dosa uuid; -- deliberately seeded unavailable (out of season) — see below
  v_item_nimbu_pani uuid;
  v_item_filter_coffee uuid;
  v_item_gulab_jamun uuid;
  v_item_kheer uuid;

  v_allergen_gluten uuid;
  v_allergen_dairy uuid;
  v_allergen_tree_nuts uuid;

  v_ing uuid; -- scratch variable, reused for each single-use ingredient insert
  v_modifier uuid; -- scratch variable, reused for each modifier group insert
begin
  -- Restaurant ---------------------------------------------------------
  insert into public.restaurants (name, slug, description, phone, address, city, state, postal_code, country, timezone, currency, tax_rate)
  values (
    'Nashta (Demo)',
    'nashta-demo',
    'Seed/demo restaurant for AI Waiter development. Not the real menu, prices, or business details of the actual Nashta — The Snack Store — see docs/database.md.',
    '555-0100',
    '1 Demo Street',
    'Jersey City',
    'NJ',
    '07306',
    'US',
    'America/New_York',
    'USD',
    0.06625
  )
  returning id into v_restaurant_id;

  insert into public.restaurant_settings (restaurant_id)
  values (v_restaurant_id);

  -- Tables 1-8 -----------------------------------------------------------
  insert into public.tables (restaurant_id, table_number, display_name)
  select v_restaurant_id, n::text, 'Table ' || n
  from generate_series(1, 8) as n;

  -- Categories -------------------------------------------------------------
  insert into public.categories (restaurant_id, name, display_order)
  values (v_restaurant_id, 'Street Food', 0)
  returning id into v_cat_street_food;

  insert into public.categories (restaurant_id, name, display_order)
  values (v_restaurant_id, 'Chaat', 1)
  returning id into v_cat_chaat;

  insert into public.categories (restaurant_id, name, display_order)
  values (v_restaurant_id, 'South Indian', 2)
  returning id into v_cat_south_indian;

  insert into public.categories (restaurant_id, name, display_order)
  values (v_restaurant_id, 'Drinks', 3)
  returning id into v_cat_drinks;

  insert into public.categories (restaurant_id, name, display_order)
  values (v_restaurant_id, 'Desserts', 4)
  returning id into v_cat_desserts;

  -- Allergens (only the ones actually used below) ---------------------------
  insert into public.allergens (restaurant_id, name) values (v_restaurant_id, 'Gluten') returning id into v_allergen_gluten;
  insert into public.allergens (restaurant_id, name) values (v_restaurant_id, 'Dairy') returning id into v_allergen_dairy;
  insert into public.allergens (restaurant_id, name) values (v_restaurant_id, 'Tree Nuts') returning id into v_allergen_tree_nuts;

  -- Menu items ---------------------------------------------------------------

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_chaat, 'Pani Puri', 'pani-puri',
    'Crisp hollow puris filled with spiced potato and chickpeas, served with tangy tamarind-mint water on the side.',
    6.99, true, true, true, 'medium', false, false, true, 8, 0
  ) returning id into v_item_pani_puri;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_chaat, 'Samosa Chaat', 'samosa-chaat',
    'Crushed samosas topped with chickpea curry, yogurt, tamarind and mint chutneys, and crunchy sev.',
    7.99, true, false, true, 'medium', false, true, true, 10, 1
  ) returning id into v_item_samosa_chaat;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_street_food, 'Vada Pav', 'vada-pav',
    'Spiced potato fritter in a soft bun with garlic chutney and a fried green chili.',
    5.49, true, true, true, 'mild', false, false, true, 7, 0
  ) returning id into v_item_vada_pav;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_street_food, 'Fafda', 'fafda',
    'Crispy gram-flour strips served with fried green chili and papaya chutney.',
    6.49, true, true, false, 'mild', false, false, false, 6, 1
  ) returning id into v_item_fafda;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_street_food, 'Paneer Tikka', 'paneer-tikka',
    'Chargrilled paneer marinated in yogurt and tandoori spices, served with mint chutney.',
    8.99, true, false, true, 'medium', false, true, false, 12, 2
  ) returning id into v_item_paneer_tikka;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_desserts, 'Jalebi', 'jalebi',
    'Crispy, syrup-soaked spirals, served warm.',
    4.99, true, false, false, 'none', false, true, true, 5, 0
  ) returning id into v_item_jalebi;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_south_indian, 'Masala Dosa', 'masala-dosa',
    'Crispy fermented rice-and-lentil crepe filled with spiced potato masala, served with sambar and coconut chutney.',
    9.99, true, true, true, 'mild', false, false, false, 14, 0
  ) returning id into v_item_masala_dosa;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_drinks, 'Mango Lassi', 'mango-lassi',
    'Blended yogurt with ripe mango and a touch of cardamom.',
    4.99, true, false, false, 'none', false, true, false, 4, 0
  ) returning id into v_item_mango_lassi;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_drinks, 'Chai', 'chai',
    'Spiced black tea simmered with milk, cardamom, ginger, and cloves.',
    2.99, true, false, false, 'none', false, true, false, 5, 1
  ) returning id into v_item_chai;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_chaat, 'Bhel Puri', 'bhel-puri',
    'Puffed rice tossed with vegetables, tamarind chutney, and crunchy sev.',
    6.49, true, true, true, 'mild', false, false, true, 6, 2
  ) returning id into v_item_bhel_puri;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_street_food, 'Dabeli', 'dabeli',
    'Spiced mashed potato in a toasted bun with peanuts, pomegranate, and tangy chutneys.',
    6.99, true, true, true, 'mild', true, false, true, 9, 3
  ) returning id into v_item_dabeli;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_chaat, 'Aloo Tikki Chaat', 'aloo-tikki-chaat',
    'Pan-fried spiced potato patties topped with yogurt, chutneys, and pomegranate.',
    7.49, true, false, true, 'medium', false, true, false, 10, 3
  ) returning id into v_item_aloo_tikki;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_chaat, 'Papdi Chaat', 'papdi-chaat',
    'Crisp wheat crackers layered with potato, chickpeas, yogurt, and chutneys.',
    7.49, true, false, true, 'mild', false, true, true, 8, 4
  ) returning id into v_item_papdi_chaat;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_south_indian, 'Idli Sambar', 'idli-sambar',
    'Steamed rice-and-lentil cakes served with sambar and coconut chutney.',
    6.99, true, true, false, 'none', false, false, false, 10, 1
  ) returning id into v_item_idli_sambar;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_south_indian, 'Medu Vada', 'medu-vada',
    'Crispy fried lentil doughnuts served with sambar and coconut chutney.',
    6.49, true, true, true, 'mild', false, false, false, 9, 2
  ) returning id into v_item_medu_vada;

  -- Deliberately seeded unavailable (spec section 33: "at least some
  -- items marked unavailable") — a realistic reason (seasonal/out of
  -- stock), not a broken or incomplete item; it still has full
  -- ingredient/allergen/modifier data, exactly as a real temporarily-86'd
  -- dish would.
  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order, is_available
  ) values (
    v_restaurant_id, v_cat_south_indian, 'Rava Dosa', 'rava-dosa',
    'Thin, crispy semolina crepe with onions and green chili, served with sambar and chutney. Seasonal — currently unavailable.',
    10.49, true, true, true, 'mild', false, false, true, 15, 3, false
  ) returning id into v_item_rava_dosa;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_drinks, 'Nimbu Pani', 'nimbu-pani',
    'Fresh lime water with a pinch of roasted cumin and black salt.',
    3.49, true, true, false, 'none', false, false, false, 3, 2
  ) returning id into v_item_nimbu_pani;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_drinks, 'Filter Coffee', 'filter-coffee',
    'South Indian-style decoction coffee with frothed milk.',
    3.99, true, false, false, 'none', false, true, false, 5, 3
  ) returning id into v_item_filter_coffee;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_desserts, 'Gulab Jamun', 'gulab-jamun',
    'Soft milk-solid dumplings soaked in cardamom-rose syrup.',
    5.49, true, false, false, 'none', true, true, true, 6, 1
  ) returning id into v_item_gulab_jamun;

  insert into public.menu_items (
    restaurant_id, category_id, name, slug, description, price,
    is_vegetarian, is_vegan, is_spicy, spice_level,
    contains_nuts, contains_dairy, contains_gluten, preparation_time, display_order
  ) values (
    v_restaurant_id, v_cat_desserts, 'Kheer', 'kheer',
    'Creamy rice pudding simmered with milk, cardamom, and pistachio.',
    4.99, true, false, false, 'none', true, true, false, 8, 2
  ) returning id into v_item_kheer;

  -- Ingredients + menu_item_ingredients links --------------------------------
  -- One insert per ingredient, immediately linked to the item(s) that use it,
  -- so no ingredient is created without being referenced.

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Semolina Puri') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_pani_puri, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Potato') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values
    (v_restaurant_id, v_item_pani_puri, v_ing),
    (v_restaurant_id, v_item_samosa_chaat, v_ing),
    (v_restaurant_id, v_item_vada_pav, v_ing),
    (v_restaurant_id, v_item_masala_dosa, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Chickpeas') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_pani_puri, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Tamarind Chutney') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values
    (v_restaurant_id, v_item_pani_puri, v_ing),
    (v_restaurant_id, v_item_samosa_chaat, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Mint-Coriander Water') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_pani_puri, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Chaat Masala') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_pani_puri, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Samosa Pastry') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_samosa_chaat, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Chickpea Curry') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_samosa_chaat, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Yogurt') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values
    (v_restaurant_id, v_item_samosa_chaat, v_ing),
    (v_restaurant_id, v_item_paneer_tikka, v_ing),
    (v_restaurant_id, v_item_mango_lassi, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Sev') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_samosa_chaat, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Potato Fritter') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_vada_pav, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Pav Bun') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_vada_pav, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Garlic Chutney') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_vada_pav, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Fried Green Chili') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values
    (v_restaurant_id, v_item_vada_pav, v_ing),
    (v_restaurant_id, v_item_fafda, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Gram Flour') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_fafda, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Papaya Chutney') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_fafda, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Paneer') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_paneer_tikka, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Tandoori Spice Marinade') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_paneer_tikka, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'All-Purpose Flour') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_jalebi, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Sugar Syrup') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_jalebi, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Ghee') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_jalebi, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Saffron') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_jalebi, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Rice') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_masala_dosa, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Urad Dal') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_masala_dosa, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Sambar') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_masala_dosa, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Coconut Chutney') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_masala_dosa, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Mango') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_mango_lassi, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Cardamom') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values
    (v_restaurant_id, v_item_mango_lassi, v_ing),
    (v_restaurant_id, v_item_chai, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Black Tea') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_chai, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Milk') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_chai, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Ginger') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_chai, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Cloves') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_chai, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Puffed Rice') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_bhel_puri, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Roasted Peanuts') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values
    (v_restaurant_id, v_item_bhel_puri, v_ing),
    (v_restaurant_id, v_item_dabeli, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Pomegranate') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values
    (v_restaurant_id, v_item_dabeli, v_ing),
    (v_restaurant_id, v_item_aloo_tikki, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Wheat Crackers') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_papdi_chaat, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Lentil Batter') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values
    (v_restaurant_id, v_item_idli_sambar, v_ing),
    (v_restaurant_id, v_item_medu_vada, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Semolina') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_rava_dosa, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Lime') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_nimbu_pani, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Coffee Decoction') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_filter_coffee, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Milk Solids (Khoya)') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values (v_restaurant_id, v_item_gulab_jamun, v_ing);

  insert into public.ingredients (restaurant_id, name) values (v_restaurant_id, 'Pistachio') returning id into v_ing;
  insert into public.menu_item_ingredients (restaurant_id, menu_item_id, ingredient_id) values
    (v_restaurant_id, v_item_kheer, v_ing),
    (v_restaurant_id, v_item_gulab_jamun, v_ing);

  -- Allergen links (only where contains_gluten / contains_dairy / contains_nuts = true above) --
  insert into public.menu_item_allergens (restaurant_id, menu_item_id, allergen_id) values
    (v_restaurant_id, v_item_pani_puri, v_allergen_gluten),
    (v_restaurant_id, v_item_samosa_chaat, v_allergen_gluten),
    (v_restaurant_id, v_item_samosa_chaat, v_allergen_dairy),
    (v_restaurant_id, v_item_vada_pav, v_allergen_gluten),
    (v_restaurant_id, v_item_paneer_tikka, v_allergen_dairy),
    (v_restaurant_id, v_item_jalebi, v_allergen_gluten),
    (v_restaurant_id, v_item_jalebi, v_allergen_dairy),
    (v_restaurant_id, v_item_mango_lassi, v_allergen_dairy),
    (v_restaurant_id, v_item_chai, v_allergen_dairy),
    (v_restaurant_id, v_item_dabeli, v_allergen_tree_nuts),
    (v_restaurant_id, v_item_dabeli, v_allergen_gluten),
    (v_restaurant_id, v_item_aloo_tikki, v_allergen_dairy),
    (v_restaurant_id, v_item_papdi_chaat, v_allergen_dairy),
    (v_restaurant_id, v_item_papdi_chaat, v_allergen_gluten),
    (v_restaurant_id, v_item_rava_dosa, v_allergen_gluten),
    (v_restaurant_id, v_item_filter_coffee, v_allergen_dairy),
    (v_restaurant_id, v_item_gulab_jamun, v_allergen_dairy),
    (v_restaurant_id, v_item_gulab_jamun, v_allergen_gluten),
    (v_restaurant_id, v_item_gulab_jamun, v_allergen_tree_nuts),
    (v_restaurant_id, v_item_kheer, v_allergen_dairy),
    (v_restaurant_id, v_item_kheer, v_allergen_tree_nuts);

  -- Modifiers (only where a real modifier makes sense) -------------------------

  insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name, is_required, min_selections, max_selections, display_order)
  values (v_restaurant_id, v_item_pani_puri, 'Spice Level', true, 1, 1, 0)
  returning id into v_modifier;
  insert into public.modifier_options (modifier_id, name, price_adjustment, display_order) values
    (v_modifier, 'Mild', 0, 0),
    (v_modifier, 'Medium', 0, 1),
    (v_modifier, 'Hot', 0, 2);

  insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name, is_required, min_selections, max_selections, display_order)
  values (v_restaurant_id, v_item_paneer_tikka, 'Spice Level', true, 1, 1, 0)
  returning id into v_modifier;
  insert into public.modifier_options (modifier_id, name, price_adjustment, display_order) values
    (v_modifier, 'Mild', 0, 0),
    (v_modifier, 'Medium', 0, 1),
    (v_modifier, 'Hot', 0, 2);

  insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name, description, is_required, min_selections, max_selections, display_order)
  values (v_restaurant_id, v_item_vada_pav, 'Add-ons', 'Optional extras', false, 0, 2, 1)
  returning id into v_modifier;
  insert into public.modifier_options (modifier_id, name, price_adjustment, display_order) values
    (v_modifier, 'Extra Garlic Chutney', 0.50, 0),
    (v_modifier, 'Extra Fried Chili', 0.00, 1);

  insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name, description, is_required, min_selections, max_selections, display_order)
  values (v_restaurant_id, v_item_masala_dosa, 'Add-ons', 'Optional extras', false, 0, 3, 1)
  returning id into v_modifier;
  insert into public.modifier_options (modifier_id, name, price_adjustment, display_order) values
    (v_modifier, 'Extra Sambar', 1.50, 0),
    (v_modifier, 'Extra Coconut Chutney', 0.75, 1),
    (v_modifier, 'Ghee Roast', 1.00, 2);

  insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name, is_required, min_selections, max_selections, display_order)
  values (v_restaurant_id, v_item_mango_lassi, 'Size', true, 1, 1, 0)
  returning id into v_modifier;
  insert into public.modifier_options (modifier_id, name, price_adjustment, display_order) values
    (v_modifier, 'Regular', 0, 0),
    (v_modifier, 'Large', 1.50, 1);

  insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name, is_required, min_selections, max_selections, display_order)
  values (v_restaurant_id, v_item_chai, 'Size', true, 1, 1, 0)
  returning id into v_modifier;
  insert into public.modifier_options (modifier_id, name, price_adjustment, display_order) values
    (v_modifier, 'Regular', 0, 0),
    (v_modifier, 'Large', 1.00, 1);

  insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name, description, is_required, min_selections, max_selections, display_order)
  values (v_restaurant_id, v_item_bhel_puri, 'Spice Level', 'Optional — mild by default', false, 0, 1, 0)
  returning id into v_modifier;
  insert into public.modifier_options (modifier_id, name, price_adjustment, display_order) values
    (v_modifier, 'Mild', 0, 0),
    (v_modifier, 'Medium', 0, 1),
    (v_modifier, 'Hot', 0, 2);

  insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name, is_required, min_selections, max_selections, display_order)
  values (v_restaurant_id, v_item_filter_coffee, 'Size', true, 1, 1, 0)
  returning id into v_modifier;
  insert into public.modifier_options (modifier_id, name, price_adjustment, display_order) values
    (v_modifier, 'Regular', 0, 0),
    (v_modifier, 'Large', 1.00, 1);

  insert into public.menu_item_modifiers (restaurant_id, menu_item_id, name, description, is_required, min_selections, max_selections, display_order)
  values (v_restaurant_id, v_item_idli_sambar, 'Add-ons', 'Optional extras', false, 0, 2, 0)
  returning id into v_modifier;
  insert into public.modifier_options (modifier_id, name, price_adjustment, display_order) values
    (v_modifier, 'Extra Sambar', 1.25, 0),
    (v_modifier, 'Extra Coconut Chutney', 0.75, 1);

end $$;
