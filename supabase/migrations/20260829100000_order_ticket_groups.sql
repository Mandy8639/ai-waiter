-- Kitchen order splitting/merging (product decision: kitchen-workflow
-- organization only — order pricing, totals, order numbers, and the
-- customer-facing bill are never touched by anything in this migration;
-- see docs/security.md#order-splitting-and-merging).
--
-- SPLIT: one order's items get partitioned into two or more
-- order_ticket_groups (e.g. "Appetizers" fires now, "Mains" fires later),
-- each progressing through the SAME pending -> confirmed -> preparing ->
-- ready -> served vocabulary and role matrix as orders themselves
-- (role_can_transition_order, unchanged) — appetizers can be "ready"
-- while mains are still "preparing". The order's own status (what the
-- customer's order-status page shows, unchanged) is derived as the LEAST
-- advanced group covering it, via recompute_order_status_from_groups() —
-- never "served" to the customer until every group actually is.
--
-- MERGE: two or more orders' items point at one shared ticket group
-- instead of each having their own — used when tables are physically
-- combined and the kitchen wants one ticket. Each order keeps its own
-- row, own total, own order number; only the shared group's status
-- exists, and it drives both orders' derived status identically (they's
-- always in lockstep, by construction — they're covered by the exact
-- same group). v1 limitation, explicit product decision: only orders
-- currently in the SAME status can be merged (ambiguous otherwise — is a
-- 'confirmed' order regressed to a merged 'pending' state, or does a
-- 'pending' one jump ahead? Neither has a clean answer), and only orders
-- that haven't already been split (avoids reasoning about partial
-- overlaps between two orders' own groups).
--
-- No per-group cancellation in v1 — cancelling remains a whole-order
-- action via the existing transition_order_status(), unchanged.
create table public.order_ticket_groups (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  label text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint order_ticket_groups_status_valid check (
    status in ('pending', 'confirmed', 'preparing', 'ready', 'served')
  ),
  constraint order_ticket_groups_label_length check (
    label is null or length(label) <= 100
  ),
  -- Composite unique target for order_items' tenant-scoped FK below.
  constraint order_ticket_groups_restaurant_id_id_key unique (restaurant_id, id)
);

comment on table public.order_ticket_groups is
  'Kitchen-side ticket grouping for split/merged orders — never touches order pricing/totals/order numbers. See docs/security.md#order-splitting-and-merging.';

create trigger trg_order_ticket_groups_set_updated_at
  before update on public.order_ticket_groups
  for each row
  execute function public.set_updated_at();

alter table public.order_ticket_groups enable row level security;

create policy "order_ticket_groups_select_staff"
  on public.order_ticket_groups
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

-- No INSERT/UPDATE/DELETE policy for any role: only the SECURITY DEFINER
-- functions below ever write here, matching order_status_history's own
-- append-only-via-function-only philosophy.

alter table public.order_items
  add column ticket_group_id uuid;

alter table public.order_items
  add constraint order_items_ticket_group_same_restaurant
  foreign key (restaurant_id, ticket_group_id)
  references public.order_ticket_groups (restaurant_id, id)
  on delete set null;

comment on column public.order_items.ticket_group_id is
  'Which kitchen ticket this item belongs to, if the order has been split/merged. NULL means the order has not been split — its own status is the only status that exists, unchanged from Batch 6.';

-- Ordinal rank for the forward-only progression, used to find "the least
-- advanced group" without string comparison. Deliberately excludes
-- 'cancelled' — ticket groups never take that status (v1: cancellation
-- stays a whole-order action) — see the header comment above.
create function public.order_status_rank(p_status text)
returns integer
language sql
immutable
as $$
  select case p_status
    when 'pending' then 0
    when 'confirmed' then 1
    when 'preparing' then 2
    when 'ready' then 3
    when 'served' then 4
    else null
  end
$$;

comment on function public.order_status_rank(text) is
  'Ordinal position in the forward-only order/ticket-group status progression (pending=0..served=4). NULL for cancelled or unknown values — callers must handle that explicitly, never coalesce it into a rank.';

-- Recomputes and applies one order's status from the ticket groups
-- covering its items, if it has any — a no-op for an order that hasn't
-- been split/merged (no groups exist, nothing to recompute). Goes through
-- transition_order_status() itself (not a raw UPDATE) so the existing
-- role/audit-trail machinery is reused rather than duplicated — the actor
-- recorded is whoever actually triggered the underlying group transition.
--
-- SECURITY DEFINER only to read across orders/order_items/order_ticket_groups
-- uniformly regardless of the caller's own role; the actual status change
-- still goes through transition_order_status(), which re-derives and
-- re-checks the caller's role independently — this function grants no
-- new write privilege of its own.
create function public.recompute_order_status_from_groups(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_status text;
  v_least_advanced_status text;
begin
  select status into v_current_status from public.orders where id = p_order_id;
  if v_current_status is null or v_current_status in ('served', 'cancelled') then
    return;
  end if;

  select otg.status into v_least_advanced_status
  from public.order_ticket_groups otg
  where otg.id in (
    select distinct ticket_group_id
    from public.order_items
    where order_id = p_order_id and ticket_group_id is not null
  )
  order by public.order_status_rank(otg.status) asc
  limit 1;

  -- No groups cover this order (never split, or all items ungrouped) —
  -- nothing to derive; the order's own status stands as-is.
  if v_least_advanced_status is null then
    return;
  end if;

  if v_least_advanced_status <> v_current_status then
    perform public.transition_order_status(p_order_id, v_least_advanced_status);
  end if;
end;
$$;

comment on function public.recompute_order_status_from_groups(uuid) is
  'Re-derives one order''s status as the least-advanced ticket group covering its items, and applies it via transition_order_status() if it changed. No-op for an order with no groups. See docs/security.md#order-splitting-and-merging.';

-- The only path that changes a ticket group's status — mirrors
-- transition_order_status()'s exact structure (role/transition validation,
-- row lock, audit trail via the SAME order_status_history table windows
-- as regular order transitions) rather than inventing a parallel pattern.
-- Reuses is_valid_order_status_transition()/role_can_transition_order()
-- directly: a ticket group's progression and role matrix are identical to
-- an order's own (minus 'cancelled', which groups never reach — see the
-- CHECK constraint above), so there is no separate rule table to keep in
-- sync.
create function public.transition_ticket_group_status(
  p_ticket_group_id uuid,
  p_target_status text
)
returns public.order_ticket_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_group public.order_ticket_groups%rowtype;
  v_role text;
  v_order_id uuid;
begin
  if v_user_id is null then
    raise exception 'TICKET_GROUP_UNAUTHENTICATED: sign-in required' using errcode = '28000';
  end if;

  if p_target_status is null
    or p_target_status not in ('pending', 'confirmed', 'preparing', 'ready', 'served')
  then
    raise exception 'TICKET_GROUP_INVALID_STATUS: unknown target status';
  end if;

  select * into v_group
  from public.order_ticket_groups
  where id = p_ticket_group_id
  for update;

  if not found then
    raise exception 'TICKET_GROUP_NOT_FOUND: ticket group not found';
  end if;

  v_role := public.current_restaurant_role(v_group.restaurant_id);
  if v_role is null then
    raise exception 'TICKET_GROUP_FORBIDDEN: not a member of this restaurant' using errcode = '42501';
  end if;

  if not public.is_valid_order_status_transition(v_group.status, p_target_status) then
    raise exception 'TICKET_GROUP_INVALID_TRANSITION: cannot move a ticket from % to %',
      v_group.status, p_target_status
      using errcode = '23514';
  end if;

  if not public.role_can_transition_order(v_role, v_group.status, p_target_status) then
    raise exception 'TICKET_GROUP_FORBIDDEN: % cannot move a ticket from % to %',
      v_role, v_group.status, p_target_status
      using errcode = '42501';
  end if;

  update public.order_ticket_groups
  set status = p_target_status
  where id = p_ticket_group_id
  returning * into v_group;

  -- Every order this group touches gets re-derived — plural because a
  -- merged group can cover more than one order, and both must move
  -- together, in lockstep, by construction.
  for v_order_id in
    select distinct order_id from public.order_items where ticket_group_id = p_ticket_group_id
  loop
    perform public.recompute_order_status_from_groups(v_order_id);
  end loop;

  return v_group;
end;
$$;

comment on function public.transition_ticket_group_status(uuid, text) is
  'The only path that changes a ticket group''s status. Mirrors transition_order_status() exactly (role/transition checks, row lock); additionally re-derives every order the group touches (recompute_order_status_from_groups()) so a merged group''s progress propagates to all orders sharing it. See docs/security.md#order-splitting-and-merging.';

revoke execute on function public.transition_ticket_group_status(uuid, text) from public;
grant execute on function public.transition_ticket_group_status(uuid, text) to authenticated;

-- Splits one order's items into two or more labeled ticket groups. Every
-- item on the order must end up in exactly one group — no item left
-- ungrouped, none assigned twice, none from a different order. Re-running
-- this on an already-split order re-splits it from scratch (clears the
-- old grouping first) rather than layering groups on groups.
create function public.split_order_into_tickets(
  p_order_id uuid,
  p_groups jsonb
)
returns setof public.order_ticket_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_order public.orders%rowtype;
  v_role text;
  v_group jsonb;
  v_group_id uuid;
  v_item_id text;
  v_total_items integer;
  v_covered_items integer := 0;
  v_updated integer;
  v_previous_group_ids uuid[];
begin
  if v_user_id is null then
    raise exception 'TICKET_SPLIT_UNAUTHENTICATED: sign-in required' using errcode = '28000';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'TICKET_SPLIT_ORDER_NOT_FOUND: order not found';
  end if;

  v_role := public.current_restaurant_role(v_order.restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager', 'kitchen') then
    raise exception 'TICKET_SPLIT_FORBIDDEN: insufficient role' using errcode = '42501';
  end if;

  if v_order.status in ('served', 'cancelled') then
    raise exception 'TICKET_SPLIT_ORDER_FINALIZED: order is already served or cancelled'
      using errcode = '23514';
  end if;

  if jsonb_typeof(p_groups) <> 'array' or jsonb_array_length(p_groups) < 2 then
    raise exception 'TICKET_SPLIT_NEEDS_TWO_GROUPS: split requires at least two groups'
      using errcode = '22023';
  end if;

  select count(*) into v_total_items from public.order_items where order_id = p_order_id;

  -- Re-splitting: clear this order's previous grouping before applying
  -- the new one, rather than layering on top. Only deletes a previous
  -- group if it ends up with zero remaining items after the clear — a
  -- group shared with another order via merge_orders_into_ticket() still
  -- has that other order's items pointing at it and is correctly left
  -- alone.
  select array_agg(distinct ticket_group_id) into v_previous_group_ids
  from public.order_items
  where order_id = p_order_id and ticket_group_id is not null;

  update public.order_items set ticket_group_id = null where order_id = p_order_id;

  if v_previous_group_ids is not null then
    delete from public.order_ticket_groups
    where id = any(v_previous_group_ids)
      and not exists (
        select 1 from public.order_items where ticket_group_id = order_ticket_groups.id
      );
  end if;

  for v_group in select * from jsonb_array_elements(p_groups)
  loop
    insert into public.order_ticket_groups (restaurant_id, label, status)
    values (v_order.restaurant_id, v_group->>'label', v_order.status)
    returning id into v_group_id;

    for v_item_id in select * from jsonb_array_elements_text(v_group->'item_ids')
    loop
      update public.order_items
      set ticket_group_id = v_group_id
      where id = v_item_id::uuid and order_id = p_order_id;

      get diagnostics v_updated = row_count;
      if v_updated = 0 then
        raise exception 'TICKET_SPLIT_ITEM_NOT_IN_ORDER: item % is not part of this order', v_item_id
          using errcode = '22023';
      end if;
      v_covered_items := v_covered_items + 1;
    end loop;
  end loop;

  if v_covered_items <> v_total_items then
    raise exception 'TICKET_SPLIT_INCOMPLETE_COVERAGE: groups cover % of % items',
      v_covered_items, v_total_items
      using errcode = '22023';
  end if;

  return query
    select otg.* from public.order_ticket_groups otg
    where otg.id in (
      select distinct ticket_group_id from public.order_items
      where order_id = p_order_id and ticket_group_id is not null
    )
    order by otg.created_at asc;
end;
$$;

comment on function public.split_order_into_tickets(uuid, jsonb) is
  'Partitions one order''s items into 2+ labeled kitchen ticket groups. p_groups shape: [{"label": "Appetizers", "item_ids": ["..."]}, ...] — every item must be covered exactly once. See docs/security.md#order-splitting-and-merging.';

revoke execute on function public.split_order_into_tickets(uuid, jsonb) from public;
grant execute on function public.split_order_into_tickets(uuid, jsonb) to authenticated;

-- Merges two or more orders' items into one shared ticket group. v1
-- limitation (see header comment): every order must already share the
-- same current status, and none may already be split.
create function public.merge_orders_into_ticket(
  p_order_ids uuid[],
  p_label text
)
returns public.order_ticket_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_restaurant_id uuid;
  v_role text;
  v_distinct_restaurants integer;
  v_distinct_statuses integer;
  v_shared_status text;
  v_found_count integer;
  v_already_grouped_count integer;
  v_group_id uuid;
begin
  if v_user_id is null then
    raise exception 'TICKET_MERGE_UNAUTHENTICATED: sign-in required' using errcode = '28000';
  end if;

  if p_order_ids is null or array_length(p_order_ids, 1) is null
    or array_length(p_order_ids, 1) < 2
  then
    raise exception 'TICKET_MERGE_NEEDS_TWO_ORDERS: merge requires at least two orders'
      using errcode = '22023';
  end if;

  select count(*) into v_found_count from public.orders where id = any(p_order_ids);
  if v_found_count <> array_length(p_order_ids, 1) then
    raise exception 'TICKET_MERGE_ORDER_NOT_FOUND: one or more orders not found'
      using errcode = 'P0002';
  end if;

  -- uuid has no min()/max() aggregate, so restaurant_id is picked
  -- separately below (safe once distinct-count is confirmed to be 1 —
  -- every order then shares the same value anyway).
  select count(distinct restaurant_id), count(distinct status)
    into v_distinct_restaurants, v_distinct_statuses
  from public.orders where id = any(p_order_ids);

  if v_distinct_restaurants <> 1 then
    raise exception 'TICKET_MERGE_CROSS_RESTAURANT: orders must belong to the same restaurant'
      using errcode = '22023';
  end if;

  select restaurant_id into v_restaurant_id
  from public.orders where id = p_order_ids[1];

  v_role := public.current_restaurant_role(v_restaurant_id);
  if v_role is null or v_role not in ('owner', 'manager', 'kitchen') then
    raise exception 'TICKET_MERGE_FORBIDDEN: insufficient role' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.orders where id = any(p_order_ids) and status in ('served', 'cancelled')
  ) then
    raise exception 'TICKET_MERGE_ORDER_FINALIZED: an order is already served or cancelled'
      using errcode = '23514';
  end if;

  if v_distinct_statuses <> 1 then
    raise exception 'TICKET_MERGE_STATUS_MISMATCH: orders must currently share the same status'
      using errcode = '23514';
  end if;

  select status into v_shared_status from public.orders where id = p_order_ids[1];

  select count(*) into v_already_grouped_count
  from public.order_items
  where order_id = any(p_order_ids) and ticket_group_id is not null;

  if v_already_grouped_count > 0 then
    raise exception 'TICKET_MERGE_ALREADY_SPLIT: an order has already been split and cannot be merged'
      using errcode = '23514';
  end if;

  insert into public.order_ticket_groups (restaurant_id, label, status)
  values (v_restaurant_id, p_label, v_shared_status)
  returning id into v_group_id;

  update public.order_items
  set ticket_group_id = v_group_id
  where order_id = any(p_order_ids);

  return (select otg from public.order_ticket_groups otg where otg.id = v_group_id);
end;
$$;

comment on function public.merge_orders_into_ticket(uuid[], text) is
  'Combines 2+ orders'' items into one shared kitchen ticket group. v1: orders must currently share the same status and none may already be split. Bills/totals/order numbers are never touched. See docs/security.md#order-splitting-and-merging.';

revoke execute on function public.merge_orders_into_ticket(uuid[], text) from public;
grant execute on function public.merge_orders_into_ticket(uuid[], text) to authenticated;
