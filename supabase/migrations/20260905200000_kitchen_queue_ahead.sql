-- How much work is already in front of this order.
--
-- The per-order estimate this supports was wrong in one obvious way: it
-- timed each order as though the kitchen were empty. Table 1 orders a
-- 15-minute thali, Table 2 orders one a minute later, and both were told
-- 15 minutes. The second one is not getting food in 15 minutes.
--
-- A diner cannot see this for themselves: orders_select_own_or_staff
-- scopes SELECT to their own customer session, which is correct and must
-- stay that way. So this follows get_public_order_settings() and
-- get_table_by_token(): a narrow SECURITY DEFINER function returning ONLY
-- the two aggregate numbers the estimate needs — never a row, a dish, a
-- table number or another diner's order.
--
-- What it reveals is how busy a kitchen is, to anyone who can name the
-- restaurant. That is the same thing you learn by looking through the
-- window, and it is the least that can be returned while still answering
-- "how long?" honestly.
--
-- 'ready' is deliberately NOT counted as work ahead: that food is cooked
-- and waiting to be carried, so it is no longer occupying the kitchen.
-- 'served' and 'cancelled' likewise.
--
-- Each order ahead contributes the MAX of its dishes, not the sum, for
-- the same reason the caller does: a kitchen cooks one order's dishes in
-- parallel. Those maxima are then SUMMED across orders, which assumes the
-- kitchen finishes one order before starting the next — the pessimistic
-- end of the range the caller reports. See src/lib/orders/prep-estimate.ts
-- for how the two bounds are used, and why there is deliberately no
-- "how parallel is this kitchen" constant to tune.

create or replace function public.get_kitchen_queue_ahead(
  target_restaurant_id uuid,
  placed_before timestamptz
)
returns table (orders_ahead integer, prep_minutes_ahead integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ahead as (
    select o.id,
           coalesce(max(mi.preparation_time), 0) as order_minutes
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    left join public.menu_items mi on mi.id = oi.menu_item_id
    where o.restaurant_id = target_restaurant_id
      and o.status in ('pending', 'confirmed', 'preparing')
      and o.created_at < placed_before
    group by o.id
  )
  select coalesce(count(*), 0)::integer,
         coalesce(sum(order_minutes), 0)::integer
  from ahead
$$;

comment on function public.get_kitchen_queue_ahead(uuid, timestamptz) is
  'Aggregate kitchen load in front of one order: how many active orders were placed earlier, and their combined preparation minutes. The only public read path onto other customers'' orders, and it returns two integers — never a row. See docs/ai.md#how-long-will-my-order-be.';

grant execute on function public.get_kitchen_queue_ahead(uuid, timestamptz) to anon, authenticated;
