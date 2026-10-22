-- Two highlight sections at the top of the diner menu:
--
-- "House favorites": dishes the restaurant stars itself. A plain column on
-- menu_items, edited like any other dish field (owners and managers, under
-- the existing menu_items policies).
--
-- "Most ordered this month": from real orders. dish_daily_stats already
-- counts every order line per dish per day (20260930090000), but it has no
-- read policy at all: its counts are the owner's business. So diners get
-- this one SECURITY DEFINER function, which returns dish ids and a rank,
-- never the counts, and only once there's enough to mean something:
--   * at least 20 orders of anything in the last 30 days, so a new
--     restaurant with three orders doesn't call one dish "most ordered";
--   * a dish needs at least 3 orders itself;
--   * only dishes a diner can see now (available, category active);
--   * at most 6.

alter table public.menu_items
  add column is_house_favorite boolean not null default false;

comment on column public.menu_items.is_house_favorite is
  'Starred by the restaurant: shown in "House favorites" at the top of the diner menu, with a badge, and named as such by the AI waiter.';

create function public.get_most_ordered_dishes(p_restaurant_id uuid)
returns table (menu_item_id uuid, rank integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with recent as (
    select s.menu_item_id, sum(s.ordered)::integer as ordered
    from public.dish_daily_stats s
    where s.restaurant_id = p_restaurant_id
      and s.day >= current_date - 30
    group by s.menu_item_id
  ),
  enough as (
    select coalesce(sum(r.ordered), 0) >= 20 as ok from recent r
  )
  select r.menu_item_id,
         (row_number() over (order by r.ordered desc, mi.display_order, mi.name))::integer
  from recent r
  join public.menu_items mi on mi.id = r.menu_item_id
  where (select ok from enough)
    and public.is_restaurant_publicly_active(p_restaurant_id)
    and public.is_menu_item_publicly_visible(r.menu_item_id)
    and r.ordered >= 3
  order by r.ordered desc, mi.display_order, mi.name
  limit 6
$$;

comment on function public.get_most_ordered_dishes(uuid) is
  'The diner menu''s "Most ordered this month": up to 6 visible dishes by orders in the last 30 days, ids and rank only (never counts), and nothing until the restaurant has 20+ orders in that time. Anon-readable by design.';

revoke execute on function public.get_most_ordered_dishes(uuid) from public;
grant execute on function public.get_most_ordered_dishes(uuid) to anon, authenticated;
