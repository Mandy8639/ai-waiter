# Pickup ordering

A diner at a counter (a food truck, a café, a brewery bar) scans a QR code, orders, picks a pickup
time and gives a name to call. The kitchen sees when to start cooking so the food is ready at that
time. Migration: `supabase/migrations/20261022090000_pickup_ordering.sql`.

## A counter is a kind of table

`tables.kind` is `table` (the default) or `counter`. A counter is made the same way as a table
(Dashboard → Tables → New table → Kind: Pickup counter) and gets the same kind of QR code.

That was a deliberate choice over a separate "pickup" path. Every customer session, cart, order,
RLS policy and SECURITY DEFINER function already assumes a table, so a counter reuses all of them:
the QR scan route, `submit_order()`, the kitchen board, card and cash payments. What a counter
changes:

- Its orders must carry a pickup time and a name (below).
- It can't be reserved (`refuse_reservation_on_counter()`), and reservation screens leave it out.
- The settle-up screen lists its orders **per diner**, not per table: strangers share a counter,
  never a bill. Card payment was already per diner session (`start_tab_payment()` gathers by
  `auth.uid()`).

## Slots

Three numbers per restaurant, in Settings → Pickup (`restaurant_settings`):

| Setting                  | Column                 | Default | Allowed           |
| ------------------------ | ---------------------- | ------- | ----------------- |
| Pickup times every       | `pickup_slot_minutes`  | 15      | 5, 10, 15, 20, 30 |
| Orders per pickup time   | `pickup_slot_capacity` | 6       | 1–100             |
| Notice the kitchen needs | `pickup_lead_minutes`  | 20      | 5–240 minutes     |

A time is valid when it is on the grid in the restaurant's own clock, at least the notice away, at
most 8 hours ahead (`pickup_max_ahead()`, kept under the kitchen board's 12-hour look-back), the
restaurant is open then (any published menu on at that time, special hours included), and the slot
isn't full. Cancelled orders free their place. Every slot length divides an hour, so the grid
survives a daylight-saving change.

`pickup_slot_problem()` is the one place that rule lives. It returns a sentence a diner can act on
("That pickup time just filled up. Please choose another.") or null.

## How an order gets its time

1. The cart page calls `get_pickup_options()`: whether this visit is at a counter, the timezone,
   the diner's current choice, and the slots with places left.
2. "Place pickup order" sends the time and name with the order. `submitOrder()` saves them on the
   cart (`set_cart_pickup()`, which checks the time early), then calls `submit_order()` as before.
3. `trg_orders_apply_pickup` (BEFORE INSERT on orders) takes a per-restaurant advisory lock,
   checks the slot again, and copies the time and name onto the order. Two diners racing for the
   last place cannot both get it. An order at a table is forced to `dine_in` with no pickup
   fields.

`submit_order()` itself is unchanged. Its idempotent replay returns before inserting, so a retried
submit lands on the original order even after its slot filled. `submitOrder()` keeps that
property when saving the choice fails: it looks for an order already placed under the same key.

The AI waiter places orders through the same `submitOrder()` without a choice of its own. At a
counter it uses the time the diner picked in the cart, or relays "Choose a pickup time before
placing your order."

## When the kitchen starts

`ticket_release_at` = pickup time − the longest `preparation_time` among the order's dishes − busy
mode's extra minutes (if on). A dish with no preparation time counts as the restaurant's notice
time, rather than an invented number.

On the kitchen board a pickup order:

- arrives and rings like any order, and is accepted the same way, so the diner is confirmed at once;
- reads **Pickup 12:30 · Priya** wherever a table's name goes (cards, dialogs, printed tickets);
- carries a **Start 12:10** badge, which becomes **Start now** when the time comes;
- once accepted but not yet due, sits dimmed at the bottom of its column, soonest start first.

The original plan hid a pickup ticket until its start time. That was dropped: the server's repeat
ring (`order_rings_due()`, 10 minutes from creation) would ring for an order no one could see, and
the diner would wait unconfirmed for hours.

Staff can **Push back** a pickup order by one or two slots from its detail dialog
(`change_pickup_time()`; any member of the restaurant, since front of house answers the phone).
The new time obeys the same rules, except that the slot it leaves doesn't count against it. Moving
an order earlier isn't offered: that would promise food before the diner planned to come.

## Not yet

- Text messages to the diner (confirmed / ready / delayed): the next PR, built against a fake
  sender until an SMS provider is chosen.
- An ordering page without a QR code, and delivery.
- The QR scan throttle is per table (30 new sessions per 5 minutes,
  `CUSTOMER_SESSION_RATE_LIMIT_MAX`). Raise it if a busy counter ever hits it.
- No end-to-end test: those need a real Supabase project. The database rules are covered by
  `tests/integration/db/pickup-ordering.test.ts`. The form, the board and `submitOrder()` are
  covered by unit tests.
