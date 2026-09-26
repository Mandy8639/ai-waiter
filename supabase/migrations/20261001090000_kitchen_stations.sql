-- Kitchen stations (phase I): a dish is made at a station — grill, fry,
-- cold — and each station's screen shows only the lines it makes.
--
-- WHAT A STATION CHANGES, AND WHAT IT DOESN'T.
--   - A dish is assigned to at most one station (menu_items.station_id).
--     Unassigned dishes are shown on EVERY station, labelled, so a
--     forgotten assignment is visible rather than a dish nobody cooks.
--   - Each order line records its station when the order is placed
--     (order_items.station_id, set by a trigger). Reassigning a dish in the
--     middle of service moves future tickets, not the ones already cooking.
--   - A station marks ITS PART of an order done (order_station_done). The
--     order's own status is untouched: one cook finishing the chips must not
--     tell the floor the whole table's food is ready. The main board shows
--     which stations are done; whoever runs the pass marks the order ready,
--     exactly as before.
--
-- Printing is a separate, later deliverable (docs/COMPETITIVE_ROADMAP.md).

create table public.kitchen_stations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),

  constraint kitchen_stations_restaurant_id_id_key unique (restaurant_id, id),
  constraint kitchen_stations_name_length check (char_length(btrim(name)) between 1 and 40)
);

create unique index kitchen_stations_name_unique
  on public.kitchen_stations (restaurant_id, lower(btrim(name)));

comment on table public.kitchen_stations is
  'Phase I: where in the kitchen a dish is made (grill, fry, cold...). Per restaurant. Deleting one unassigns its dishes and open lines rather than deleting them.';

alter table public.kitchen_stations enable row level security;

create policy "kitchen_stations_select_members"
  on public.kitchen_stations for select to authenticated
  using (public.is_restaurant_member(restaurant_id));

create policy "kitchen_stations_insert_owner_manager"
  on public.kitchen_stations for insert to authenticated
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "kitchen_stations_update_owner_manager"
  on public.kitchen_stations for update to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "kitchen_stations_delete_owner_manager"
  on public.kitchen_stations for delete to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));

-- The dish's station. Composite FK: a dish can only be sent to a station of
-- its own restaurant. ON DELETE SET NULL (station_id) clears only the
-- station, never the restaurant_id half of the key.
alter table public.menu_items
  add column station_id uuid,
  add constraint menu_items_station_same_restaurant
    foreign key (restaurant_id, station_id)
    references public.kitchen_stations (restaurant_id, id)
    on delete set null (station_id);

create index menu_items_station_id_idx on public.menu_items (station_id)
  where station_id is not null;

comment on column public.menu_items.station_id is
  'Phase I: the kitchen station that makes this dish, or null (shown on every station).';

-- The line's station, frozen when the order is placed.
alter table public.order_items
  add column station_id uuid,
  add constraint order_items_station_same_restaurant
    foreign key (restaurant_id, station_id)
    references public.kitchen_stations (restaurant_id, id)
    on delete set null (station_id);

comment on column public.order_items.station_id is
  'Phase I: the station this line was sent to when the order was placed — copied from menu_items.station_id by a trigger, so reassigning a dish mid-service does not move tickets already cooking.';

create function public.order_item_take_station()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.station_id is null and new.menu_item_id is not null then
    select mi.station_id into new.station_id
    from public.menu_items mi
    where mi.id = new.menu_item_id
      and mi.restaurant_id = new.restaurant_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.order_item_take_station() from public, anon, authenticated;

create trigger order_items_take_station
  before insert on public.order_items
  for each row execute function public.order_item_take_station();

-- A station's part of an order, done.
create table public.order_station_done (
  order_id uuid not null,
  station_id uuid not null,
  restaurant_id uuid not null,
  done_at timestamptz not null default now(),
  done_by uuid references auth.users (id) on delete set null,

  primary key (order_id, station_id),

  constraint order_station_done_order_same_restaurant
    foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id)
    on delete cascade,
  constraint order_station_done_station_same_restaurant
    foreign key (restaurant_id, station_id)
    references public.kitchen_stations (restaurant_id, id)
    on delete cascade
);

comment on table public.order_station_done is
  'Phase I: which stations have finished their part of an order. Does not change the order''s status. Written only through set_order_station_done().';

alter table public.order_station_done enable row level security;

create policy "order_station_done_select_members"
  on public.order_station_done for select to authenticated
  using (public.is_restaurant_member(restaurant_id));

-- Mark (or unmark) a station's part of an order done. The kitchen and the
-- people who run it; not floor staff, who don't cook. Only for an order
-- still being worked on.
create function public.set_order_station_done(
  p_order_id uuid,
  p_station_id uuid,
  p_done boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant uuid;
  v_status text;
  v_role text;
begin
  select o.restaurant_id, o.status into v_restaurant, v_status
  from public.orders o
  where o.id = p_order_id;

  if v_restaurant is null then
    raise exception 'STATION_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_role := public.current_restaurant_role(v_restaurant);
  if v_role is null or v_role not in ('owner', 'manager', 'kitchen') then
    raise exception 'STATION_FORBIDDEN: only the kitchen, a manager or the owner can mark a station done'
      using errcode = '42501';
  end if;

  if v_status not in ('confirmed', 'preparing', 'ready') then
    raise exception 'STATION_ORDER_NOT_ACTIVE: accept the order before marking a station done'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.kitchen_stations s
    where s.id = p_station_id and s.restaurant_id = v_restaurant
  ) then
    raise exception 'STATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_done then
    insert into public.order_station_done (order_id, station_id, restaurant_id, done_by)
    values (p_order_id, p_station_id, v_restaurant, auth.uid())
    on conflict (order_id, station_id) do nothing;
  else
    delete from public.order_station_done
    where order_id = p_order_id and station_id = p_station_id;
  end if;

  -- Touch the order so every kitchen screen's existing live subscription
  -- (on orders) refreshes. Not a status change.
  update public.orders set updated_at = now() where id = p_order_id;
end;
$$;

comment on function public.set_order_station_done(uuid, uuid, boolean) is
  'Phase I: a station marks its part of an active order done (or undoes it). Owner, manager or kitchen only. Never changes the order''s status.';

revoke execute on function public.set_order_station_done(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_order_station_done(uuid, uuid, boolean) to authenticated;
