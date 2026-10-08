-- Multiple menus (phase L): a restaurant can have a Lunch menu and a Dinner
-- menu, each with its own days and hours, built as drafts before they go
-- live.
--
-- THE SHAPE
--
--   A MENU is a name, a published/draft flag, optional opening hours
--   (menu_hours: day of week + time window, in the restaurant's own
--   timezone) and a set of SECTIONS — the restaurant's existing categories,
--   joined through menu_sections. A section can be on several menus
--   ("Drinks" on Lunch and Dinner) and is set up once.
--
--   A published menu with no hours is always on. A dish is on the menu
--   right now when its section is active and belongs to at least one
--   published menu that is on now (category_on_now()).
--
-- NOTHING CHANGES FOR AN EXISTING RESTAURANT
--
--   Every restaurant gets one DEFAULT menu, "Menu", published, with no
--   hours (always on), holding all its sections. New restaurants get one
--   too, and every new section — from the dashboard, from menu import,
--   from anywhere — joins the default menu automatically, so no existing
--   code path can make a section vanish from the diner menu. The default
--   menu can be renamed and given hours, but not unpublished or deleted.
--
-- WHEN A DISH'S MENU ISN'T ON
--
--   It isn't shown, the AI waiter doesn't offer it, it can't be added to a
--   cart (validate-core.ts), and — the backstop — a BEFORE INSERT trigger
--   on order_items refuses it, so submit_order() rejects an order carrying
--   a dish left in a cart from earlier. submit_order() itself is
--   unchanged.

create table public.menus (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  is_published boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),

  constraint menus_restaurant_id_id_key unique (restaurant_id, id),
  constraint menus_name_length check (char_length(btrim(name)) between 1 and 40),
  -- The default menu is where new sections land, so it is always live.
  constraint menus_default_is_published check (not is_default or is_published)
);

create unique index menus_one_default_per_restaurant
  on public.menus (restaurant_id) where is_default;
create unique index menus_name_unique
  on public.menus (restaurant_id, lower(btrim(name)));

comment on table public.menus is
  'Phase L: a restaurant''s menus (Lunch, Dinner...). Sections via menu_sections, opening hours via menu_hours. Exactly one default menu per restaurant, always published; new sections join it automatically.';

create table public.menu_hours (
  id uuid primary key default gen_random_uuid(),
  menu_id uuid not null,
  restaurant_id uuid not null,
  -- 0 = Sunday ... 6 = Saturday, as extract(dow) returns it.
  day_of_week smallint not null,
  opens_at time not null,
  closes_at time not null,

  constraint menu_hours_menu_same_restaurant
    foreign key (restaurant_id, menu_id)
    references public.menus (restaurant_id, id) on delete cascade,
  constraint menu_hours_day_valid check (day_of_week between 0 and 6),
  -- No overnight windows in one row: 22:00–02:00 is two rows (22:00–24:00
  -- and the next day's 00:00–02:00). '24:00' is a valid closing time.
  constraint menu_hours_window_valid check (closes_at > opens_at)
);

create index menu_hours_menu_id_idx on public.menu_hours (menu_id);

comment on table public.menu_hours is
  'Phase L: when a menu is on, per day of week, in the restaurant''s timezone. A menu with no rows here is always on.';

create table public.menu_sections (
  menu_id uuid not null,
  category_id uuid not null,
  restaurant_id uuid not null,

  primary key (menu_id, category_id),
  constraint menu_sections_menu_same_restaurant
    foreign key (restaurant_id, menu_id)
    references public.menus (restaurant_id, id) on delete cascade,
  constraint menu_sections_category_same_restaurant
    foreign key (restaurant_id, category_id)
    references public.categories (restaurant_id, id) on delete cascade
);

create index menu_sections_category_id_idx on public.menu_sections (category_id);

comment on table public.menu_sections is
  'Phase L: which sections (categories) are on which menus. A section may be on several.';

-- Who can see and change them: the same rules as categories.
alter table public.menus enable row level security;
alter table public.menu_hours enable row level security;
alter table public.menu_sections enable row level security;

create policy "menus_select_members" on public.menus
  for select to authenticated using (public.is_restaurant_member(restaurant_id));
create policy "menus_insert_owner_manager" on public.menus
  for insert to authenticated
  with check (public.is_restaurant_manager_or_owner(restaurant_id) and not is_default);
create policy "menus_update_owner_manager" on public.menus
  for update to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));
-- The default menu can't be deleted. (A policy, not a trigger, so deleting
-- a whole restaurant still cascades.)
create policy "menus_delete_owner_manager" on public.menus
  for delete to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id) and not is_default);

create policy "menu_hours_select_members" on public.menu_hours
  for select to authenticated using (public.is_restaurant_member(restaurant_id));
create policy "menu_hours_write_owner_manager" on public.menu_hours
  for all to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "menu_sections_select_members" on public.menu_sections
  for select to authenticated using (public.is_restaurant_member(restaurant_id));
create policy "menu_sections_write_owner_manager" on public.menu_sections
  for all to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

-- The default menu can't become non-default by an update either (a
-- restaurant always has one), and is_default can't be set by hand.
create function public.enforce_menu_default_fixed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.is_default is distinct from old.is_default then
    raise exception 'MENU_DEFAULT_FIXED: the default menu stays the default'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_menu_default_fixed() from public, anon, authenticated;

create trigger menus_default_fixed
  before update on public.menus
  for each row execute function public.enforce_menu_default_fixed();

-- Is this menu on right now?
create function public.menu_on_now(p_menu_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select m.is_published and (
      not exists (select 1 from public.menu_hours h where h.menu_id = m.id)
      or exists (
        select 1
        from public.menu_hours h,
             lateral (select now() at time zone coalesce(r.timezone, 'UTC') as local_now) t
        where h.menu_id = m.id
          and h.day_of_week = extract(dow from t.local_now)::smallint
          and t.local_now::time >= h.opens_at
          and t.local_now::time < h.closes_at
      )
    )
    from public.menus m
    join public.restaurants r on r.id = m.restaurant_id
    where m.id = p_menu_id
  ), false)
$$;

-- Is this section on a menu that's on right now (and active)?
create function public.category_on_now(p_category_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.categories c
    join public.menu_sections ms on ms.category_id = c.id
    where c.id = p_category_id
      and c.is_active
      and public.menu_on_now(ms.menu_id)
  )
$$;

revoke execute on function public.menu_on_now(uuid) from public, anon;
revoke execute on function public.category_on_now(uuid) from public, anon;
grant execute on function public.menu_on_now(uuid) to authenticated;
grant execute on function public.category_on_now(uuid) to authenticated;

-- What a diner (or the AI waiter) needs: every published menu, whether
-- it's on now, its hours and its sections. The menu is public, so this is.
create function public.get_public_menus(target_restaurant_id uuid)
returns table (
  public_menu_id uuid,
  public_menu_name text,
  public_menu_sort integer,
  public_menu_on_now boolean,
  public_menu_hours jsonb,
  public_menu_category_ids uuid[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    m.id,
    m.name,
    m.sort_order,
    public.menu_on_now(m.id),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', h.day_of_week,
        'opens', to_char(h.opens_at, 'HH24:MI'),
        'closes', to_char(h.closes_at, 'HH24:MI')
      ) order by h.day_of_week, h.opens_at)
      from public.menu_hours h where h.menu_id = m.id
    ), '[]'::jsonb),
    coalesce((
      select array_agg(ms.category_id)
      from public.menu_sections ms
      join public.categories c on c.id = ms.category_id and c.is_active
      where ms.menu_id = m.id
    ), '{}')
  from public.menus m
  join public.restaurants r on r.id = m.restaurant_id
  where m.restaurant_id = target_restaurant_id
    and r.is_active
    and m.is_published
  order by m.sort_order, m.name
$$;

revoke execute on function public.get_public_menus(uuid) from public;
grant execute on function public.get_public_menus(uuid) to anon, authenticated;

-- New restaurants get a default menu; new sections join it.
create function public.create_default_menu()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.menus (restaurant_id, name, is_default, is_published)
  values (new.id, 'Menu', true, true);
  return new;
end;
$$;

revoke execute on function public.create_default_menu() from public, anon, authenticated;

create trigger restaurants_create_default_menu
  after insert on public.restaurants
  for each row execute function public.create_default_menu();

create function public.add_category_to_default_menu()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.menu_sections (menu_id, category_id, restaurant_id)
  select m.id, new.id, new.restaurant_id
  from public.menus m
  where m.restaurant_id = new.restaurant_id and m.is_default
  on conflict do nothing;
  return new;
end;
$$;

revoke execute on function public.add_category_to_default_menu() from public, anon, authenticated;

create trigger categories_join_default_menu
  after insert on public.categories
  for each row execute function public.add_category_to_default_menu();

-- The backstop: a dish can only be ordered while its menu is on.
create function public.enforce_order_item_on_menu()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_category uuid;
  v_name text;
begin
  if new.menu_item_id is null then
    return new;
  end if;
  select mi.category_id, mi.name into v_category, v_name
  from public.menu_items mi where mi.id = new.menu_item_id;
  if v_category is not null and not public.category_on_now(v_category) then
    raise exception 'ORDER_ITEM_NOT_SERVED_NOW: "%" isn''t being served right now — please remove it from your cart', v_name
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_order_item_on_menu() from public, anon, authenticated;

create trigger order_items_on_menu_now
  before insert on public.order_items
  for each row execute function public.enforce_order_item_on_menu();

-- Backfill: one default menu per existing restaurant, holding every
-- existing section. After this, every diner menu looks exactly as before.
insert into public.menus (restaurant_id, name, is_default, is_published)
select r.id, 'Menu', true, true
from public.restaurants r
where not exists (
  select 1 from public.menus m where m.restaurant_id = r.id and m.is_default
);

insert into public.menu_sections (menu_id, category_id, restaurant_id)
select m.id, c.id, c.restaurant_id
from public.categories c
join public.menus m on m.restaurant_id = c.restaurant_id and m.is_default
on conflict do nothing;
