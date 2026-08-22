-- Batch 8: two narrow, count-only SECURITY DEFINER functions backing
-- abuse protection the Batch 7 final report flagged as a known gap —
-- customer session creation and order submission. Both follow the exact
-- pattern get_table_by_token()/get_public_order_settings() already
-- established: return the minimum a public/customer caller needs and
-- nothing else, rather than widen RLS or reach for the admin client.
--
-- Neither of these is a hard security boundary the way order idempotency
-- or tenant isolation are — they're soft abuse throttles, generous enough
-- that no real customer should ever hit them. See docs/security.md#rate-limiting
-- for the full reasoning and docs/production-audit.md for why IP address
-- is deliberately not used as the identity boundary for either.

-- Counts how many customer_sessions rows have been created for a given
-- table in a trailing window. A plain RLS-respecting SELECT can't answer
-- this: customer_sessions' RLS is `user_id = auth.uid()`, so a brand-new
-- anonymous caller (who by definition has no session row yet at the
-- moment this check runs) would just see a count of zero for everyone,
-- including a real flood — the whole point of the check. This function
-- returns ONLY a count for ONE table, never any session's contents,
-- identity, or which restaurant/table a different token belongs to.
create function public.count_recent_sessions_for_table(
  p_table_id uuid,
  p_window_seconds integer
)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)
  from public.customer_sessions
  where table_id = p_table_id
    and started_at >= now() - (p_window_seconds || ' seconds')::interval
$$;

comment on function public.count_recent_sessions_for_table(uuid, integer) is
  'Count-only, single-table session-creation throttle signal for the QR route handler. Returns no session content. See docs/security.md#customer-session-creation-rate-limiting.';

grant execute on function public.count_recent_sessions_for_table(uuid, integer) to anon, authenticated;

-- Counts how many orders a customer's own session has submitted in a
-- trailing window. Unlike the function above, this one *could* be
-- answered by the ordinary RLS-respecting client directly (orders_select_own_or_staff
-- already lets a customer read their own orders) — it's added here purely
-- for symmetry/centralization with the session-creation check above and so
-- the threshold lives in one place next to it, not because RLS would
-- otherwise block it.
create function public.count_recent_orders_for_session(
  p_customer_session_id uuid,
  p_window_seconds integer
)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)
  from public.orders
  where customer_session_id = p_customer_session_id
    and created_at >= now() - (p_window_seconds || ' seconds')::interval
$$;

comment on function public.count_recent_orders_for_session(uuid, integer) is
  'Count-only order-submission throttle signal, scoped to the caller''s own session. Idempotency (submit_order()) remains the authority against duplicate orders — this is a separate, softer check against many distinct submission attempts. See docs/security.md#order-submission-abuse-protection.';

-- Postgres grants EXECUTE on every newly created function to PUBLIC by
-- default (spec section 28: "review EXECUTE grants") — explicitly revoked
-- here, matching transition_order_status()'s established pattern, since a
-- session must already exist (and be the caller's own) for this check to
-- mean anything; an anon caller has no session yet by definition.
revoke execute on function public.count_recent_orders_for_session(uuid, integer) from public;
grant execute on function public.count_recent_orders_for_session(uuid, integer) to authenticated;
