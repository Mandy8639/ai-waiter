-- The floor view: every table's state on one screen (/dashboard/floor).
--
-- floor_tables() returns the facts per table in one read; which state a
-- tile shows ("needs someone", "food ready", "eating"...) is decided in
-- src/lib/floor/core.ts, where it is unit-tested. Keeping the SQL to facts
-- means a wording or priority change never needs a migration.
--
-- It is security definer because staff cannot read customer_sessions
-- (their policies let a diner see only their own), and "someone scanned
-- the code but hasn't ordered" is only knowable from there. What leaves
-- the function is a count and a timestamp per table, never a diner's
-- identity or token.
--
-- tables.cleared_at is the "Clear table" button. Without payments
-- switched on, nothing tells Tableside a party has left, so a served
-- table would otherwise read "eating" until its orders aged out. Clearing
-- touches no order, session or request: the floor simply ignores what
-- happened at that table before the moment it was cleared.

alter table public.tables
  add column cleared_at timestamptz;

comment on column public.tables.cleared_at is
  'Set by clear_floor_table(): the floor view ignores orders and guest sessions at this table from before this moment. Changes nothing else.';

create or replace function public.floor_tables(p_restaurant_id uuid)
returns table (
  table_id uuid,
  table_number text,
  display_name text,
  cleared_at timestamptz,
  seated_since timestamptz,
  open_requests jsonb,
  active_orders integer,
  oldest_active_at timestamptz,
  active_status text,
  ready_orders integer,
  ready_since timestamptz,
  served_orders integer,
  last_order_change_at timestamptz,
  unpaid_orders integer,
  unpaid_total numeric,
  currency text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- Same gate as every staff read: a member who has passed two-step
  -- verification where it's on (current_restaurant_role()).
  if not public.is_restaurant_member(p_restaurant_id) then
    return;
  end if;

  return query
    with visible as (
      select t.id, t.table_number, t.display_name, t.cleared_at,
             -- A visit is today's work: nothing older than 12 hours, and
             -- nothing from before the table was last cleared.
             greatest(coalesce(t.cleared_at, '-infinity'::timestamptz),
                      now() - interval '12 hours') as since
      from public.tables t
      where t.restaurant_id = p_restaurant_id
        and t.is_active
        and t.kind = 'table'
    ),
    visit_orders as (
      select o.table_id, o.id, o.status, o.total, o.currency,
             o.created_at, o.updated_at,
             exists (
               select 1
               from public.payment_orders po
               join public.order_payments p on p.id = po.payment_id
               where po.order_id = o.id and p.status = 'succeeded'
             ) as paid
      from public.orders o
      join visible v on v.id = o.table_id
      where o.restaurant_id = p_restaurant_id
        and o.status <> 'cancelled'
        and o.created_at > v.since
    )
    select
      v.id,
      v.table_number,
      v.display_name,
      v.cleared_at,
      (
        select min(s.started_at)
        from public.customer_sessions s
        where s.restaurant_id = p_restaurant_id
          and s.table_id = v.id
          and s.status = 'active'
          and s.expires_at > now()
          and s.last_active_at > greatest(v.since, now() - interval '90 minutes')
      ),
      coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'id', r.id, 'kind', r.kind, 'note', r.note,
                   'created_at', r.created_at
                 ) order by r.created_at)
        from public.table_requests r
        where r.restaurant_id = p_restaurant_id
          and r.table_id = v.id
          and r.status = 'open'
      ), '[]'::jsonb),
      (select count(*)::integer from visit_orders o
        where o.table_id = v.id and o.status in ('pending', 'confirmed', 'preparing')),
      (select min(o.created_at) from visit_orders o
        where o.table_id = v.id and o.status in ('pending', 'confirmed', 'preparing')),
      -- The least advanced active order: "new" outranks "preparing", so a
      -- table with one order of each reads as still waiting on the kitchen.
      (select o.status from visit_orders o
        where o.table_id = v.id and o.status in ('pending', 'confirmed', 'preparing')
        order by case o.status when 'pending' then 0 when 'confirmed' then 1 else 2 end
        limit 1),
      (select count(*)::integer from visit_orders o
        where o.table_id = v.id and o.status = 'ready'),
      (select min(o.updated_at) from visit_orders o
        where o.table_id = v.id and o.status = 'ready'),
      (select count(*)::integer from visit_orders o
        where o.table_id = v.id and o.status = 'served'),
      (select max(o.updated_at) from visit_orders o where o.table_id = v.id),
      (select count(*)::integer from visit_orders o
        where o.table_id = v.id and not o.paid),
      (select coalesce(sum(o.total), 0) from visit_orders o
        where o.table_id = v.id and not o.paid),
      (select o.currency from visit_orders o where o.table_id = v.id limit 1)
    from visible v
    order by v.table_number;
end;
$$;

comment on function public.floor_tables(uuid) is
  'The floor view: per active table, open requests, the visit''s orders by stage, what is unpaid, and whether a guest is seated. Facts only; src/lib/floor/core.ts decides what each tile says.';

revoke execute on function public.floor_tables(uuid) from public, anon;
grant execute on function public.floor_tables(uuid) to authenticated, service_role;

-- "Clear table": the party has left. Any member, like answering a request.
create or replace function public.clear_floor_table(p_table_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
begin
  select restaurant_id into v_restaurant_id
  from public.tables where id = p_table_id;
  if v_restaurant_id is null then
    raise exception 'FLOOR_TABLE_NOT_FOUND';
  end if;
  if not public.is_restaurant_member(v_restaurant_id) then
    raise exception 'FLOOR_TABLE_FORBIDDEN';
  end if;

  update public.tables set cleared_at = now() where id = p_table_id;

  -- Other floor screens hear about it on the staff topic they already
  -- listen to.
  perform public.broadcast_change(
    'requests:restaurant:' || v_restaurant_id,
    jsonb_build_object('table', 'tables', 'op', 'CLEAR', 'id', p_table_id)
  );
end;
$$;

comment on function public.clear_floor_table(uuid) is
  'Marks a table cleared for the floor view. Touches no order, session or request.';

revoke execute on function public.clear_floor_table(uuid) from public, anon;
grant execute on function public.clear_floor_table(uuid) to authenticated, service_role;
