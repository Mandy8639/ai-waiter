-- Guest Wi-Fi: a small "join Wi-Fi" code on each printed table card, and
-- the network name and password for seated guests in the app.
--
-- WHY A TABLE OF ITS OWN. restaurants is readable by anyone with the
-- menu's link (it's the public restaurant page). A Wi-Fi password there
-- would be on the open web. Here it has no SELECT policy at all: it is
-- read only through restaurant_wifi_for_staff() (members) and
-- restaurant_wifi_for_guest() (a guest with an active table session at
-- this restaurant), and written only through set_restaurant_wifi()
-- (owners and managers). Paper is the other place it appears: the table
-- cards the restaurant prints.

create table public.restaurant_wifi (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  ssid text not null,
  -- null for an open network.
  password text,
  security text not null default 'WPA',
  hidden boolean not null default false,
  updated_at timestamptz not null default now(),

  constraint restaurant_wifi_ssid_length check (length(ssid) between 1 and 32),
  constraint restaurant_wifi_password_length
    check (password is null or length(password) between 1 and 63),
  constraint restaurant_wifi_security_valid check (security in ('WPA', 'WEP', 'nopass')),
  constraint restaurant_wifi_password_matches_security
    check ((security = 'nopass') = (password is null))
);

comment on table public.restaurant_wifi is
  'A restaurant''s guest Wi-Fi (20261201090000). No SELECT policy: read through restaurant_wifi_for_staff() / restaurant_wifi_for_guest() only, never with the public restaurant row.';

alter table public.restaurant_wifi enable row level security;

create function public.restaurant_wifi_for_staff(p_restaurant_id uuid)
returns table (ssid text, password text, security text, hidden boolean)
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
    select w.ssid, w.password, w.security, w.hidden
    from public.restaurant_wifi w
    where w.restaurant_id = p_restaurant_id;
end;
$$;

revoke execute on function public.restaurant_wifi_for_staff(uuid) from public, anon;
grant execute on function public.restaurant_wifi_for_staff(uuid) to authenticated, service_role;

-- The caller's own table session decides the restaurant; nothing is taken
-- from the client.
create function public.restaurant_wifi_for_guest()
returns table (ssid text, password text, security text, hidden boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    select w.ssid, w.password, w.security, w.hidden
    from public.customer_sessions cs
    join public.restaurant_wifi w on w.restaurant_id = cs.restaurant_id
    where cs.user_id = auth.uid()
      and cs.status = 'active'
      and cs.expires_at > now()
    limit 1;
end;
$$;

revoke execute on function public.restaurant_wifi_for_guest() from public, anon;
grant execute on function public.restaurant_wifi_for_guest() to authenticated, service_role;

-- Owners and managers set it; a blank name clears it.
create function public.set_restaurant_wifi(
  p_restaurant_id uuid,
  p_ssid text,
  p_password text,
  p_security text,
  p_hidden boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not coalesce(
    public.current_restaurant_role(p_restaurant_id) in ('owner', 'manager'),
    false
  ) then
    raise exception 'WIFI_FORBIDDEN';
  end if;

  if p_ssid is null or btrim(p_ssid) = '' then
    delete from public.restaurant_wifi where restaurant_id = p_restaurant_id;
    return;
  end if;

  insert into public.restaurant_wifi (restaurant_id, ssid, password, security, hidden, updated_at)
  values (
    p_restaurant_id,
    p_ssid,
    case when p_security = 'nopass' then null else p_password end,
    p_security,
    coalesce(p_hidden, false),
    now()
  )
  on conflict (restaurant_id) do update
  set ssid = excluded.ssid,
      password = excluded.password,
      security = excluded.security,
      hidden = excluded.hidden,
      updated_at = now();
end;
$$;

revoke execute on function public.set_restaurant_wifi(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.set_restaurant_wifi(uuid, text, text, text, boolean) to authenticated, service_role;
