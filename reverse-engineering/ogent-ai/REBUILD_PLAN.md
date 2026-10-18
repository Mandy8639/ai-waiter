# Rebuilding Ogent's functionality

This plan rebuilds Ogent's **functionality**, as specified in [FEATURES.md](FEATURES.md), on
**Tableside**, the codebase this report lives in. Copying Ogent's code, copy, branding or assets
is out of scope. Only behaviour is reproduced. Proposed schema and endpoints are in
[API_AND_DATA.md](API_AND_DATA.md#proposed-replacement-design).

## Starting point: what Tableside already has

| Ogent capability                     | Tableside today                                                                              | Gap                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Table QR ordering, no app/account    | Yes: `/r/[restaurantSlug]`, anonymous auth, per-table QR (`src/lib/tables/qr-sheet-core.ts`) | —                                                   |
| Pay at table, tips, Apple/Google Pay | Yes: Stripe Connect per restaurant, tips, whole-table tab                                    | —                                                   |
| Split bill                           | Yes: `tab_splits`, `tab_split_units`, `tab_split_orders`                                     | Tableside ahead                                     |
| Order statuses + kitchen board       | Yes: confirmed → preparing → ready → served; realtime; ticket groups; stations               | —                                                   |
| Refunds                              | Yes: `payment_refunds`                                                                       | Check per-line partial                              |
| 86 / sold out mid-service            | Yes: `set_menu_item_availability()` (kitchen sold-out migration)                             | No auto-restore next day                            |
| Pause ordering                       | Yes: `orders_paused_until`, busy mode (`20261015090000_kitchen_busy_mode.sql`)               | Preset durations only in UI                         |
| Menu hours / schedules               | Yes: `menus`, `menu_hours`                                                                   | No holiday / special-date overrides                 |
| Analytics                            | Partial: `/dashboard/reports`, `dish_daily_stats`, daily summary cron                        | Customers (Top Spend), source/fulfilment breakdowns |
| Merchant push + audio alerts         | Yes: web push, native push tokens, "order ring" until accepted                               | —                                                   |
| AI menu import                       | Yes: photo → vision model → human review (`docs/menu-import.md`)                             | No URL/scrape source                                |
| POS integration                      | Seam only: `restaurant_pos_integrations`, `pos_outbox` (`docs/pos-integration.md`)           | **No connector**                                    |
| AI                                   | Guest-facing AI waiter (`src/lib/ai/tools`)                                                  | **No operator assistant**                           |
| **Pickup / order-ahead / slots**     | **None** (dine-in only)                                                                      | **Largest gap**                                     |
| **Guest SMS**                        | **None**                                                                                     | Needed with pickup                                  |
| Delivery                             | None                                                                                         | Large                                               |
| DoorDash / Uber Eats ingest          | None                                                                                         | Large                                               |

## Phases

Priority reflects (value to an Ogent-like product) × (how well specified the behaviour is) ÷
(effort).

### Phase 1 — Order-ahead pickup and guest SMS _(P0, build first)_

**Why first:** Ogent's best-documented flow (E07), the biggest functional gap in Tableside, and
it reuses `submit_order()`, the status machine, the kitchen board and Stripe checkout.

Work:

1. `fulfillment` and `source` on orders; a counter QR (no table) entry route.
2. Pickup slot rules, a slot API, and a capacity check inside `submit_order()`'s transaction.
3. `ticket_release_at`: the kitchen board shows pickup tickets only from release time.
4. Phone capture with explicit SMS consent at checkout; `guest_messages` outbox; a provider
   adapter (Twilio or similar) behind an interface; STOP/HELP inbound handling.
5. SMS on `confirmed`, `ready`, staff "delay" and "change pickup time".

Dependencies: SMS provider account and sender registration (10DLC in the US); legal review of
consent copy.

Acceptance criteria:

- [ ] A guest can place a pickup order for an open slot without an account and pay by card.
- [ ] Ordering is refused when the chosen slot is at `max_orders_per_slot`. Two concurrent
      submits for the last place produce exactly one success (tested with parallel calls).
- [ ] A slot earlier than `now + min_lead_minutes` is not offered and is rejected server-side.
- [ ] The kitchen board hides the ticket until `ticket_release_at` (tested with a fake clock).
- [ ] Marking the order `ready` enqueues exactly one `ready` SMS. A retry of the transition
      does not send a second one.
- [ ] No SMS is sent when `sms_opt_in = false`. An inbound `STOP` sets opt-out for that number.
- [ ] Changing the pickup time updates `ticket_release_at` and sends one `pickup_changed` SMS.
- [ ] Existing dine-in tests stay green (`npm test`, e2e).

### Phase 2 — Operator AI assistant _(P1)_

Work: an in-dashboard chat first, inbound SMS second. Tools wrap **existing** functions only
(`set_menu_item_availability`, modifier availability, the pause/busy setters, price update). It
must not open a parallel write path, matching the rule in `docs/ai.md`. Add an `operator_commands`
audit log and `unavailable_until` for 86-until-next-open.

Acceptance criteria:

- [ ] "86 the salmon" sets the item unavailable until the next opening time in the
      restaurant's timezone. The item is orderable again at that time without manual action.
- [ ] "Pause ordering for 1 hour" sets `orders_paused_until = now + 60 min`. `submit_order()`
      refuses orders until then.
- [ ] A price change or item deletion asks for confirmation. Nothing changes until "yes".
- [ ] An ambiguous item name ("the burger" with 3 burgers) asks which one and changes nothing.
- [ ] A kitchen-role user cannot change prices through the assistant (RLS still enforced).
- [ ] Every executed command is in `operator_commands`, with its tool calls.
- [ ] Inbound SMS from an unverified number is ignored and logged.

### Phase 3 — Online storefront + special hours + reorder _(P1)_

Work: a public storefront route without a table, `special_hours` overrides, "reorder last
round" for a customer session, and holiday-aware open/closed evaluation.

Acceptance criteria:

- [ ] A date marked closed in `special_hours` refuses orders all day, overriding `menu_hours`.
- [ ] "Reorder" recreates the previous order's lines with current prices. Unavailable lines are
      dropped with a visible notice, never silently.

### Phase 4 — Analytics parity _(P2)_

Add Customers (Top Spend), keyed on the phone number from Phase 1, and order source / fulfilment
/ payment-method breakdowns.

- [ ] Totals reconcile with Stripe for a seeded test month, to the cent.

### Phase 5 — POS connector (Square first) _(P2, large)_

Implement the first connector on the existing seam (`docs/pos-integration.md`): menu import
(categories, items, modifiers, prices, images), order push from `pos_outbox`, status read-back
(to drive the "ready" SMS), and catalog webhooks for price sync. Use the Square sandbox only.

- [ ] A Square sandbox catalog imports into a **review** step, consistent with menu import's
      human-in-the-middle rule, and publishes on approval.
- [ ] A Tableside order appears in the Square sandbox and on Square KDS. Marking it complete
      there moves the Tableside order to `ready` or `served`.
- [ ] Repeating a webhook delivery is idempotent.

### Phase 6 — Delivery and marketplaces _(P3, large; needs partner access)_

Driving-distance radius (geocoder + routing API), own-driver delivery, then DoorDash Drive /
Uber Direct dispatch and marketplace order ingest. Each requires partner approval.

- [ ] An address beyond the configured driving miles is refused before payment.

### Phase 7 — URL-based menu migration _(P3)_

Add a "public ordering URL" source to the existing menu-import pipeline. It produces a draft for
human review and never auto-publishes. Respect the source site's terms and robots rules.

## Not recommended

- **Pricing as a percentage of sales collected outside the processor.** Tableside already
  collects its platform fee as a Stripe application fee. Keep that.
- **Claiming "any POS".** Ship named connectors only.
