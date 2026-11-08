-- While-you-wait games: a menu quiz and a dish-photo match game on the
-- guest's order page, between ordering and the food arriving. Built from
-- the restaurant's own menu in the browser; nothing about a game is
-- stored. No prizes, no discounts, no names.
--
-- On by default (decided 2026-11-08): it costs nothing and needs nothing
-- from the owner. Owners and managers switch it off in Settings through
-- the existing restaurant_settings update policy.

alter table public.restaurant_settings
  add column show_wait_games boolean not null default true;

comment on column public.restaurant_settings.show_wait_games is
  'Whether guests see the while-you-wait games on their order page (20261202090000).';

-- restaurant_settings has no public SELECT policy, so a guest's page reads
-- this one flag through here, the same way get_public_order_settings()
-- exposes the order settings.
create function public.wait_games_enabled(p_restaurant_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return coalesce(
    (select show_wait_games from public.restaurant_settings
     where restaurant_id = p_restaurant_id),
    false
  );
end;
$$;

revoke execute on function public.wait_games_enabled(uuid) from public, anon;
grant execute on function public.wait_games_enabled(uuid) to authenticated, service_role;
