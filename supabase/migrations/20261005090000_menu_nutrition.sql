-- Nutrition (phase M): calories, protein, carbohydrate and fat per serving.
--
-- A calorie count is a number people make medical decisions with, so this
-- follows the allergen rule, not the competitor's "AI-generated, trust us":
--
--   1. NOTHING IS PUBLISHED UNREVIEWED. Values — typed by a person or
--      estimated by the AI — are saved as a draft. Only
--      confirm_menu_item_nutrition(), run by an owner or manager, makes them
--      visible. Diners, and the AI waiter (which reads as a diner), see
--      confirmed values only, through the same "publicly visible dish" rule
--      allergens use.
--   2. CHANGED NUMBERS ARE NOT CONFIRMED NUMBERS. Saving new values always
--      clears the confirmation; whoever confirms is confirming what's there.
--   3. IMPOSSIBLE NUMBERS ARE REFUSED. Hard bounds here (a single serving
--      over 5,000 kcal, or 500 g of a macronutrient, is a typo or a
--      hallucination). Numbers that are possible but don't add up — calories
--      far from 4/4/9 per gram of protein/carbohydrate/fat — are flagged on
--      the owner's screen (src/lib/nutrition/core.ts), not refused: fibre,
--      alcohol and rounding legitimately move them.

create table public.menu_item_nutrition (
  menu_item_id uuid primary key,
  restaurant_id uuid not null,
  calories integer not null,
  protein_g numeric(5, 1) not null,
  carbs_g numeric(5, 1) not null,
  fat_g numeric(5, 1) not null,
  source text not null,
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users (id) on delete set null,

  constraint menu_item_nutrition_item_same_restaurant
    foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id) on delete cascade,
  constraint menu_item_nutrition_source_valid check (source in ('ai', 'owner')),
  constraint menu_item_nutrition_calories_range check (calories between 0 and 5000),
  constraint menu_item_nutrition_macros_range check (
    protein_g between 0 and 500
    and carbs_g between 0 and 500
    and fat_g between 0 and 500
  )
);

comment on table public.menu_item_nutrition is
  'Phase M: per-serving nutrition for a dish. Shown to diners only once confirmed (confirmed_at). Written only through save_/confirm_menu_item_nutrition(). See docs/security.md#nutrition-phase-m.';

alter table public.menu_item_nutrition enable row level security;

create policy "menu_item_nutrition_select_members"
  on public.menu_item_nutrition for select to authenticated
  using (public.is_restaurant_member(restaurant_id));

-- What diners (and the AI waiter, which reads as the diner) can see:
-- confirmed values for a dish they could see anyway.
create policy "menu_item_nutrition_select_public"
  on public.menu_item_nutrition for select to anon, authenticated
  using (
    confirmed_at is not null
    and public.is_menu_item_publicly_visible(menu_item_id)
  );

create policy "menu_item_nutrition_delete_owner_manager"
  on public.menu_item_nutrition for delete to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));

-- Save values as a draft (always unconfirmed).
create function public.save_menu_item_nutrition(
  p_menu_item_id uuid,
  p_calories integer,
  p_protein_g numeric,
  p_carbs_g numeric,
  p_fat_g numeric,
  p_source text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant uuid;
begin
  select mi.restaurant_id into v_restaurant
  from public.menu_items mi where mi.id = p_menu_item_id;
  if v_restaurant is null then
    raise exception 'NUTRITION_DISH_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.is_restaurant_manager_or_owner(v_restaurant) then
    raise exception 'NUTRITION_FORBIDDEN: only an owner or manager can edit nutrition'
      using errcode = '42501';
  end if;

  insert into public.menu_item_nutrition as n
    (menu_item_id, restaurant_id, calories, protein_g, carbs_g, fat_g, source)
  values
    (p_menu_item_id, v_restaurant, p_calories, p_protein_g, p_carbs_g, p_fat_g, p_source)
  on conflict (menu_item_id) do update
  set calories = excluded.calories,
      protein_g = excluded.protein_g,
      carbs_g = excluded.carbs_g,
      fat_g = excluded.fat_g,
      source = excluded.source,
      updated_at = now(),
      confirmed_at = null,
      confirmed_by = null;
end;
$$;

revoke execute on function public.save_menu_item_nutrition(uuid, integer, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.save_menu_item_nutrition(uuid, integer, numeric, numeric, numeric, text) to authenticated;

-- A person confirms the values as they stand. Only this publishes.
create function public.confirm_menu_item_nutrition(p_menu_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant uuid;
begin
  select n.restaurant_id into v_restaurant
  from public.menu_item_nutrition n where n.menu_item_id = p_menu_item_id;
  if v_restaurant is null then
    raise exception 'NUTRITION_NOT_FOUND: nothing to confirm' using errcode = 'P0002';
  end if;
  if not public.is_restaurant_manager_or_owner(v_restaurant) then
    raise exception 'NUTRITION_FORBIDDEN: only an owner or manager can confirm nutrition'
      using errcode = '42501';
  end if;

  update public.menu_item_nutrition
  set confirmed_at = now(), confirmed_by = auth.uid()
  where menu_item_id = p_menu_item_id;
end;
$$;

revoke execute on function public.confirm_menu_item_nutrition(uuid) from public, anon;
grant execute on function public.confirm_menu_item_nutrition(uuid) to authenticated;
