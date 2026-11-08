-- The Google review prompt: an owner sets their Google review link, and
-- diners are offered it after their meal.
--
-- EVERY DINER, ANY RATING. Google's review policy forbids "review gating":
-- asking only happy customers to post publicly. So the app offers the same
-- link to everyone, whatever they rated privately (order_feedback stays
-- private and separate), and never ties it to an incentive. Nothing here
-- reads a rating.
--
-- THE TAP COUNT. google_review_taps records that someone opened the link
-- from an order page: the order and the moment, nothing about the person
-- and nothing about their rating. One row per order, so tapping twice
-- doesn't inflate it. Owners and managers see a count; nobody sees rows.

alter table public.restaurants
  add column google_review_url text,
  -- Google's own hosts only, https only. The app checks the same list
  -- (src/lib/reviews/core.ts); this is the boundary.
  add constraint restaurants_google_review_url_valid check (
    google_review_url is null
    or (
      length(google_review_url) <= 500
      and google_review_url ~ '^https://(g\.page/|search\.google\.com/|www\.google\.com/|google\.com/|maps\.google\.com/|maps\.app\.goo\.gl/|goo\.gl/maps/)'
    )
  );

comment on column public.restaurants.google_review_url is
  'Where diners are sent to leave a Google review (20261130090000). Offered to every diner after their meal, whatever their private rating.';

create table public.google_review_taps (
  order_id uuid primary key references public.orders (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index google_review_taps_restaurant_created_idx
  on public.google_review_taps (restaurant_id, created_at desc);

comment on table public.google_review_taps is
  'That a diner opened the Google review link from an order. No person, no rating. Written by record_google_review_tap(); read only as a count.';

alter table public.google_review_taps enable row level security;

-- A diner who can see the order (its sender, or their table group) opened
-- the link. Quietly does nothing if they can't, or if the restaurant has
-- no link: a tap is never worth an error on a diner's screen.
create function public.record_google_review_tap(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
begin
  if not public.order_belongs_to_caller(p_order_id) then
    return;
  end if;

  select o.restaurant_id into v_restaurant_id
  from public.orders o
  join public.restaurants r on r.id = o.restaurant_id
  where o.id = p_order_id
    and r.google_review_url is not null;
  if v_restaurant_id is null then
    return;
  end if;

  insert into public.google_review_taps (order_id, restaurant_id)
  values (p_order_id, v_restaurant_id)
  on conflict (order_id) do nothing;
end;
$$;

revoke execute on function public.record_google_review_tap(uuid) from public, anon;
grant execute on function public.record_google_review_tap(uuid) to authenticated, service_role;

-- How many orders' diners opened the link in the last p_days days.
create function public.google_review_tap_count(p_restaurant_id uuid, p_days integer)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not coalesce(
    public.current_restaurant_role(p_restaurant_id) in ('owner', 'manager'),
    false
  ) then
    return null;
  end if;

  return (
    select count(*)::integer
    from public.google_review_taps
    where restaurant_id = p_restaurant_id
      and created_at > now() - make_interval(days => greatest(1, least(p_days, 366)))
  );
end;
$$;

revoke execute on function public.google_review_tap_count(uuid, integer) from public, anon;
grant execute on function public.google_review_tap_count(uuid, integer) to authenticated, service_role;
