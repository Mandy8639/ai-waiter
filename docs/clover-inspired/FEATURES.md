# Features

Everything here is **proposed**. "Existing" marks behavior already in the code.

## F1: Live floor map

**Purpose.** Staff see the whole room at a glance: which tables need someone, and why.

**Who.** Owners and managers edit the layout. Every member sees the live map, the same audience
as Settle up, because the waiter is the one who needs it.

### Journey: lay out the room (owner/manager)

1. Dashboard → Tables → **Floor plan**.
2. Add a section ("Main room", "Patio"). One section exists by default, so a restaurant that
   never touches this still gets a working map.
3. Drag existing tables onto the grid. Each table gets a shape (square, round, rectangle), a size,
   a rotation in 90° steps, and a seat count.
4. Optionally add landmarks (bar, kitchen door, wall) as plain shapes with labels. They can't be
   clicked during service.
5. Save. Tables never placed appear in a tray beside the grid, never hidden.

**Rules**

- Positions snap to a grid. Two tables can't overlap in the same section.
- Seats: 1–30. Name: the existing `table_number`. The map never makes a second name.
- Deleting a section moves its tables back to the tray. It never deletes tables, whose QR codes
  are printed and on the tables.
- Deactivating a table (existing `is_active`) shows it greyed out, not missing.

### Journey: run service (any member)

1. Dashboard → **Floor**.
2. Each table shows one state, chosen by the first rule that matches:

| #   | State                      | Rule (from data Tableside already records)                                |
| --- | -------------------------- | ------------------------------------------------------------------------- |
| 1   | **Wants the bill**         | an open `table_requests` row with kind `bill`                             |
| 2   | **Needs a waiter**         | an open `table_requests` row with kind `waiter`                           |
| 3   | **Ready to serve**         | any order at the table in status `ready`                                  |
| 4   | **Partly paid**            | an open split with at least one paid part, or a table bill (F2) part paid |
| 5   | **Waiting for food**       | any order in `confirmed` or `preparing`                                   |
| 6   | **Ordered, not confirmed** | any order in `pending`                                                    |
| 7   | **Eating**                 | orders, all `served`, some unpaid                                         |
| 8   | **Paid**                   | orders, all covered by succeeded payments, session still active           |
| 9   | **Seated**                 | an active `customer_session`, no orders yet                               |
| 10  | **Free**                   | none of the above                                                         |

The request states come first because they're the only ones where a guest is waiting on a
person right now. 3. Each table also shows how long it's been in that state and the unpaid amount. 4. Tapping a table opens a side panel: its orders, an open request (with Resolve), and **Settle
up** for this table (the existing in-person payment flow, scoped to the table). 5. The map updates live through the same Realtime channels the kitchen board uses, and resyncs
on reconnect and when the tab becomes visible, like the board does today.

**States the screen must handle**

- _Loading:_ a skeleton grid.
- _No layout yet:_ a list of tables by state (the same data, no positions) and a "Lay out your
  room" call to action for owners and managers.
- _Offline:_ a stale-data banner with the last update time. States are never guessed.
- _Permission:_ a kitchen-only role sees the map read-only, without Settle up.

### Verification scenarios (F1)

| #    | Given                                                | When            | Expect                                                                              |
| ---- | ---------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| F1-1 | Table 4 has a `ready` order and an open bill request | open Floor      | Table 4 shows **Wants the bill** (rule 1 wins), with "1 ready" as a secondary badge |
| F1-2 | Table 7 has a split with 1 of 3 parts paid           | open Floor      | **Partly paid**, showing the amount still owed                                      |
| F1-3 | All orders at table 2 covered by succeeded payments  | open Floor      | **Paid**. Settle up shows nothing for table 2.                                      |
| F1-4 | A table was never placed on the grid                 | open Floor      | It shows in the tray with its live state, not hidden                                |
| F1-5 | A kitchen-role member                                | opens Floor     | Map visible, no Settle up and no layout editing                                     |
| F1-6 | Network drops for 30 s, then an order is placed      | network returns | Map resyncs and shows the new state without a reload                                |

## F2: Table bill (Tableside's version of split by guest)

**The gap.** A tab is one phone (`create_tab_split` and `start_tab_payment` read
`orders.customer_session_id`). When four friends each scan the QR and order on their own
phones, there are four tabs. Each can pay their own, which already works and is a better default
than Clover's seat assignment. But nobody can **pay for the whole table by card**, and nobody can
split one table-wide total. Staff can settle a whole table only in person (cash or the card
machine).

**Purpose.** Let one guest pay for everyone at the table, or split the whole table's total, by card.

### Journey: "I'll get this" (diner)

1. On the bill screen, a diner taps **Pay for the table**.
2. Tableside shows every unpaid order at the table, grouped by phone. Each phone is labeled
   "You", "Guest 2", "Guest 3" (never a name or device detail), with each phone's subtotal and
   the table total.
3. Every other phone at the table sees a notice: "Someone is paying for the table." Their own
   pay button is paused while the table bill is open.
4. The diner chooses **Pay all**, or **Split** (equal or by dish across the whole table), using
   the existing split screens and share link.
5. When payment settles (Stripe webhook, unchanged), every covered order is paid. Every phone
   sees "Paid by your table" on its own receipt.

### Journey: start it from staff (Settle up)

Staff can open a table bill from the table panel (F1) and show a QR or link for one guest to
pay. This covers a table where one person ordered for everyone and someone else wants to pay.

**Rules**

- A table bill covers only orders that are **unpaid and not in an open split or payment** at the
  moment it's created, frozen like `tab_split_orders`. Orders placed afterwards aren't swept in.
  They stay on their own tab.
- Only one open table bill per table. Opening one while a phone has a Checkout open is refused,
  the same way `PAYMENT_IN_PROGRESS` works today. The caller expires the Checkout first.
- A phone with an open split of its own blocks the table bill, so a split and a table bill can
  never cover the same order.
- Privacy: other phones' orders are shown as item names and prices only. They're never linked
  to a person, and no session, user or device ID ever reaches the browser. The payer sees what
  they're paying for, which is the minimum needed.
- Cancelling: the creator, or any member, can cancel an open table bill while nothing has been
  paid. Once any part is paid, only the existing refund path undoes it.
- Payment completion and coverage follow the split-bill invariant exactly. Nothing is marked
  paid until the whole bill is, and the parts add up to the total to the cent.

### Verification scenarios (F2)

| #    | Given                                                          | When                                       | Expect                                                                                                                        |
| ---- | -------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| F2-1 | Phones A, B, C at table 5, unpaid orders $20.00, $15.50, $9.25 | A taps Pay for the table, Pay all          | Checkout for $44.75. After the webhook, all three orders are covered and each `payment_orders.amount` equals its order total. |
| F2-2 | Same, A chooses an equal split in 3                            | three payers pay                           | Parts are 14.92 + 14.92 + 14.91 = 44.75. No order paid until the third part.                                                  |
| F2-3 | B has a Checkout open for their own tab                        | A taps Pay for the table                   | Refused with an in-progress message. A succeeds after B's Checkout expires.                                                   |
| F2-4 | A table bill is open, then C orders more                       | —                                          | C's new order isn't in the bill and stays payable on C's tab                                                                  |
| F2-5 | Table bill open                                                | B tries to pay their own tab               | Refused (blocked by the trigger, like splits today)                                                                           |
| F2-6 | Any state                                                      | inspect the network responses on A's phone | No session ID, user ID or device detail of B or C appears                                                                     |

## F3: Clover connector mapping

**Purpose.** Tableside orders appear on Nashta's Clover register, and payments taken on the
register mark Tableside orders paid. This extends `docs/pos-integration.md`.

**Rules taken from Clover's published SDK docs**, verified against the source (see
[EVIDENCE_AND_UNKNOWNS.md](./EVIDENCE_AND_UNKNOWNS.md)):

- An order created through REST must set `state: "open"`. With no state, the order is
  **hidden**: not shown on Register, retrievable only by ID. This silent failure is the one most
  worth testing.
- Prices and totals are integer **cents**.
- `externalReferenceId` carries the Tableside order ID, used to match orders both ways.
- A Clover payment (`paymentState` `PAID`) maps to `record_in_person_payment`-style coverage
  with method `card_terminal`. It's a record, not a Stripe charge, so the existing refund rules
  apply unchanged.

### Verification scenarios (F3, sandbox merchant only)

| #    | When                                                  | Expect                                                                                                                                   |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| F3-1 | A Tableside order is placed at a connected restaurant | A Clover order exists with `state=open`, `externalReferenceId` = the Tableside order ID, and line prices in cents matching `order_items` |
| F3-2 | The connector's open-state is removed in a test build | The test that checks orders are visible on Register fails (it guards the hidden-order trap)                                              |
| F3-3 | The order is paid on the sandbox register             | The Tableside order is covered by one `card_terminal` payment for the same amount, exactly once even if the webhook fires twice          |
| F3-4 | $10.005-style rounding cases                          | The cents conversion matches `to_minor_units` and never silently rounds                                                                  |
