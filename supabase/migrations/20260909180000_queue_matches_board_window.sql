-- The queue must mean the same thing the kitchen board means.
--
-- The board shows the last 12 hours and nothing older (BOARD_LOOKBACK_HOURS
-- in src/lib/orders/kitchen.ts, per spec section 9), so a cook does not
-- start a shift facing yesterday's abandoned tickets. That is right, and
-- it is also the operational definition of "work the kitchen is doing".
--
-- This function had no window at all. It counted every order still marked
-- pending or preparing, forever. Nashta accumulated a dozen abandoned test
-- orders over nine days, and a diner ordering today was told there were
-- orders ahead of them that no cook could see and nobody was cooking.
--
-- Worse, they were unclearable: the only way to move an order out of
-- pending is the board, and the board will not show something that old.
-- So the estimate was being inflated by rows the product gave no way to
-- clear.
--
-- Matching the board's window fixes both. An order older than the board's
-- horizon is history, not a queue.

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
           max(mi.preparation_time) as order_minutes
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    left join public.menu_items mi on mi.id = oi.menu_item_id
    where o.restaurant_id = target_restaurant_id
      and o.status in ('pending', 'confirmed', 'preparing')
      and o.created_at < placed_before
      -- The same 12 hours the kitchen board shows. Kept as a literal
      -- rather than a shared constant because it is SQL and TypeScript
      -- either side of a boundary; the comment above and the one on
      -- BOARD_LOOKBACK_HOURS point at each other so a change to one is a
      -- change to both.
      and o.created_at > now() - interval '12 hours'
    group by o.id
  )
  select coalesce(count(*), 0)::integer,
         coalesce(sum(order_minutes), 0)::integer
  from ahead
  where order_minutes is not null
    and order_minutes > 0
$$;

comment on function public.get_kitchen_queue_ahead(uuid, timestamptz) is
  'Aggregate kitchen load in front of one order, over the same 12-hour window the kitchen board shows (BOARD_LOOKBACK_HOURS) — an order older than that is history, not a queue, and cannot even be cleared from the board. Orders with no measurable preparation time are excluded from BOTH figures: unknown work, not zero work. Returns two integers, never a row.';
