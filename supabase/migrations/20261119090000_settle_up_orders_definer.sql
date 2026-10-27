-- Settle up's unpaid-orders list checks membership once instead of per row.
--
-- settle_up_orders() (20261113090000) ran as the caller, so the orders read
-- rule (orders_select_own_or_staff: a membership and two-step check through
-- current_restaurant_role()) was judged on every order in the window, and
-- the payment rules again inside the "already paid?" lookup. Settle up
-- calls it on every refresh; in the busy-Saturday simulation it averaged
-- 1.4 s a call under load, and its cost grows with every night of orders.
--
-- Now it runs as its owner and asks is_restaurant_member() once, up front,
-- the shape settle_up_splits() (20261115090000) already has. The rows it
-- returns are unchanged: this restaurant's, unpaid, for its own people.

create or replace function public.settle_up_orders(p_restaurant_id uuid, p_since timestamptz)
returns table (
  id uuid,
  order_number bigint,
  status text,
  total numeric,
  discount_total numeric,
  currency text,
  table_id uuid,
  customer_session_id uuid,
  pickup_at timestamptz,
  pickup_name text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_restaurant_member(p_restaurant_id) then
    return;
  end if;

  return query
    select o.id, o.order_number, o.status, o.total, o.discount_total, o.currency,
           o.table_id, o.customer_session_id, o.pickup_at, o.pickup_name, o.created_at
    from public.orders o
    where o.restaurant_id = p_restaurant_id
      and o.status <> 'cancelled'
      and o.created_at > p_since
      and not exists (
        select 1
        from public.payment_orders po
        join public.order_payments p on p.id = po.payment_id
        where po.order_id = o.id and p.status = 'succeeded'
      )
    order by o.created_at
    limit 500;
end;
$$;

revoke execute on function public.settle_up_orders(uuid, timestamptz) from public, anon;
grant execute on function public.settle_up_orders(uuid, timestamptz) to authenticated, service_role;
