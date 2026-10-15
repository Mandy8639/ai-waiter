-- Busy mode: the kitchen can pause new orders for a while, or tell diners
-- it's running behind.
--
-- A slammed kitchen had two bad options: keep accepting orders it can't
-- cook in time, or ask the owner to switch "Accepting orders" off in
-- Settings — and remember to switch it back on. That switch is the
-- owner's (opening hours, closing the restaurant), so the kitchen gets its
-- own, separate controls rather than borrowing it:
--
--   PAUSE  orders_paused_until. New orders are refused until then; it
--          lifts by itself when the time passes, so a forgotten pause
--          doesn't close the restaurant for the night. 'infinity' means
--          "until someone resumes".
--   BUSY   busy_extra_minutes until busy_until. Orders still flow; diners
--          are told food is taking about that much longer, and their
--          order's time estimate includes it.
--
-- The pause is enforced by a trigger on orders, not by a check inside
-- submit_order(): submit_order() is the only thing that inserts orders,
-- and a BEFORE INSERT guard holds no matter how that function changes
-- later. Its idempotent replay (the same order submitted twice) returns
-- the existing order before inserting, so a diner whose order went
-- through just before the pause still gets their confirmation.

alter table public.restaurant_settings
  add column orders_paused_until timestamptz,
  add column busy_extra_minutes integer not null default 0,
  add column busy_until timestamptz,
  add constraint restaurant_settings_busy_extra_range
    check (busy_extra_minutes between 0 and 120);

comment on column public.restaurant_settings.orders_paused_until is
  'Kitchen busy mode: new orders are refused until this time (infinity = until resumed). Separate from accepting_orders, which is the owner''s switch.';
comment on column public.restaurant_settings.busy_extra_minutes is
  'Kitchen busy mode: how many minutes longer food is taking, told to diners until busy_until.';


create function public.refuse_order_while_paused()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.restaurant_settings s
    where s.restaurant_id = new.restaurant_id
      and s.orders_paused_until > now()
  ) then
    raise exception 'ORDER_PAUSED: the kitchen has paused new orders'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.refuse_order_while_paused() from public, anon, authenticated;

create trigger trg_orders_refuse_while_paused
  before insert on public.orders
  for each row
  execute function public.refuse_order_while_paused();


-- Shared by the three controls below: SECURITY DEFINER bypasses RLS, so
-- this role check IS the access control. Front-of-house staff are not
-- included, the same line as the sold-out switches: it is the kitchen's
-- call (and the managers').
create function public.assert_can_run_kitchen(p_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
begin
  v_role := public.current_restaurant_role(p_restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager', 'kitchen') then
    raise exception 'BUSY_FORBIDDEN: only the kitchen or a manager can change this'
      using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.assert_can_run_kitchen(uuid) from public, anon, authenticated;


-- Pause new orders for p_minutes (5–720), or until resumed when null.
-- Returns when the pause ends.
create function public.pause_new_orders(
  p_restaurant_id uuid,
  p_minutes integer default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_until timestamptz;
begin
  perform public.assert_can_run_kitchen(p_restaurant_id);

  if p_minutes is not null and (p_minutes < 5 or p_minutes > 720) then
    raise exception 'BUSY_INVALID: pause between 5 minutes and 12 hours'
      using errcode = '22023';
  end if;

  v_until := case
    when p_minutes is null then 'infinity'::timestamptz
    else now() + make_interval(mins => p_minutes)
  end;

  update public.restaurant_settings
  set orders_paused_until = v_until
  where restaurant_id = p_restaurant_id;

  return v_until;
end;
$$;

revoke execute on function public.pause_new_orders(uuid, integer) from public, anon;
grant execute on function public.pause_new_orders(uuid, integer) to authenticated;


create function public.resume_new_orders(p_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_can_run_kitchen(p_restaurant_id);

  update public.restaurant_settings
  set orders_paused_until = null
  where restaurant_id = p_restaurant_id;
end;
$$;

revoke execute on function public.resume_new_orders(uuid) from public, anon;
grant execute on function public.resume_new_orders(uuid) to authenticated;


-- Tell diners food is taking p_extra_minutes (5–120) longer, for the next
-- p_for_minutes (15–720). p_extra_minutes = 0 clears it.
create function public.set_kitchen_busy(
  p_restaurant_id uuid,
  p_extra_minutes integer,
  p_for_minutes integer default 60
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_can_run_kitchen(p_restaurant_id);

  if p_extra_minutes is null or p_extra_minutes = 0 then
    update public.restaurant_settings
    set busy_extra_minutes = 0, busy_until = null
    where restaurant_id = p_restaurant_id;
    return;
  end if;

  if p_extra_minutes < 5 or p_extra_minutes > 120 then
    raise exception 'BUSY_INVALID: extra wait between 5 and 120 minutes'
      using errcode = '22023';
  end if;
  if p_for_minutes is null or p_for_minutes < 15 or p_for_minutes > 720 then
    raise exception 'BUSY_INVALID: keep it on between 15 minutes and 12 hours'
      using errcode = '22023';
  end if;

  update public.restaurant_settings
  set busy_extra_minutes = p_extra_minutes,
      busy_until = now() + make_interval(mins => p_for_minutes)
  where restaurant_id = p_restaurant_id;
end;
$$;

revoke execute on function public.set_kitchen_busy(uuid, integer, integer) from public, anon;
grant execute on function public.set_kitchen_busy(uuid, integer, integer) to authenticated;


-- What a diner (signed out, or on a QR session) may know: whether new
-- orders are paused and until when, and how much longer food is taking.
-- Expired values come back as "not paused" / 0, so nobody has to clean up
-- after a pause runs out. Two facts about the kitchen, nothing else — the
-- same narrow pattern as get_public_order_settings().
create function public.get_kitchen_status(target_restaurant_id uuid)
returns table (orders_paused_until timestamptz, busy_extra_minutes integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select
    case when s.orders_paused_until > now() then s.orders_paused_until end,
    case when s.busy_until > now() then s.busy_extra_minutes else 0 end
  from public.restaurant_settings s
  where s.restaurant_id = target_restaurant_id;
end;
$$;

comment on function public.get_kitchen_status(uuid) is
  'Kitchen busy mode as diners may see it: whether new orders are paused (and until when) and how many minutes longer food is taking. Expired values read as off.';

revoke execute on function public.get_kitchen_status(uuid) from public;
grant execute on function public.get_kitchen_status(uuid) to anon, authenticated;
