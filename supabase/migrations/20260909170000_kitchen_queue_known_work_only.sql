-- Stop counting orders the queue cannot actually measure.
--
-- Live, Nashta reported "12 orders / 24 minutes" ahead of a new order.
-- Both numbers were true and together they were nonsense: twelve orders
-- contributing an average of two minutes each. Most of those orders
-- reference dishes that have since been deleted from the menu, so the
-- LEFT JOIN found no preparation_time and coalesced it to zero.
--
-- The waiter reads orders_ahead for wording ("the kitchen is busy, there
-- are twelve orders ahead of yours") and prep_minutes_ahead for the
-- estimate. Fed those two figures it would tell a diner the kitchen is
-- slammed and their snack is nearly ready, in the same breath.
--
-- The fix is to treat an order with no known preparation time as UNKNOWN
-- work rather than ZERO work, and leave it out of both numbers. That is
-- the same rule the rest of this estimate already follows: a dish with no
-- recorded prep time makes the whole estimate null rather than instant
-- (see src/lib/orders/prep-estimate.ts), because "nobody recorded it" and
-- "it takes no time" are different claims.
--
-- The consequence, stated plainly: a restaurant that records no
-- preparation times gets no queue estimate at all. That is correct. An
-- invented one would be worse, and the waiter already knows how to say
-- the kitchen has not given a time.

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
    group by o.id
  )
  -- No coalesce to zero: max() over a set with no known value is NULL,
  -- and NULL is filtered out here rather than silently becoming work
  -- that takes no time. Both figures now describe the same set of orders,
  -- so they can no longer contradict one another.
  select coalesce(count(*), 0)::integer,
         coalesce(sum(order_minutes), 0)::integer
  from ahead
  where order_minutes is not null
    and order_minutes > 0
$$;

comment on function public.get_kitchen_queue_ahead(uuid, timestamptz) is
  'Aggregate kitchen load in front of one order: how many active orders were placed earlier AND have a measurable preparation time, plus their combined minutes. Orders whose dishes have no recorded prep time (or were deleted from the menu) are excluded from BOTH figures — unknown work, not zero work — so the count and the minutes always describe the same set. The only public read path onto other customers'' orders, and it returns two integers, never a row.';
