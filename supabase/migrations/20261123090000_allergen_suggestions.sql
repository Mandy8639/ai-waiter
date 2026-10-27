-- Owners confirm the allergens the menu knowledge graph suggests.
--
-- The graph (src/lib/menu-graph) already infers likely allergens from a
-- dish's name and listed ingredients ("Palak Paneer" → milk, "made with
-- ghee" → milk) and the waiter warns guests about them. But an inferred
-- allergen is only a warning; a confirmed one is a fact the restaurant
-- states. This turns the inference into suggestions on the existing
-- review screen (/dashboard/menu/allergen-review), where an owner or
-- manager ticks what's right, so the waiter's answers become statements.
--
-- Nothing here is shown to a diner until a human confirms it: suggestions
-- are ordinary UNCONFIRMED menu_item_allergens rows, which every diner
-- read path already ignores (20260904140000).

-- Why the graph suggested it, shown beside the tick ("its name mentions
-- paneer"). Null for suggestions from menu import or added by hand.
alter table public.menu_item_allergens add column suggestion_reason text;

alter table public.menu_item_allergens
  add constraint menu_item_allergens_suggestion_reason_length
  check (suggestion_reason is null or char_length(suggestion_reason) <= 200);

-- A suggestion the reviewer rejected, so asking again ("Find likely
-- allergens" next month) never re-asks it.
create table public.allergen_dismissals (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  menu_item_id uuid not null,
  allergen_name text not null,
  dismissed_at timestamptz not null default now(),
  dismissed_by uuid references auth.users (id) on delete set null,

  constraint allergen_dismissals_once unique (menu_item_id, allergen_name),
  constraint allergen_dismissals_item_same_restaurant
    foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id)
    on delete cascade
);

alter table public.allergen_dismissals enable row level security;

create policy "allergen_dismissals_select_managers"
  on public.allergen_dismissals
  for select
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));

revoke all on public.allergen_dismissals from anon;
revoke insert, update, delete on public.allergen_dismissals from authenticated;

-- Confirming now remembers what was rejected. Otherwise unchanged from
-- 20260904160000: names in, the restaurant's allergen row reused or made,
-- an existing confirmation never rewritten, a confirmed allergen never
-- removed by unticking.
create or replace function public.confirm_menu_item_allergens(
  p_menu_item_id uuid,
  p_allergen_names text[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_name text;
  v_allergen_id uuid;
  v_confirmed_ids uuid[] := '{}';
  v_count integer := 0;
begin
  select restaurant_id into v_restaurant_id
  from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'ALLERGEN_ITEM_NOT_FOUND';
  end if;
  if not public.is_restaurant_manager_or_owner(v_restaurant_id) then
    raise exception 'ALLERGEN_FORBIDDEN';
  end if;

  foreach v_name in array coalesce(p_allergen_names, '{}')
  loop
    v_name := trim(v_name);
    continue when v_name = '';
    select id into v_allergen_id
    from public.allergens
    where restaurant_id = v_restaurant_id and name = v_name;
    if v_allergen_id is null then
      insert into public.allergens (restaurant_id, name)
      values (v_restaurant_id, v_name)
      returning id into v_allergen_id;
    end if;
    insert into public.menu_item_allergens (
      restaurant_id, menu_item_id, allergen_id, confirmed_at, confirmed_by
    )
    values (
      v_restaurant_id, p_menu_item_id, v_allergen_id, now(), (select auth.uid())
    )
    on conflict (menu_item_id, allergen_id) do update
      set confirmed_at = coalesce(public.menu_item_allergens.confirmed_at, now()),
          confirmed_by = coalesce(public.menu_item_allergens.confirmed_by, (select auth.uid()));
    v_confirmed_ids := v_confirmed_ids || v_allergen_id;
    v_count := v_count + 1;
    -- Ticked now: no longer a rejection, if it ever was one.
    delete from public.allergen_dismissals
    where menu_item_id = p_menu_item_id and allergen_name = v_name;
  end loop;

  -- Unticked, unconfirmed suggestions were rejected: remember, then remove.
  insert into public.allergen_dismissals
    (restaurant_id, menu_item_id, allergen_name, dismissed_by)
  select v_restaurant_id, p_menu_item_id, a.name, (select auth.uid())
  from public.menu_item_allergens mia
  join public.allergens a on a.id = mia.allergen_id
  where mia.menu_item_id = p_menu_item_id
    and mia.confirmed_at is null
    and not (mia.allergen_id = any(v_confirmed_ids))
  on conflict (menu_item_id, allergen_name) do nothing;

  delete from public.menu_item_allergens
  where menu_item_id = p_menu_item_id
    and confirmed_at is null
    and not (allergen_id = any(v_confirmed_ids));
  return v_count;
end;
$$;

revoke execute on function public.confirm_menu_item_allergens(uuid, text[]) from public, anon;
grant execute on function public.confirm_menu_item_allergens(uuid, text[]) to authenticated;

-- Adds the graph's suggestions to the review queue: an unconfirmed row
-- with its reason, for each (dish, allergen name) that isn't already on
-- the dish (confirmed or suggested) and wasn't rejected before. The
-- allergen names are the review screen's own vocabulary, chosen by the
-- caller. Owners and managers only. Returns how many were added.
create function public.suggest_menu_allergens(
  p_restaurant_id uuid,
  p_suggestions jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_item_id uuid;
  v_name text;
  v_reason text;
  v_allergen_id uuid;
  v_added integer := 0;
begin
  if not public.is_restaurant_manager_or_owner(p_restaurant_id) then
    raise exception 'ALLERGEN_FORBIDDEN';
  end if;
  if jsonb_typeof(p_suggestions) <> 'array' or jsonb_array_length(p_suggestions) > 2000 then
    raise exception 'ALLERGEN_INVALID: suggestions must be an array of at most 2000';
  end if;

  for v_row in select * from jsonb_array_elements(p_suggestions)
  loop
    v_item_id := (v_row ->> 'menu_item_id')::uuid;
    v_name := trim(coalesce(v_row ->> 'allergen_name', ''));
    v_reason := left(trim(coalesce(v_row ->> 'reason', '')), 200);
    continue when v_name = '' or char_length(v_name) > 60;
    -- This restaurant's dishes only.
    continue when not exists (
      select 1 from public.menu_items
      where id = v_item_id and restaurant_id = p_restaurant_id
    );
    -- Rejected before: never ask again.
    continue when exists (
      select 1 from public.allergen_dismissals
      where menu_item_id = v_item_id and allergen_name = v_name
    );
    -- Already on the dish, confirmed or waiting.
    continue when exists (
      select 1
      from public.menu_item_allergens mia
      join public.allergens a on a.id = mia.allergen_id
      where mia.menu_item_id = v_item_id and a.name = v_name
    );

    select id into v_allergen_id
    from public.allergens
    where restaurant_id = p_restaurant_id and name = v_name;
    if v_allergen_id is null then
      insert into public.allergens (restaurant_id, name)
      values (p_restaurant_id, v_name)
      returning id into v_allergen_id;
    end if;

    insert into public.menu_item_allergens
      (restaurant_id, menu_item_id, allergen_id, suggestion_reason)
    values
      (p_restaurant_id, v_item_id, v_allergen_id, nullif(v_reason, ''))
    on conflict (menu_item_id, allergen_id) do nothing;
    if found then
      v_added := v_added + 1;
    end if;
  end loop;
  return v_added;
end;
$$;

revoke execute on function public.suggest_menu_allergens(uuid, jsonb) from public, anon;
grant execute on function public.suggest_menu_allergens(uuid, jsonb) to authenticated;
