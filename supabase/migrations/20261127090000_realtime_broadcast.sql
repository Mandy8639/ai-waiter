-- Live updates by Broadcast instead of postgres_changes.
--
-- WHY. The 2026-10-28 busy-night simulation (12 tables, phones, kitchen,
-- waiters) found the database's biggest cost was Realtime's
-- postgres_changes: for every change to orders, order_payments,
-- table_requests and reservations, Realtime decodes it from the WAL and
-- checks it against the permissions of every open screen subscribed to
-- that table (8,191 runs of its change query, 54 ms each). At peak,
-- placing an order went from 0.15 s on a quiet database to 2.1 s, and
-- some hit the 8 s statement timeout.
--
-- NOW. A trigger on each of those tables sends a small "something
-- changed" message to a private topic with realtime.send(). Who may join a
-- topic is checked once, when a screen joins (the policy on
-- realtime.messages below), not per change. Every screen already re-reads
-- what it shows through its own RLS-checked query when told something
-- changed, and still polls as a safety net, so the message carries only
-- what the kitchen board uses directly (an order's id, number and status).
--
-- Topics (src/lib/supabase/realtime.ts, listenToTopic):
--   orders:restaurant:<id>        orders and payments; the restaurant's members
--   orders:order:<id>             one order; its diner and the restaurant's members
--   requests:restaurant:<id>      table requests; the restaurant's members
--   reservations:restaurant:<id>  bookings; owners, managers and front of house
-- Each mirrors the SELECT policy of the table it's about.
--
-- PGlite (the integration tests) has no Realtime: the sender does nothing
-- there, and the policy and publication changes are skipped.

-- ── Sending ──────────────────────────────────────────────────────────────

create function public.broadcast_change(p_topic text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return;
  end if;
  perform realtime.send(p_payload, 'change', p_topic, true);
exception when others then
  -- A live update must never stop the write that caused it: screens
  -- still poll.
  raise warning 'broadcast_change(%) failed: %', p_topic, sqlerrm;
end;
$$;

revoke execute on function public.broadcast_change(text, jsonb) from public, anon, authenticated;

create function public.broadcast_order_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.orders%rowtype;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  perform public.broadcast_change(
    'orders:restaurant:' || r.restaurant_id,
    jsonb_build_object(
      'table', 'orders', 'op', tg_op, 'id', r.id,
      'status', r.status, 'order_number', r.order_number
    )
  );
  if tg_op = 'UPDATE' then
    perform public.broadcast_change(
      'orders:order:' || r.id,
      jsonb_build_object('status', r.status)
    );
  end if;
  return null;
end;
$$;

create function public.broadcast_payment_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.order_payments%rowtype;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  perform public.broadcast_change(
    'orders:restaurant:' || r.restaurant_id,
    jsonb_build_object('table', 'order_payments', 'op', tg_op, 'id', r.id)
  );
  return null;
end;
$$;

create function public.broadcast_table_request_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.table_requests%rowtype;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  perform public.broadcast_change(
    'requests:restaurant:' || r.restaurant_id,
    jsonb_build_object('table', 'table_requests', 'op', tg_op, 'id', r.id)
  );
  return null;
end;
$$;

create function public.broadcast_reservation_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.reservations%rowtype;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  perform public.broadcast_change(
    'reservations:restaurant:' || r.restaurant_id,
    jsonb_build_object('table', 'reservations', 'op', tg_op, 'id', r.id)
  );
  return null;
end;
$$;

revoke execute on function public.broadcast_order_change() from public, anon, authenticated;
revoke execute on function public.broadcast_payment_change() from public, anon, authenticated;
revoke execute on function public.broadcast_table_request_change() from public, anon, authenticated;
revoke execute on function public.broadcast_reservation_change() from public, anon, authenticated;

create trigger trg_orders_broadcast
  after insert or update or delete on public.orders
  for each row execute function public.broadcast_order_change();
create trigger trg_order_payments_broadcast
  after insert or update or delete on public.order_payments
  for each row execute function public.broadcast_payment_change();
create trigger trg_table_requests_broadcast
  after insert or update or delete on public.table_requests
  for each row execute function public.broadcast_table_request_change();
create trigger trg_reservations_broadcast
  after insert or update or delete on public.reservations
  for each row execute function public.broadcast_reservation_change();


-- ── Who may listen ───────────────────────────────────────────────────────

-- Whether the signed-in caller may join a topic. Mirrors each table's
-- SELECT policy: orders_select_own_or_staff, table_requests_select_members,
-- reservations_select_front_of_house. Membership goes through
-- is_restaurant_member / current_restaurant_role, so two-step verification
-- applies, as everywhere else.
create function public.can_receive_broadcast(p_topic text)
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
            exists (
              select 1 from public.customer_sessions cs
              where cs.id = o.customer_session_id and cs.user_id = auth.uid()
            )
            or public.is_restaurant_member(o.restaurant_id)
          )
      );
    else
      return false;
  end case;
end;
$$;

revoke execute on function public.can_receive_broadcast(text) from public, anon;
grant execute on function public.can_receive_broadcast(text) to authenticated;

do $$
begin
  if to_regclass('realtime.messages') is null then
    return; -- PGlite: no Realtime
  end if;
  execute $p$
    create policy "tableside_broadcast_listen"
      on realtime.messages
      for select
      to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and public.can_receive_broadcast((select realtime.topic()))
      )
  $p$;
end;
$$;


-- ── Stop the old feed ────────────────────────────────────────────────────

-- Off the postgres_changes publication, so Realtime no longer decodes
-- these tables' changes at all. A screen still running the old code
-- (a tablet not reloaded since the deploy) keeps working on its poll.
-- REPLICA IDENTITY FULL was only for Realtime's RLS checks
-- (20260824090300 and its siblings); back to the default, so an update
-- writes less to the WAL.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['orders', 'order_payments', 'table_requests', 'reservations'] loop
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end;
$$;

alter table public.orders replica identity default;
alter table public.order_payments replica identity default;
alter table public.table_requests replica identity default;
alter table public.reservations replica identity default;
