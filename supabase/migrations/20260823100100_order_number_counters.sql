-- Backing store for human-friendly, per-restaurant order numbers (#1042,
-- #1043, ...) — see submit_order() in 20260823100600_submit_order_function.sql
-- for the atomic allocation logic. Deliberately NOT `select max(order_number)
-- + 1 from orders`, which is unsafe under concurrency (two transactions can
-- both read the same max before either commits, producing a duplicate).
--
-- One row per restaurant, created on that restaurant's first order (not at
-- restaurant-creation time) via `insert ... on conflict do update`, which is
-- itself the atomic increment — see the function for why that specific SQL
-- shape is safe under concurrent callers.
--
-- No RLS policies at all: this table is never read or written by anything
-- except submit_order(), a SECURITY DEFINER function. RLS is still enabled
-- (project convention — see docs/database.md), so it's deny-all to every
-- ordinary role; only the function's elevated privileges can touch it.
create table public.order_number_counters (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  last_number bigint not null default 0,

  constraint order_number_counters_last_number_non_negative check (last_number >= 0)
);

comment on table public.order_number_counters is
  'Per-restaurant order number sequence, incremented atomically inside submit_order(). No client-facing access — see docs/database.md#order-numbers-batch-5.';

alter table public.order_number_counters enable row level security;
