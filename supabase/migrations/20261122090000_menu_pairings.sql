-- The menu knowledge graph's "ordered together" edges
-- (src/lib/menu-graph/core.ts).
--
-- "What goes with the butter chicken?" is best answered by what this
-- restaurant's guests actually order with it. A diner can't read other
-- people's orders (rightly), so this function returns only counts: for
-- each pair of dishes, how many separate visits ordered both in the last
-- 90 days. A visit is a diner's session (several rounds at one table
-- count once), or the order itself when staff rang it up.
--
-- Privacy: counts only, never who or when, and a pair needs at least 3
-- visits before it's returned, so a quiet restaurant can't reveal one
-- guest's order through it. Cancelled orders don't count.

create function public.menu_pairings(p_restaurant_id uuid)
returns table (menu_item_id uuid, other_menu_item_id uuid, visits integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with lines as (
    select distinct
      coalesce(o.customer_session_id, o.id) as visit,
      oi.menu_item_id
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    where o.restaurant_id = p_restaurant_id
      and o.status <> 'cancelled'
      and o.created_at > now() - interval '90 days'
      and oi.menu_item_id is not null
  ),
  pairs as (
    select a.menu_item_id, b.menu_item_id as other_menu_item_id,
           count(*)::integer as visits
    from lines a
    join lines b on b.visit = a.visit and b.menu_item_id <> a.menu_item_id
    group by a.menu_item_id, b.menu_item_id
    having count(*) >= 3
  ),
  ranked as (
    select p.*, row_number() over (
      partition by p.menu_item_id order by p.visits desc, p.other_menu_item_id
    ) as rank
    from pairs p
  )
  select menu_item_id, other_menu_item_id, visits
  from ranked
  where rank <= 10
$$;

comment on function public.menu_pairings(uuid) is
  'For each dish, the dishes guests ordered with it in the last 90 days (separate visits, at least 3), top 10. Counts only. Used by the AI waiter''s get_pairings tool.';

revoke execute on function public.menu_pairings(uuid) from public, anon;
grant execute on function public.menu_pairings(uuid) to authenticated, service_role;
