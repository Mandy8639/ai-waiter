-- A diner's order page showed "—" where the table belongs ("Table 1").
--
-- getOrderById() read the table's number and name straight from
-- public.tables, whose only SELECT policy is members-only
-- (tables_select_members, 20260821130600_tables.sql). A diner is not a
-- member, so the read came back empty for every diner and the page fell
-- back to its placeholder. Staff screens were unaffected because staff are
-- members.
--
-- Rather than add a customer SELECT policy to `tables` (which would expose
-- other tables' public_tokens and let a diner enumerate the floor plan),
-- this follows get_table_by_token()'s pattern: a narrow SECURITY DEFINER
-- function that returns only the two display fields, for one order.
--
-- SECURITY DEFINER bypasses RLS, so the function must do the orders check
-- itself. It repeats orders_select_own_or_staff (20260823100200_orders.sql)
-- exactly: the diner whose customer session placed the order, or a member
-- of the order's restaurant. Anyone else gets no rows.
--
-- plpgsql rather than sql because it calls auth.uid(): a `language sql`
-- function that reaches into the auth schema can leave PostgREST unable to
-- find it (PGRST202) until its schema cache is rebuilt.
create or replace function public.get_order_table(p_order_id uuid)
returns table (
  table_number text,
  display_name text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    select t.table_number, t.display_name
    from public.orders o
    join public.tables t on t.id = o.table_id
    where o.id = p_order_id
      and (
        exists (
          select 1
          from public.customer_sessions cs
          where cs.id = o.customer_session_id
            and cs.user_id = auth.uid()
        )
        or public.is_restaurant_member(o.restaurant_id)
      );
end;
$$;

comment on function public.get_order_table(uuid) is
  'Table number and display name for one order, returned only to the diner whose session placed it or to the restaurant''s staff (mirrors orders_select_own_or_staff). A read path onto tables for diners that exposes nothing else. See docs/security.md#public-restaurant-menu-access.';

-- Orders are only ever visible to `authenticated` (anonymous-auth diners
-- included), never to `anon`, so neither is this.
revoke execute on function public.get_order_table(uuid) from public, anon;
grant execute on function public.get_order_table(uuid) to authenticated;
