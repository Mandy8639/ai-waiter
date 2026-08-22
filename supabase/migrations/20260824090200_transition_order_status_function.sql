-- The order engine's second entry point, alongside submit_order() (Batch
-- 5). Same established pattern: one SECURITY DEFINER PL/pgSQL function,
-- called via the caller's own per-request (RLS-respecting) Supabase
-- client — never the admin/service-role client. The escalation is needed
-- because there is still no client-facing UPDATE policy on `orders` or
-- INSERT policy on `order_status_history` at all (Batch 5's "no write
-- policy for anyone" design, unchanged) — an ordinary `authenticated`
-- connection genuinely cannot perform this transition, correctly or
-- otherwise, without it.
--
-- Signature is deliberately minimal: `p_order_id` and `p_target_status`.
-- No restaurant_id, no customer_session_id, no current_status — every one
-- of those is derived server-side, from `auth.uid()` and the order's own
-- current row (read under `FOR UPDATE`, see below). This is what makes "a
-- client cannot claim a different restaurant/role/current-status" true
-- structurally, not just by validation.
create or replace function public.transition_order_status(
  p_order_id uuid,
  p_target_status text
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_order public.orders%rowtype;
  v_role text;
  v_actor_type text;
  v_previous_status text;
begin
  if v_user_id is null then
    raise exception 'ORDER_TRANSITION_UNAUTHENTICATED: sign-in required' using errcode = '28000';
  end if;

  if p_target_status is null
    or p_target_status not in ('pending', 'confirmed', 'preparing', 'ready', 'served', 'cancelled')
  then
    raise exception 'ORDER_TRANSITION_INVALID_STATUS: unknown target status';
  end if;

  -- Row lock: the actual mechanism behind "two employees confirm the same
  -- order simultaneously -> exactly one succeeds." A concurrent second
  -- caller blocks here until the first transaction commits (or rolls
  -- back), then re-reads the row and sees the ALREADY-updated status —
  -- so its own attempted transition (e.g. preparing -> ready, when the
  -- order is now already 'ready') is evaluated against reality, not a
  -- stale read, and is rejected as invalid rather than double-applied.
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_TRANSITION_NOT_FOUND: order not found';
  end if;

  -- Restaurant membership and role, derived from auth.uid() against the
  -- order's OWN restaurant_id — never a client-supplied value. A customer
  -- (an anonymous-auth `authenticated` user, but with no restaurant_users
  -- row anywhere) always gets NULL here, which is what makes "a customer
  -- cannot call this function" true regardless of what order_id they try.
  v_role := public.current_restaurant_role(v_order.restaurant_id);
  if v_role is null then
    raise exception 'ORDER_TRANSITION_FORBIDDEN: not a member of this restaurant' using errcode = '42501';
  end if;

  -- Structural legality is checked before role permission, and reported
  -- with its own distinct error code — "that transition doesn't exist"
  -- (e.g. skipping a step, going backward, re-applying the same one twice,
  -- moving out of a terminal state) is a different fact from "you're not
  -- allowed to do that," and deserves a different message. An owner
  -- attempting pending -> served sees ORDER_TRANSITION_INVALID_TRANSITION,
  -- not a misleading "forbidden."
  if not public.is_valid_order_status_transition(v_order.status, p_target_status) then
    raise exception 'ORDER_TRANSITION_INVALID_TRANSITION: cannot move an order from % to %',
      v_order.status, p_target_status
      using errcode = '23514';
  end if;

  if not public.role_can_transition_order(v_role, v_order.status, p_target_status) then
    raise exception 'ORDER_TRANSITION_FORBIDDEN: % cannot move an order from % to %',
      v_role, v_order.status, p_target_status
      using errcode = '42501';
  end if;

  -- actor_type mirrors the caller's restaurant_users.role exactly (Batch 6
  -- widened the CHECK constraint to include 'kitchen' for this reason) —
  -- the audit trail should say what role acted, not a lossy approximation.
  v_actor_type := v_role;
  v_previous_status := v_order.status;

  update public.orders
  set status = p_target_status
  where id = p_order_id
  returning * into v_order;
  -- (trg_orders_enforce_status_transition re-validates this is structurally
  -- legal regardless of the role check above — defense in depth, see
  -- 20260824090100_order_status_transitions.sql.)

  insert into public.order_status_history (
    restaurant_id, order_id, previous_status, status, actor_type, actor_id
  )
  values (
    v_order.restaurant_id, v_order.id, v_previous_status, p_target_status, v_actor_type, v_user_id
  );

  return v_order;
end;
$$;

comment on function public.transition_order_status(uuid, text) is
  'The only path that changes an order''s status. Derives restaurant/role/current-status entirely server-side from auth.uid() and the order''s own row; row-locks the order for the duration of the check so concurrent transition attempts resolve to exactly one success. See docs/database.md#order-state-machine-batch-6 and docs/security.md#order-status-transitions.';

-- Postgres grants EXECUTE on every newly created function to PUBLIC by
-- default — an easy thing to overlook (spec section 28: "review EXECUTE
-- grants"). Explicitly revoked here so `anon` (and any other role) has no
-- path to this function at all; only `authenticated` does. A genuinely
-- unauthenticated request is therefore rejected at the grant level itself
-- ("permission denied for function"), before the function body's own
-- auth.uid() check would otherwise have to catch it.
revoke execute on function public.transition_order_status(uuid, text) from public;
grant execute on function public.transition_order_status(uuid, text) to authenticated;
