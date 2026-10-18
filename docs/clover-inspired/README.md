# Clover-inspired features for Tableside

What a full-service POS (Clover) does that Tableside doesn't yet, and how Tableside should build
its own version of each, starting from what is already here.

## Where the ideas came from, and what was off-limits

| Source                                                                                   | Used for                                       | Why it is allowed                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`clover/clover-android-sdk`](https://github.com/clover/clover-android-sdk)              | The order, table, payment and print data model | Apache 2.0. Clover publishes it for developers to read and build on.                                                                                                                                                  |
| Clover's public developer docs                                                           | REST behavior the connector depends on         | Published for developers. Your account already uses them.                                                                                                                                                             |
| Features Clover advertises in general terms (floor plan, split by seat, partial payment) | Which product ideas are worth having           | These are ordinary restaurant-POS ideas, not Clover's code.                                                                                                                                                           |
| **Not used:** the clover.com website, the Register app, the dashboard's code             | —                                              | Clover's Terms of Service forbid automated scraping (§2.6(c)) and reverse engineering or derivative works (§13.2). The attempt stopped at the terms page. See [EVIDENCE_AND_UNKNOWNS.md](./EVIDENCE_AND_UNKNOWNS.md). |

Nothing below copies Clover's code, screens or text. Every design is Tableside's own, built on
Tableside's existing tables and functions.

## What Tableside already has

The first comparison overstated the gaps. Several things Clover does already exist here, and in
some cases the Tableside version is stricter:

| Clover concept                                                                    | Tableside today                                                                                                                                               | Verdict                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `paymentState` kept apart from the order's `state`                                | `order_payments` + `payment_orders`. "Paid" means a succeeded payment covers the order, and is never a status on `orders` (`20260902090000_tab_payments.sql`) | **Already done.** No new payment-status column is needed.                                                  |
| Money in integer cents                                                            | Split math in minor units, by largest remainder (`allocate_minor`, `20261002090000_split_bill.sql`)                                                           | **Already done** where it matters. Order columns are `numeric(10,2)`, so a connector converts at the edge. |
| `PayType` `FULL` / `SPLIT_ITEM` / `SPLIT_CUSTOM`                                  | Whole tab, `by_dish` and `equal` splits                                                                                                                       | **Mostly done.** `SPLIT_GUEST` is the gap.                                                                 |
| `printGroup` (send each line to a printer)                                        | Kitchen stations. The line's station is frozen at order time (`20261001090000_kitchen_stations.sql`)                                                          | **Already done.**                                                                                          |
| Line keeps a snapshot of name and price                                           | `order_items.item_name` / `unit_price`                                                                                                                        | **Already done.**                                                                                          |
| Paid in person on the register's own terminal                                     | `record_in_person_payment('card_terminal')` (#112)                                                                                                            | **Already done.**                                                                                          |
| **Floor plan:** table position, size, rotation, capacity, sections, walls and bar | `tables` has `table_number`, `display_name`, `is_active`                                                                                                      | **Gap → F1**                                                                                               |
| **Seats/guests, split by guest**                                                  | A tab is **one phone** (`customer_session`). A table where four phones ordered has four separate tabs, and nobody can pay for the table by card.              | **Gap → F2**                                                                                               |
| `externalReferenceId`, open-state rule for REST-created orders                    | `pos_outbox` seam, no connector                                                                                                                               | **Planned → F3**                                                                                           |

## The three features

1. **F1: Live floor map.** Lay out the room once. During service, each table shows its live
   state (seated, ordering, waiting for food, eating, wants the bill, partly paid, paid), worked
   out from data Tableside already records.
2. **F2: Table bill.** All phones at one table combined into one bill. One person pays for
   everyone, or the existing equal or by-dish split runs across the whole table. This is
   Tableside's version of split by guest: the phones _are_ the guests, so nobody assigns seats
   by hand.
3. **F3: Clover connector mapping.** How a Tableside order becomes a Clover order, and how a
   Clover payment marks it paid, on top of `pos_outbox`.

**Build first: F1.** It needs no money code (it only reads), it's useful to every restaurant
with or without a POS, and F2 reuses its table-state query. See [REBUILD_PLAN.md](./REBUILD_PLAN.md).

## Files

- [FEATURES.md](./FEATURES.md): user journeys, rules and verification scenarios
- [ARCHITECTURE.md](./ARCHITECTURE.md): how each feature fits the existing code, with diagrams
- [API_AND_DATA.md](./API_AND_DATA.md): proposed schema and functions (all **proposed**)
- [UI_SPEC.md](./UI_SPEC.md): screens and components
- [REBUILD_PLAN.md](./REBUILD_PLAN.md): phases and acceptance criteria
- [EVIDENCE_AND_UNKNOWNS.md](./EVIDENCE_AND_UNKNOWNS.md): sources, limits, open questions
