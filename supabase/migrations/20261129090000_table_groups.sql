-- Ordering together: friends at one table fill one order from their own
-- phones, and one of them sends it to the kitchen as a single ticket.
--
-- THE SHAPE. Each phone keeps its own cart, exactly as before, with the
-- same "only your own cart" RLS. A table group links those carts:
--   - table_groups: one open group per table at a time.
--   - table_group_members: which guest sessions are in it, with an
--     optional first name so friends can tell whose dish is whose.
-- Reading everyone's lines goes through table_group_cart(), a definer
-- function that returns them only to members. Nobody can change another
-- member's lines: cart edits still go through the existing own-cart path.
--
-- SENDING. submit_table_group_order() locks the group, moves every
-- member's lines into the sender's cart, and calls submit_order(). So the
-- one ordering path that prices, re-validates, refuses sold-out dishes and
-- applies busy mode is the one that runs; nothing about ordering is
-- re-implemented. If submit_order() refuses, the whole transaction rolls
-- back and every line is back in its owner's cart.
--
-- SEEING THE ORDER. orders.table_group_id records which group sent an
-- order, and order_belongs_to_caller() now also says yes to that group's
-- members. That function gates order_items, order_item_modifiers,
-- order_status_history and the diner's payment paths, so a member can
-- follow the order and pay for it. Cancelling stays the sender's alone
-- (customer_cancel_order() checks the session directly, unchanged).
--
-- WHEN A GROUP ENDS. A group is live while it is open, the table hasn't
-- been cleared on the Floor view since it started, and something happened
-- in it within the last 45 minutes (a join, a cart change, an order). A
-- new party sitting down at an uncleared table therefore isn't offered the
-- last party's group for long, and when it is, the prompt names who is in
-- it, so it is easy to tell it isn't theirs.

-- ── Tables ───────────────────────────────────────────────────────────────

create table public.table_groups (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  table_id uuid not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  closed_at timestamptz,

  constraint table_groups_status_valid check (status in ('open', 'closed')),
  constraint table_groups_closed_when_closed
    check ((status = 'closed') = (closed_at is not null)),
  constraint table_groups_table_same_restaurant
    foreign key (restaurant_id, table_id)
    references public.tables (restaurant_id, id)
    on delete cascade
);

comment on table public.table_groups is
  'Friends at one table ordering together (20261129090000). Read and written only through the table group functions.';

create index table_groups_table_id_idx on public.table_groups (table_id, created_at desc);

create table public.table_group_members (
  group_id uuid not null references public.table_groups (id) on delete cascade,
  session_id uuid not null references public.customer_sessions (id) on delete cascade,
  -- 1, 2, 3...: "Guest 2" when no name was given, and the display order.
  position integer not null,
  display_name text,
  joined_at timestamptz not null default now(),

  primary key (group_id, session_id),
  constraint table_group_members_position_unique unique (group_id, position),
  constraint table_group_members_name_length
    check (display_name is null or length(display_name) between 1 and 30)
);

create index table_group_members_session_id_idx on public.table_group_members (session_id);

-- No policies: nothing reads these tables directly, only the definer
-- functions below, each of which checks the caller.
alter table public.table_groups enable row level security;
alter table public.table_group_members enable row level security;

alter table public.orders
  add column table_group_id uuid references public.table_groups (id) on delete set null;

comment on column public.orders.table_group_id is
  'The table group that sent this order, if any. Its members may see and pay for it (order_belongs_to_caller()).';

create index orders_table_group_id_idx on public.orders (table_group_id)
  where table_group_id is not null;

-- ── Helpers ──────────────────────────────────────────────────────────────

-- The caller's own active guest session, or null.
create function public.caller_customer_session()
returns public.customer_sessions
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions;
begin
  select * into v_session
  from public.customer_sessions
  where user_id = auth.uid()
    and status = 'active'
    and expires_at > now()
  limit 1;
  return v_session;
end;
$$;

revoke execute on function public.caller_customer_session() from public, anon, authenticated;

-- Live: open, not cleared from the Floor view since it started, and
-- something happened in the last 45 minutes.
create function public.table_group_is_live(p_group_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_group public.table_groups;
  v_cleared_at timestamptz;
  v_last timestamptz;
begin
  select * into v_group from public.table_groups where id = p_group_id;
  if v_group.id is null or v_group.status <> 'open' then
    return false;
  end if;

  select cleared_at into v_cleared_at from public.tables where id = v_group.table_id;
  if v_cleared_at is not null and v_cleared_at >= v_group.created_at then
    return false;
  end if;

  select greatest(
    v_group.last_activity_at,
    (select max(ci.updated_at)
     from public.table_group_members m
     join public.carts c on c.customer_session_id = m.session_id
     join public.cart_items ci on ci.cart_id = c.id
     where m.group_id = p_group_id)
  ) into v_last;

  return v_last > now() - interval '45 minutes';
end;
$$;

revoke execute on function public.table_group_is_live(uuid) from public, anon, authenticated;

-- Is the caller a member of this group? Used by the orders policy and the
-- broadcast check. plpgsql, not sql: it calls auth.uid() (PGRST202 note in
-- 20260911200000_order_table_label.sql).
create function public.caller_in_table_group(p_group_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return exists (
    select 1
    from public.table_group_members m
    join public.customer_sessions cs on cs.id = m.session_id
    where m.group_id = p_group_id
      and cs.user_id = auth.uid()
  );
end;
$$;

revoke execute on function public.caller_in_table_group(uuid) from public, anon;
grant execute on function public.caller_in_table_group(uuid) to authenticated, service_role;

-- The caller's live group, if they are in one.
create function public.caller_live_table_group()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions := public.caller_customer_session();
  v_group_id uuid;
begin
  if v_session.id is null then
    return null;
  end if;
  for v_group_id in
    select m.group_id
    from public.table_group_members m
    join public.table_groups g on g.id = m.group_id
    where m.session_id = v_session.id and g.status = 'open'
    order by g.created_at desc
  loop
    if public.table_group_is_live(v_group_id) then
      return v_group_id;
    end if;
  end loop;
  return null;
end;
$$;

revoke execute on function public.caller_live_table_group() from public, anon, authenticated;

create function public.broadcast_table_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.broadcast_change(
    'cart:group:' || p_group_id,
    jsonb_build_object('table', 'table_groups', 'id', p_group_id)
  );
end;
$$;

revoke execute on function public.broadcast_table_group(uuid) from public, anon, authenticated;

create function public.clean_group_name(p_name text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 30), '')
$$;

revoke execute on function public.clean_group_name(text) from public, anon, authenticated;

-- ── What a guest sees ────────────────────────────────────────────────────

-- The caller's group, or a live group at their table they could join.
-- {"kind": "none" | "member" | "can_join" | "not_a_table",
--  "group_id": ..., "members": [{"position", "name", "is_me"}]}
create function public.table_group_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions := public.caller_customer_session();
  v_group_id uuid;
  v_kind text;
  v_table_kind text;
begin
  if v_session.id is null then
    return jsonb_build_object('kind', 'none');
  end if;

  select kind into v_table_kind from public.tables where id = v_session.table_id;
  if v_table_kind is distinct from 'table' then
    return jsonb_build_object('kind', 'not_a_table');
  end if;

  v_group_id := public.caller_live_table_group();
  v_kind := 'member';

  if v_group_id is null then
    select g.id into v_group_id
    from public.table_groups g
    where g.table_id = v_session.table_id
      and g.status = 'open'
      and public.table_group_is_live(g.id)
    order by g.created_at desc
    limit 1;
    v_kind := 'can_join';
  end if;

  if v_group_id is null then
    return jsonb_build_object('kind', 'none');
  end if;

  return jsonb_build_object(
    'kind', v_kind,
    'group_id', v_group_id,
    'members', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'position', m.position,
                 'name', m.display_name,
                 'is_me', m.session_id = v_session.id
               ) order by m.position)
      from public.table_group_members m
      where m.group_id = v_group_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.table_group_state() from public, anon;
grant execute on function public.table_group_state() to authenticated, service_role;

-- Every member's cart lines, for members only. Prices are the stored cart
-- prices; submit_order() re-prices when the order is sent.
create function public.table_group_cart()
returns table (
  cart_item_id uuid,
  member_position integer,
  member_name text,
  is_mine boolean,
  menu_item_id uuid,
  quantity integer,
  line_total numeric,
  spice_preference text,
  notes text,
  modifiers jsonb,
  added_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions := public.caller_customer_session();
  v_group_id uuid := public.caller_live_table_group();
begin
  if v_group_id is null then
    return;
  end if;

  return query
    select ci.id, m.position, m.display_name, m.session_id = v_session.id,
           ci.menu_item_id, ci.quantity, ci.line_total,
           ci.spice_preference::text, ci.notes,
           coalesce((
             select jsonb_agg(jsonb_build_object('name', cim.name) order by cim.name)
             from public.cart_item_modifiers cim
             where cim.cart_item_id = ci.id
           ), '[]'::jsonb),
           ci.created_at
    from public.table_group_members m
    join public.carts c on c.customer_session_id = m.session_id
    join public.cart_items ci on ci.cart_id = c.id
    where m.group_id = v_group_id
    order by m.position, ci.created_at;
end;
$$;

revoke execute on function public.table_group_cart() from public, anon;
grant execute on function public.table_group_cart() to authenticated, service_role;

-- ── Starting, joining, leaving ───────────────────────────────────────────

create function public.start_table_group(p_display_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions := public.caller_customer_session();
  v_table public.tables;
  v_group_id uuid;
begin
  if v_session.id is null then
    raise exception 'TABLE_GROUP_NO_SESSION';
  end if;

  -- One start at a time per table, so two phones tapping together get one
  -- group, not two.
  select * into v_table from public.tables where id = v_session.table_id for update;
  if v_table.kind is distinct from 'table' then
    raise exception 'TABLE_GROUP_NOT_AT_TABLE';
  end if;

  v_group_id := public.caller_live_table_group();
  if v_group_id is not null then
    return v_group_id;
  end if;

  if exists (
    select 1 from public.table_groups g
    where g.table_id = v_table.id and g.status = 'open'
      and public.table_group_is_live(g.id)
  ) then
    raise exception 'TABLE_GROUP_EXISTS';
  end if;

  insert into public.table_groups (restaurant_id, table_id)
  values (v_session.restaurant_id, v_table.id)
  returning id into v_group_id;

  insert into public.table_group_members (group_id, session_id, position, display_name)
  values (v_group_id, v_session.id, 1, public.clean_group_name(p_display_name));

  return v_group_id;
end;
$$;

revoke execute on function public.start_table_group(text) from public, anon;
grant execute on function public.start_table_group(text) to authenticated, service_role;

create function public.join_table_group(p_group_id uuid, p_display_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions := public.caller_customer_session();
  v_group public.table_groups;
  v_position integer;
begin
  if v_session.id is null then
    raise exception 'TABLE_GROUP_NO_SESSION';
  end if;

  select * into v_group from public.table_groups where id = p_group_id for update;
  -- Another table's group, or one that's over, looks the same: not found.
  if v_group.id is null
     or v_group.table_id <> v_session.table_id
     or not public.table_group_is_live(v_group.id) then
    raise exception 'TABLE_GROUP_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.table_group_members
    where group_id = v_group.id and session_id = v_session.id
  ) then
    return v_group.id;
  end if;

  if (select count(*) from public.table_group_members where group_id = v_group.id) >= 20 then
    raise exception 'TABLE_GROUP_FULL';
  end if;

  select coalesce(max(position), 0) + 1 into v_position
  from public.table_group_members where group_id = v_group.id;

  insert into public.table_group_members (group_id, session_id, position, display_name)
  values (v_group.id, v_session.id, v_position, public.clean_group_name(p_display_name));

  update public.table_groups set last_activity_at = now() where id = v_group.id;
  perform public.broadcast_table_group(v_group.id);
  return v_group.id;
end;
$$;

revoke execute on function public.join_table_group(uuid, text) from public, anon;
grant execute on function public.join_table_group(uuid, text) to authenticated, service_role;

-- Leaving keeps your own cart; it just stops being shared.
create function public.leave_table_group()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions := public.caller_customer_session();
  v_group_id uuid := public.caller_live_table_group();
begin
  if v_group_id is null then
    return;
  end if;

  delete from public.table_group_members
  where group_id = v_group_id and session_id = v_session.id;

  if not exists (select 1 from public.table_group_members where group_id = v_group_id) then
    update public.table_groups
    set status = 'closed', closed_at = now()
    where id = v_group_id;
  end if;

  perform public.broadcast_table_group(v_group_id);
end;
$$;

revoke execute on function public.leave_table_group() from public, anon;
grant execute on function public.leave_table_group() to authenticated, service_role;

-- ── Sending ──────────────────────────────────────────────────────────────

create function public.submit_table_group_order(
  p_idempotency_key text,
  p_customer_note text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.customer_sessions := public.caller_customer_session();
  v_group_id uuid := public.caller_live_table_group();
  v_cart_id uuid;
  v_order public.orders;
begin
  if v_session.id is null then
    raise exception 'ORDER_NO_SESSION: your session has expired — scan the table''s QR code again';
  end if;
  if v_group_id is null then
    raise exception 'TABLE_GROUP_NOT_MEMBER';
  end if;

  -- A retry of a send that already went through: return that order, and
  -- move nothing (other members may have added since).
  select * into v_order from public.orders
  where customer_session_id = v_session.id and idempotency_key = p_idempotency_key;
  if found then
    return v_order;
  end if;

  -- One send at a time per group. A second phone tapping at the same
  -- moment waits here, then finds the carts empty below.
  perform 1 from public.table_groups where id = v_group_id for update;

  select * into v_order from public.orders
  where customer_session_id = v_session.id and idempotency_key = p_idempotency_key;
  if found then
    return v_order;
  end if;

  insert into public.carts (customer_session_id, restaurant_id)
  values (v_session.id, v_session.restaurant_id)
  on conflict (customer_session_id) do nothing;
  select id into v_cart_id from public.carts where customer_session_id = v_session.id;

  perform 1
  from public.carts c
  join public.table_group_members m on m.session_id = c.customer_session_id
  where m.group_id = v_group_id
  order by c.id
  for update of c;

  if not exists (
    select 1
    from public.table_group_members m
    join public.carts c on c.customer_session_id = m.session_id
    join public.cart_items ci on ci.cart_id = c.id
    where m.group_id = v_group_id
  ) then
    -- Someone else just sent it: that's this table's order, not an error.
    select * into v_order from public.orders
    where table_group_id = v_group_id
      and created_at > now() - interval '2 minutes'
    order by created_at desc
    limit 1;
    if found then
      return v_order;
    end if;
    raise exception 'ORDER_CART_EMPTY: your cart is empty';
  end if;

  update public.cart_items ci
  set cart_id = v_cart_id
  from public.carts c, public.table_group_members m
  where ci.cart_id = c.id
    and c.customer_session_id = m.session_id
    and m.group_id = v_group_id
    and c.id <> v_cart_id
    and ci.restaurant_id = v_session.restaurant_id;

  v_order := public.submit_order(p_idempotency_key, p_customer_note);

  update public.orders set table_group_id = v_group_id
  where id = v_order.id
  returning * into v_order;

  update public.table_groups set last_activity_at = now() where id = v_group_id;
  perform public.broadcast_table_group(v_group_id);
  return v_order;
end;
$$;

comment on function public.submit_table_group_order(text, text) is
  'Sends every member''s cart lines as one order through submit_order(), as the caller. Retries and simultaneous sends return the one order.';

revoke execute on function public.submit_table_group_order(text, text) from public, anon;
grant execute on function public.submit_table_group_order(text, text) to authenticated, service_role;

-- ── Live updates ─────────────────────────────────────────────────────────

-- A member's cart changed: tell the group's phones.
create function public.broadcast_cart_item_group_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cart_id uuid := case when tg_op = 'DELETE' then old.cart_id else new.cart_id end;
  v_group_id uuid;
begin
  for v_group_id in
    select m.group_id
    from public.carts c
    join public.table_group_members m on m.session_id = c.customer_session_id
    join public.table_groups g on g.id = m.group_id and g.status = 'open'
    where c.id = v_cart_id
  loop
    perform public.broadcast_table_group(v_group_id);
  end loop;
  return null;
end;
$$;

revoke execute on function public.broadcast_cart_item_group_change() from public, anon, authenticated;

create trigger trg_cart_items_group_broadcast
  after insert or update or delete on public.cart_items
  for each row execute function public.broadcast_cart_item_group_change();

-- ── Who may see an order ─────────────────────────────────────────────────

create or replace function public.order_belongs_to_caller(target_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.orders o
    join public.customer_sessions cs on cs.id = o.customer_session_id
    where o.id = target_order_id
      and cs.user_id = auth.uid()
  )
  or exists (
    select 1
    from public.orders o
    join public.table_group_members m on m.group_id = o.table_group_id
    join public.customer_sessions cs on cs.id = m.session_id
    where o.id = target_order_id
      and cs.user_id = auth.uid()
  )
$$;

comment on function public.order_belongs_to_caller(uuid) is
  'True if the given order was placed by the calling customer''s own session, or sent by a table group they are in. Used throughout order_items/order_item_modifiers/order_status_history and payment RLS.';

drop policy "orders_select_own_or_staff" on public.orders;

create policy "orders_select_own_or_staff"
  on public.orders
  for select
  to authenticated
  using (
    exists (
      select 1 from public.customer_sessions cs
      where cs.id = orders.customer_session_id and cs.user_id = auth.uid()
    )
    or (
      orders.table_group_id is not null
      and public.caller_in_table_group(orders.table_group_id)
    )
    or public.is_restaurant_member(restaurant_id)
  );

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
        public.order_belongs_to_caller(o.id)
        or public.is_restaurant_member(o.restaurant_id)
      );
end;
$$;

-- Same as 20261127090000, plus the group's cart topic, and an order's own
-- topic for the members of the group that sent it.
create or replace function public.can_receive_broadcast(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_parts text[] := string_to_array(coalesce(p_topic, ''), ':');
  v_id uuid;
begin
  if array_length(v_parts, 1) <> 3
     or v_parts[3] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_id := v_parts[3]::uuid;

  case v_parts[1] || ':' || v_parts[2]
    when 'orders:restaurant', 'requests:restaurant' then
      return public.is_restaurant_member(v_id);
    when 'reservations:restaurant' then
      return coalesce(
        public.current_restaurant_role(v_id) in ('owner', 'manager', 'staff'),
        false
      );
    when 'orders:order' then
      return exists (
        select 1 from public.orders o
        where o.id = v_id
          and (
            public.order_belongs_to_caller(o.id)
            or public.is_restaurant_member(o.restaurant_id)
          )
      );
    when 'cart:group' then
      return public.caller_in_table_group(v_id);
    else
      return false;
  end case;
end;
$$;
