-- Clover, phase 1: Tableside orders reach the Clover register.
--
-- The POS seam (20260908100000) already writes a pos_outbox row inside
-- each order's own transaction. Clover is its first deliverer: right after
-- an order is placed, the app claims the restaurant's due rows, creates
-- each order in Clover with the atomic order endpoint, and records the
-- Clover order id here. A failed delivery backs off and retries
-- (src/lib/pos/outbox-core.ts); one that keeps failing is abandoned and
-- shown to the owner.
--
-- Square doesn't use the outbox (Square only shows an API order once it's
-- paid, so Square gets the sale with its payment), so from now on only a
-- Clover connection enqueues anything.

alter table public.pos_outbox add column external_id text;

comment on column public.pos_outbox.external_id is
  'What the POS called the order once delivered: the Clover order id.';

create or replace function public.enqueue_pos_order_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Only for restaurants whose POS takes orders as they're placed. Every
  -- other restaurant writes nothing at all.
  if not exists (
    select 1
    from public.restaurant_pos_integrations i
    where i.restaurant_id = new.restaurant_id
      and i.is_enabled
      and i.provider = 'clover'
  ) then
    return new;
  end if;

  -- ON CONFLICT DO NOTHING rather than letting a duplicate raise: this
  -- runs inside submit_order()'s transaction, and an outbox collision
  -- must never be the reason a customer's order fails to be placed.
  insert into public.pos_outbox (restaurant_id, order_id, event_type)
  values (new.restaurant_id, new.id, 'order.created')
  on conflict (order_id, event_type) do nothing;

  return new;
end;
$$;

-- Claims a restaurant's due deliveries for one worker. Each claimed row's
-- next attempt moves two minutes out, so a second worker running at the
-- same moment (two orders placed together) skips it rather than pushing
-- the same sale twice; the worker sets the real outcome when it's done.
create function public.claim_pos_outbox(p_restaurant_id uuid, p_limit integer)
returns setof public.pos_outbox
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    with due as (
      select o.id
      from public.pos_outbox o
      where o.restaurant_id = p_restaurant_id
        and o.status = 'pending'
        and o.next_attempt_at <= now()
      order by o.next_attempt_at
      limit greatest(1, least(p_limit, 50))
      for update skip locked
    )
    update public.pos_outbox o
    set next_attempt_at = now() + interval '2 minutes'
    from due
    where o.id = due.id
    returning o.*;
end;
$$;

revoke execute on function public.claim_pos_outbox(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_pos_outbox(uuid, integer) to service_role;
