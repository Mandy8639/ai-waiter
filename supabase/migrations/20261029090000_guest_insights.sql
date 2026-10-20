-- Guest insights (docs/guest-insights.md): who comes, when, how they use
-- the AI waiter and what they think, for one restaurant over a period.
--
-- Read-only, owner/manager only (assert_can_view_reports, the same gate
-- as takings), counts and averages only. A diner at a table is an
-- anonymous sign-in that lasts one visit, so table visits can't be
-- linked to each other; returning guests and regulars come from
-- reservations, where the guest gave a phone number. Phones are compared
-- by their last nine digits, so "+44 7700 900001" and "07700 900001" are
-- the same guest, and are never returned: the page shows a guest's name, how
-- often they came and when they last did.
--
-- One call returns one jsonb document, so the page makes one round trip
-- and a quiet period is all zeros, never a missing row.

create function public.get_guest_insights(
  target_restaurant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
  v_visits jsonb;
  v_ai jsonb;
  v_busy jsonb;
  v_feedback jsonb;
  v_bookings jsonb;
  v_regulars jsonb;
begin
  perform public.assert_can_view_reports(target_restaurant_id);

  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'REPORT_INVALID_RANGE: the period must end after it starts'
      using errcode = '22023';
  end if;

  select coalesce(r.timezone, 'UTC') into v_tz
  from public.restaurants r
  where r.id = target_restaurant_id;

  -- Visits: every phone that sat at a table (or ordered for pickup) in
  -- the period. Spend is what its orders came to, cancelled ones aside.
  with s as (
    select
      cs.id,
      coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0) as spend,
      count(o.id) filter (where o.status <> 'cancelled') as orders,
      exists (
        select 1 from public.ai_conversation_messages m
        where m.customer_session_id = cs.id and m.role = 'user'
      ) as chatted
    from public.customer_sessions cs
    left join public.orders o on o.customer_session_id = cs.id
    where cs.restaurant_id = target_restaurant_id
      and cs.started_at >= p_from
      and cs.started_at < p_to
    group by cs.id
  )
  select
    jsonb_build_object(
      'visits', count(*),
      'orderingVisits', count(*) filter (where orders > 0),
      'spend', coalesce(sum(spend), 0),
      'orders', coalesce(sum(orders), 0)
    ),
    jsonb_build_object(
      'chatVisits', count(*) filter (where chatted),
      'chatOrderingVisits', count(*) filter (where chatted and orders > 0),
      'chatSpend', coalesce(sum(spend) filter (where chatted), 0),
      'otherOrderingVisits', count(*) filter (where not chatted and orders > 0),
      'otherSpend', coalesce(sum(spend) filter (where not chatted), 0)
    )
  into v_visits, v_ai
  from s;

  v_ai := v_ai || jsonb_build_object(
    'questions', (
      select count(*)
      from public.ai_conversation_messages m
      where m.restaurant_id = target_restaurant_id
        and m.role = 'user'
        and m.created_at >= p_from
        and m.created_at < p_to
    )
  );

  -- Busy times: orders by the restaurant's own weekday (1 = Monday) and
  -- hour.
  select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'hour', hr, 'orders', n)
                            order by dow, hr), '[]'::jsonb)
  into v_busy
  from (
    select
      extract(isodow from o.created_at at time zone v_tz)::int as dow,
      extract(hour from o.created_at at time zone v_tz)::int as hr,
      count(*) as n
    from public.orders o
    where o.restaurant_id = target_restaurant_id
      and o.status <> 'cancelled'
      and o.created_at >= p_from
      and o.created_at < p_to
    group by 1, 2
  ) b;

  select jsonb_build_object(
    'count', count(*),
    'average', avg(f.rating),
    'byRating', jsonb_build_array(
      count(*) filter (where f.rating = 1),
      count(*) filter (where f.rating = 2),
      count(*) filter (where f.rating = 3),
      count(*) filter (where f.rating = 4),
      count(*) filter (where f.rating = 5)
    )
  )
  into v_feedback
  from public.order_feedback f
  where f.restaurant_id = target_restaurant_id
    and f.created_at >= p_from
    and f.created_at < p_to;

  -- Bookings in the period, and how many of their guests had booked
  -- before (a kept booking before this period, same phone).
  with b as (
    select
      r.*,
      right(regexp_replace(r.customer_phone, '\D', '', 'g'), 9) as phone_key
    from public.reservations r
    where r.restaurant_id = target_restaurant_id
      and r.reservation_time >= p_from
      and r.reservation_time < p_to
  ),
  kept as (
    select * from b where status not in ('pending', 'cancelled', 'no_show')
  ),
  guests as (
    select distinct phone_key from kept where phone_key <> ''
  )
  select jsonb_build_object(
    'bookings', (select count(*) from b where status <> 'pending'),
    'kept', (select count(*) from kept),
    'covers', (select coalesce(sum(party_size), 0) from kept),
    'noShows', (select count(*) from b where status = 'no_show'),
    'cancelled', (select count(*) from b where status = 'cancelled'),
    'guests', (select count(*) from guests),
    'returningGuests', (
      select count(*) from guests g
      where exists (
        select 1 from public.reservations p
        where p.restaurant_id = target_restaurant_id
          and p.reservation_time < p_from
          and p.status not in ('pending', 'cancelled', 'no_show')
          and right(regexp_replace(p.customer_phone, '\D', '', 'g'), 9) = g.phone_key
      )
    )
  )
  into v_bookings;

  -- Regulars: guests with two or more kept bookings up to the end of the
  -- period, who booked within it. Name from their latest booking.
  select coalesce(jsonb_agg(x order by (x->>'visits')::int desc, x->>'lastVisit' desc), '[]'::jsonb)
  into v_regulars
  from (
    select jsonb_build_object(
      'name', (array_agg(r.customer_name order by r.reservation_time desc))[1],
      'visits', count(*),
      'lastVisit', max(r.reservation_time)
    ) as x
    from public.reservations r
    where r.restaurant_id = target_restaurant_id
      and r.reservation_time < p_to
      and r.status not in ('pending', 'cancelled', 'no_show')
      and right(regexp_replace(r.customer_phone, '\D', '', 'g'), 9) <> ''
    group by right(regexp_replace(r.customer_phone, '\D', '', 'g'), 9)
    having count(*) >= 2
      and max(r.reservation_time) >= p_from
    order by count(*) desc, max(r.reservation_time) desc
    limit 10
  ) top;

  return jsonb_build_object(
    'visits', v_visits,
    'ai', v_ai,
    'busy', v_busy,
    'feedback', v_feedback,
    'bookings', v_bookings,
    'regulars', v_regulars
  );
end;
$$;

comment on function public.get_guest_insights(uuid, timestamptz, timestamptz) is
  'Guest insights for one restaurant over [p_from, p_to): visits and spend, AI waiter use, busy hours, ratings, bookings and regulars (by the last nine digits of their phone, never returned). Counts only. Owner/manager only.';

revoke execute on function public.get_guest_insights(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_guest_insights(uuid, timestamptz, timestamptz) to authenticated;
