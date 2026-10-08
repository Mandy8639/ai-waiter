-- Diner feedback (phase N): a rating for the visit and a thumbs up or down
-- for each dish, PRIVATE TO THE RESTAURANT.
--
-- WHY PRIVATE. Public reviews need moderation, and moderation is the real
-- cost. They also invite the dishonest version: an owner choosing which
-- reviews diners see. Private feedback needs neither. Its value is
-- catching a problem while the diner is still at the table, before it
-- becomes a one-star post elsewhere. Owners and managers read it; staff,
-- other diners and the AI waiter don't.
--
-- WHO CAN LEAVE IT. Only the diner who placed the order, identified the
-- same way the orders RLS does (the order's customer session belongs to
-- auth.uid()). Nothing is taken from the client but the order id, the
-- numbers and the comment. Rules, all here:
--   - the order has been SERVED (the food reached the table);
--   - within 2 days of the order;
--   - ONE per order, never edited — feedback that changes after the owner
--     has read it is a conversation, and this is not a chat;
--   - dish votes only for dishes ON THAT ORDER.
--
-- A LOW RATING IS A CHANCE TO FIX IT. The diner's page then offers "Would
-- you like someone to come over?". Saying yes raises an ordinary waiter
-- call through create_table_request(), so staff get it the way they get
-- every other call. It's the diner's choice; a bad rating never summons
-- anyone on its own.

create table public.order_feedback (
  order_id uuid primary key,
  restaurant_id uuid not null,
  table_id uuid not null,
  rating smallint not null,
  comment text,
  created_at timestamptz not null default now(),

  constraint order_feedback_order_same_restaurant
    foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id) on delete cascade,
  constraint order_feedback_table_same_restaurant
    foreign key (restaurant_id, table_id)
    references public.tables (restaurant_id, id) on delete cascade,
  constraint order_feedback_rating_range check (rating between 1 and 5),
  constraint order_feedback_comment_length
    check (comment is null or char_length(comment) between 1 and 1000)
);

create index order_feedback_restaurant_created_idx
  on public.order_feedback (restaurant_id, created_at desc);

comment on table public.order_feedback is
  'Phase N: a diner''s rating of their visit, one per served order. Private to owners and managers. Written only by submit_order_feedback().';

create table public.order_item_feedback (
  order_item_id uuid primary key,
  order_id uuid not null,
  restaurant_id uuid not null,
  -- Which dish, for per-dish totals. Kept when the dish is later deleted
  -- (the vote is still a fact about what was served) as NULL.
  menu_item_id uuid references public.menu_items (id) on delete set null,
  liked boolean not null,
  created_at timestamptz not null default now(),

  constraint order_item_feedback_item_same_restaurant
    foreign key (restaurant_id, order_item_id)
    references public.order_items (restaurant_id, id) on delete cascade,
  constraint order_item_feedback_feedback
    foreign key (order_id)
    references public.order_feedback (order_id) on delete cascade
);

create index order_item_feedback_restaurant_idx
  on public.order_item_feedback (restaurant_id, created_at desc);

comment on table public.order_item_feedback is
  'Phase N: thumbs up/down per dish on an order, given with order_feedback. Private to owners and managers.';

alter table public.order_feedback enable row level security;
alter table public.order_item_feedback enable row level security;

-- Owners and managers only: comments can name staff, and that's for the
-- people who manage them. No write policies: submit_order_feedback() is
-- the only way in.
create policy "order_feedback_select_owner_manager"
  on public.order_feedback for select to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "order_item_feedback_select_owner_manager"
  on public.order_item_feedback for select to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));

-- Where this diner stands with this order's feedback. The diner's page
-- uses it to decide what to show, and it never returns the feedback text.
--   not_yours — not the caller's order (or no such order)
--   not_yet   — not served yet
--   open      — can give feedback now
--   given     — already given (with the rating, for the thank-you)
--   closed    — the 2-day window has passed
create function public.get_my_order_feedback_state(p_order_id uuid)
returns table (feedback_state text, feedback_rating smallint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_rating smallint;
begin
  select o.* into v_order
  from public.orders o
  join public.customer_sessions cs on cs.id = o.customer_session_id
  where o.id = p_order_id and cs.user_id = auth.uid();

  if v_order.id is null then
    return query select 'not_yours'::text, null::smallint;
    return;
  end if;

  select f.rating into v_rating
  from public.order_feedback f where f.order_id = v_order.id;
  if v_rating is not null then
    return query select 'given'::text, v_rating;
    return;
  end if;

  if v_order.status <> 'served' then
    return query select 'not_yet'::text, null::smallint;
  elsif v_order.created_at < now() - interval '2 days' then
    return query select 'closed'::text, null::smallint;
  else
    return query select 'open'::text, null::smallint;
  end if;
end;
$$;

revoke execute on function public.get_my_order_feedback_state(uuid) from public, anon;
grant execute on function public.get_my_order_feedback_state(uuid) to authenticated;

-- The one way to leave feedback. p_dish_votes is a JSON object of
-- order_item_id -> true (thumbs up) / false (thumbs down); dishes left
-- out simply have no vote.
create function public.submit_order_feedback(
  p_order_id uuid,
  p_rating integer,
  p_comment text,
  p_dish_votes jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_vote record;
  v_item public.order_items;
begin
  -- The caller's own order, by auth.uid(), locked so two taps can't race.
  select o.* into v_order
  from public.orders o
  join public.customer_sessions cs on cs.id = o.customer_session_id
  where o.id = p_order_id and cs.user_id = auth.uid()
  for update of o;

  if v_order.id is null then
    raise exception 'FEEDBACK_NOT_YOUR_ORDER' using errcode = '42501';
  end if;
  if v_order.status <> 'served' then
    raise exception 'FEEDBACK_NOT_SERVED: feedback opens once the order has been served'
      using errcode = '23514';
  end if;
  if v_order.created_at < now() - interval '2 days' then
    raise exception 'FEEDBACK_CLOSED: feedback closes 2 days after the order'
      using errcode = '23514';
  end if;
  if exists (select 1 from public.order_feedback f where f.order_id = v_order.id) then
    raise exception 'FEEDBACK_ALREADY_GIVEN' using errcode = '23505';
  end if;
  if p_dish_votes is not null and jsonb_typeof(p_dish_votes) <> 'object' then
    raise exception 'FEEDBACK_INVALID_VOTES' using errcode = '22023';
  end if;

  insert into public.order_feedback (order_id, restaurant_id, table_id, rating, comment)
  values (v_order.id, v_order.restaurant_id, v_order.table_id, p_rating, v_comment);

  for v_vote in select key, value from jsonb_each(coalesce(p_dish_votes, '{}'::jsonb))
  loop
    if jsonb_typeof(v_vote.value) <> 'boolean' then
      raise exception 'FEEDBACK_INVALID_VOTES' using errcode = '22023';
    end if;
    select oi.* into v_item
    from public.order_items oi
    where oi.order_id = v_order.id
      and oi.id::text = v_vote.key;
    if v_item.id is null then
      raise exception 'FEEDBACK_INVALID_VOTES: a vote for a dish that isn''t on this order'
        using errcode = '22023';
    end if;
    insert into public.order_item_feedback (order_item_id, order_id, restaurant_id, menu_item_id, liked)
    values (v_item.id, v_order.id, v_order.restaurant_id, v_item.menu_item_id, v_vote.value::boolean);
  end loop;
end;
$$;

revoke execute on function public.submit_order_feedback(uuid, integer, text, jsonb) from public, anon;
grant execute on function public.submit_order_feedback(uuid, integer, text, jsonb) to authenticated;
