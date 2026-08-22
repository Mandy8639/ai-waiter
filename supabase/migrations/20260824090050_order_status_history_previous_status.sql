-- Batch 5's order_status_history recorded only the NEW status per row —
-- enough to reconstruct the sequence, but spec section 5 of this batch
-- wants the exact transition (from -> to) directly queryable per row,
-- without having to look at the previous row. NULL for the very first
-- history row an order ever gets (submit_order()'s initial 'pending' event
-- has no prior status) — every row transition_order_status() writes from
-- here on always sets it.
alter table public.order_status_history
  add column previous_status text;

alter table public.order_status_history
  add constraint order_status_history_previous_status_valid check (
    previous_status is null
    or previous_status in ('pending', 'confirmed', 'preparing', 'ready', 'served', 'cancelled')
  );

comment on column public.order_status_history.previous_status is
  'The status immediately before this transition, or NULL for the initial ''pending'' row a new order gets from submit_order().';
